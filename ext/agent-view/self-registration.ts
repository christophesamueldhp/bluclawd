import { randomUUID } from "node:crypto";
import type { EndReason, PaneDialog, PaneHeartbeat, PaneMessage } from "../../daemon/ipc/protocol.ts";
import type { AgentActivity, OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { lastLine, textOf } from "../../daemon/session-state.ts";
import { piCommand } from "../../daemon/tmux.ts";

/** The subset of a session entry a heartbeat reads — structural, so pi's SessionEntry fits. */
interface EntryLike {
	id?: string;
	type: string;
	timestamp?: string;
	message?: { role?: string; content?: unknown };
}

const LABEL_MAX = 60;

/**
 * Roster title for the foreground session: its name, else the first line of the first user
 * message (the same fallback saved rows get from pi's session index), else undefined so the
 * roster falls back to the 8-character id.
 */
export function deriveLabel(name: string | undefined, entries: EntryLike[]): string | undefined {
	if (name?.trim()) return name;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter(
								(b): b is { type: string; text: string } => b?.type === "text" && typeof b.text === "string",
							)
							.map((b) => b.text)
							.join(" ")
					: "";
		const firstLine = text.trim().split("\n")[0].trim();
		if (firstLine) return firstLine.slice(0, LABEL_MAX);
	}
	return undefined;
}

/** When the session's latest prompt was written: while it works, when its turn began, as a Chat
 *  times it. A prompt pi takes from its queue mid-run is written then, and starts the time again. */
export function turnStartedAt(entries: EntryLike[]): string | undefined {
	return [...entries].reverse().find((e) => e.type === "message" && e.message?.role === "user")?.timestamp;
}

/** What a heartbeat reads off its session's entries. */
export interface SessionReading {
	name: string | undefined;
	/** The first prompt's first line, as `deriveLabel` gives it. */
	firstPrompt: string | undefined;
	/** The last line of the last answer, on any branch. */
	lastAnswer: string | undefined;
	/** A message is in the session: something has been asked. */
	asked: boolean;
	/** An answer is in the session. */
	answered: boolean;
	lastEntry: { id: string | undefined; timestamp: string | undefined } | undefined;
	turnStartedAt: string | undefined;
}

/** The part of pi's session manager a reading needs. */
interface SessionSource {
	getLeafId(): string | null;
	getEntries(): EntryLike[];
	getBranch(): EntryLike[];
	getSessionName(): string | undefined;
	/** pi's session manager has it, outside its read-only type; without it every read walks the entries. */
	getEntryCount?(): number;
}

/**
 * A session's reading, walked again only once the session has changed: its entries are only ever
 * appended, so the same manager, leaf and entry count read the same.
 */
export class SessionDigest {
	private last: { source: SessionSource; leafId: string | null; count: number; reading: SessionReading } | undefined;

	read(source: SessionSource): SessionReading {
		const count = source.getEntryCount?.();
		const leafId = source.getLeafId();
		const last = this.last;
		if (last?.source === source && last.leafId === leafId && last.count === count) return last.reading;
		const reading = readSession(source);
		this.last = count === undefined ? undefined : { source, leafId, count, reading };
		return reading;
	}
}

function readSession(source: SessionSource): SessionReading {
	const entries = source.getEntries();
	const messages = entries.filter((e) => e.type === "message");
	const lastAssistant = [...messages].reverse().find((e) => e.message?.role === "assistant");
	const last = entries.at(-1);
	return {
		name: source.getSessionName(),
		firstPrompt: deriveLabel(undefined, entries),
		lastAnswer: lastAssistant ? lastLine(textOf(lastAssistant.message?.content)) : undefined,
		asked: messages.length > 0,
		answered: messages.some((e) => e.message?.role === "assistant"),
		lastEntry: last && { id: last.id, timestamp: last.timestamp },
		turnStartedAt: turnStartedAt(source.getBranch()),
	};
}

/** Blocking prompt kinds: a `custom` overlay (agent view itself, /diff, …) is a view, not a
 *  question waiting on the user. */
export const BLOCKING_PROMPT_KINDS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

/**
 * Derives the foreground session's activity (daemon/activity.ts), which its heartbeat reports,
 * from pi's extension events: a run is "working" from agent_start until agent_settled; a blocking
 * UI prompt is "awaiting_input" until answered, then back to whatever the run state was.
 * Waiting on its background subagent runs (`setWaitingOn`) counts as working too.
 * `dialog`: the prompt waited on.
 */
