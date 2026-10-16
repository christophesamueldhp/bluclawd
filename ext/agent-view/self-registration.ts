import { randomUUID } from "node:crypto";
import type {
	AgentActivity,
	OrchestratorClient,
	PaneDialog,
	PaneMessage,
	RegisterInput,
} from "../../daemon/orchestrator-client.ts";
import { piCommand } from "../../daemon/tmux.ts";

export interface SelfSessionInfo {
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	label?: string;
	/** Pane mode: the tmux session this pi runs in, and what its row shows. */
	pane?: string;
	detail?: string;
	turns?: number;
	createdAt?: string;
	finishedAt?: string;
	leafId?: string;
	dialog?: PaneDialog;
	/** Its prompt holds unsent text: the phone's slash commands wait for it to be sent or cleared. */
	draft?: boolean;
}

/** The subset of a session entry needed to derive a title — structural, so pi's SessionEntry fits. */
interface EntryLike {
	type: string;
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

/** Blocking prompt kinds, as the daemon's activity reducer sees them: a `custom` overlay
 *  (agent view itself, /diff, …) is a view, not a question waiting on the user. */
const BLOCKING_PROMPT_KINDS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

/**
 * Derives the foreground session's activity from pi's extension events, mirroring what the
 * daemon derives for its children from their RPC stream (daemon/activity.ts): a run is
 * "working" from agent_start until agent_settled; a blocking UI prompt is "awaiting_input"
 * until answered, then back to whatever the run state was. `dialog`: the prompt waited on.
 */
export class ForegroundActivity {
	current: AgentActivity = "idle";
	dialog: PaneDialog | undefined;
	private running = false;

	apply(event: { type: string; kind?: string; title?: string }): AgentActivity {
		switch (event.type) {
			case "agent_start":
			case "turn_start":
				this.running = true;
				if (this.current !== "awaiting_input") this.current = "working";
				break;
			case "agent_settled":
				this.running = false;
				this.current = "idle";
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
					this.current = this.running ? "working" : "idle";
					this.dialog = undefined;
				}
				break;
		}
		return this.current;
	}
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
const HEARTBEAT_MS = 3000;

/**
 * Registers the foreground interactive session with the orchestrator daemon as an
 * external instance and heartbeats it, so it appears in every agent view. Best-effort:
 * if the daemon is down a heartbeat silently no-ops and re-registers once one exists.
 */
export class SelfRegistration {
	readonly id: string;
	private readonly client: OrchestratorClient;
	private readonly getInfo: () => SelfSessionInfo | undefined;
	private readonly onMessage: (message: PaneMessage) => void;
	private readonly onWatched: (watched: boolean) => void;
	private readonly onWantReport: () => void;
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
	 *  `onWantReport`: the daemon has no report from this pane, as after it restarted. */
	constructor(
		client: OrchestratorClient,
		getInfo: () => SelfSessionInfo | undefined,
		onMessage: (message: PaneMessage) => void = () => {},
		id: string = randomUUID(),
		onWatched: (watched: boolean) => void = () => {},
		onWantReport: () => void = () => {},
	) {
		this.client = client;
		this.getInfo = getInfo;
		this.onMessage = onMessage;
		this.onWatched = onWatched;
		this.onWantReport = onWantReport;
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
		const instance: RegisterInput = {
			id: this.id,
			cwd: info.cwd,
			sessionId: info.sessionId,
			sessionFile: info.sessionFile,
			label: info.label,
			activity: this.activity,
			pane: info.pane,
			detail: info.detail,
			turns: info.turns,
			createdAt: info.createdAt,
			finishedAt: info.finishedAt,
			leafId: info.leafId,
			dialog: info.dialog,
			...(info.draft ? { draft: true } : {}),
			launch: { command: piCommand() },
		};
		let watched = false;
		let wantReport = false;
		try {
			const res = await this.client.register(instance);
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
		}
		// Stopped meanwhile: pi may have invalidated the extension API the callback uses.
		if (this.stopped) return;
		try {
			this.onWatched(watched);
			if (wantReport) this.onWantReport();
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

	/** `unregister: false`: the pane's next session carries on its row, under the same id. */
	async stop(options: { unregister?: boolean } = {}): Promise<void> {
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
			await this.client.unregister(this.id);
		} catch {
			// ignore
		}
	}
}