export class ForegroundActivity {
	current: AgentActivity = "idle";
	dialog: PaneDialog | undefined;
	private running = false;
	private waitingOn = 0;

	apply(event: { type: string; kind?: string; title?: string }): AgentActivity {
		switch (event.type) {
			case "agent_start":
			case "turn_start":
				this.running = true;
				if (this.current !== "awaiting_input") this.current = "working";
				break;
			case "agent_settled":
				this.running = false;
				this.current = this.busy();
				this.dialog = undefined;
				break;
			case "ui_prompt_start":
				if (event.kind && BLOCKING_PROMPT_KINDS.has(event.kind)) {
					this.current = "awaiting_input";
					this.dialog = { kind: event.kind, ...(event.title?.trim() ? { title: event.title.trim() } : {}) };
				}
				break;
			case "ui_prompt_end":
				if (event.kind && BLOCKING_PROMPT_KINDS.has(event.kind)) {
					this.current = this.busy();
					this.dialog = undefined;
				}
				break;
		}
		return this.current;
	}

	/** Not waiting on a prompt: working while a turn runs or its subagents do. */
	private busy(): AgentActivity {
		return this.running || this.waitingOn > 0 ? "working" : "idle";
	}

	/** How many background subagent runs are still going. */
	setWaitingOn(count: number): AgentActivity {
		this.waitingOn = count;
		if (this.current !== "awaiting_input") this.current = this.busy();
		return this.current;
	}

	/** The background subagent runs it waits on between turns: none while a turn runs. */
	get waitingFor(): number {
		return this.running ? 0 : this.waitingOn;
	}
}

/** A row's line while the session waits on its background subagents. */
export function waitingDetail(activity: ForegroundActivity): string | undefined {
	const n = activity.waitingFor;
	if (n === 0) return undefined;
	return `Waiting for ${n} subagent${n === 1 ? "" : "s"}`;
}

/** A row's line while it waits on a dialog with a title. */
export function dialogDetail(activity: ForegroundActivity): string | undefined {
	return activity.current === "awaiting_input" && activity.dialog?.title
		? `Waiting: ${activity.dialog.title}`
		: undefined;
}

/**
 * The daemon reaps an external registration after 15s (`EXTERNAL_TTL_MS`); at 3s, four missed
 * heartbeats (each a `register()` that can time out at 1s under load) still land inside the TTL.
 * Tuned here rather than in the daemon, where a TTL change only applies once every running daemon
 * restarts.
 */
export const HEARTBEAT_MS = 3000;

/**
 * Registers the foreground interactive session with the orchestrator daemon as an
 * external instance and heartbeats it, so it appears in every agent view. Best-effort:
 * if the daemon is down a heartbeat silently no-ops and re-registers once one exists.
 */
export class SelfRegistration {
	readonly id: string;
	private readonly client: OrchestratorClient;
	private readonly getInfo: () => PaneHeartbeat | undefined;
	private readonly onMessage: (message: PaneMessage) => void;
	private readonly onWatched: (watched: boolean) => void;
	private readonly onWantReport: () => void;
	private readonly onReconnect: () => void;
	/** The last register failed: the daemon was down, or did not answer. */
	private unreached = false;
	private activity: AgentActivity = "idle";
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly inflight = new Set<Promise<void>>();
	private stopped = false;
	/** The wait in flight, ended by stop(). */
	private waiting: AbortController | undefined;
	/** The last register delivered a prompt or a slash command: pi still reports the pane idle until
	 *  its turn starts, so what follows waits for the turn's agent_start heartbeat, which takes it. */
	private moved = false;
	/** A heartbeat has listed this session: before its first prompt is in the session there is nothing to list. */
	private listed = false;

	/** `onMessage`: another window's agent view asks this session something.
	 *  `id`: a pane registers under its tmux session's name, so its row outlives a session switch.
	 *  `getInfo` returns undefined while there is no session to list yet.
	 *  `onWatched`: after each heartbeat, whether a phone has this session open.
	 *  `onWantReport`: the daemon has no report from this pane, as after it restarted.
	 *  `onReconnect`: a register went through after one that did not. */
	constructor(
		client: OrchestratorClient,
		getInfo: () => PaneHeartbeat | undefined,
		onMessage: (message: PaneMessage) => void = () => {},
		id: string = randomUUID(),
		onWatched: (watched: boolean) => void = () => {},
		onWantReport: () => void = () => {},
		onReconnect: () => void = () => {},
	) {
		this.client = client;
		this.getInfo = getInfo;
		this.onMessage = onMessage;
		this.onWatched = onWatched;
		this.onWantReport = onWantReport;
		this.onReconnect = onReconnect;
		this.id = id;
	}

	start(): void {
		if (this.timer) return;
		void this.heartbeat();
		this.timer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS);
	}

	setActivity(activity: AgentActivity): void {
		if (this.activity === activity) return;
		this.activity = activity;
		void this.heartbeat();
	}

	/** List the session now if no heartbeat has: a new session's first turn starts before its prompt is
	 *  in the session, so that turn's working heartbeat had nothing to list, and a turn quicker than the
	 *  next heartbeat would never be seen working. */
	ensureListed(): void {
		if (!this.listed) void this.heartbeat();
	}

	/** Force an immediate re-registration — e.g. right after switching the foreground session,
	 *  so the newly-opened session appears at once instead of waiting for the next heartbeat. */
	async refresh(): Promise<void> {
		await this.heartbeat();
	}

	private heartbeat(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		const beat = this.beat();
		this.inflight.add(beat);
		const done = () => this.inflight.delete(beat);
		beat.then(done, done);
		return beat;
	}

	private async beat(): Promise<void> {
		const info = this.getInfo();
		if (!info) return;
		this.listed = true;
		const instance = { ...info, id: this.id, activity: this.activity, launch: { command: piCommand() } };
		let watched = false;
		let wantReport = false;
		let reconnected = false;
		try {
			const res = await this.client.register(instance);
			reconnected = this.unreached;
			this.unreached = false;
			watched = res?.watched === true;
			wantReport = res?.wantReport === true;
			const messages = res?.messages ?? [];
			this.moved = messages.some((m) => m.type === "prompt" || m.type === "command");
			if (!this.moved) this.wait();
			for (const message of messages) {
				// Stopped meanwhile: the session they were for is gone, so they wait for whatever
				// registers as this id next (the pane's next session), or go with the row, behind
				// anything queued since.
				if (this.stopped) await this.client.send(this.id, message);
				else this.onMessage(message);
			}
		} catch {
			// daemon may be down; the next tick retries (register is an upsert).
			this.unreached = true;
		}
		// Stopped meanwhile: pi may have invalidated the extension API the callback uses.
		if (this.stopped) return;
		try {
			this.onWatched(watched);
			if (wantReport) this.onWantReport();
			if (reconnected) this.onReconnect();
		} catch {
			// a heartbeat must not reject: stop() awaits it and the timer fires it unawaited
		}
	}

	/**
	 * One wait at a time, from the first register that succeeds: a message queued for this pane
	 * wakes it, and the register that follows drains it at once, the same way a heartbeat does. A
	 * wait that fails, that a newer wait for this id replaced (another live pane under the same id),
	 * or that a daemon from before `wait` answers, waits again after the next register that
	 * succeeds: heartbeats deliver meanwhile, and a restarted daemon is waited on.
	 */
	private wait(): void {
		if (this.waiting || this.stopped || !this.timer) return;
		const waiting = new AbortController();
		this.waiting = waiting;
		const done = () => {
			if (this.waiting === waiting) this.waiting = undefined;
		};
		this.client.wait(this.id, waiting.signal).then((queued) => {
			done();
			if (queued === undefined || this.moved) return;
			if (queued) void this.heartbeat();
			else this.wait();
		}, done);
	}

	/** `unregister: false`: the pane's next session carries on its row, under the same id.
	 *  `reason`: why the session ended; a quit keeps its row, stopped. */
	async stop(options: { unregister?: boolean; reason?: EndReason } = {}): Promise<void> {
		this.stopped = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		// A wait carries no messages, so ending it loses none.
		this.waiting?.abort();
		// A register still on its way would list the session again after the unregister, or land
		// after the next session's first one. A failed heartbeat must not skip the unregister.
		await Promise.allSettled([...this.inflight]);
		if (options.unregister === false) return;
		try {
			await this.client.unregister(this.id, options.reason);
		} catch {
			// ignore
		}
	}
}
