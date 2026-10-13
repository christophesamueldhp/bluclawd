import { randomUUID } from "node:crypto";
import type { AgentActivity, OrchestratorClient, PaneMessage, RegisterInput } from "./orchestrator-client.ts";
import { piCommand } from "./tmux.ts";

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
	leafId?: string;
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
 * until answered, then back to whatever the run state was.
 */
export class ForegroundActivity {
	current: AgentActivity = "idle";
	private running = false;

	apply(event: { type: string; kind?: string }): AgentActivity {
		switch (event.type) {
			case "agent_start":
			case "turn_start":
				this.running = true;
				if (this.current !== "awaiting_input") this.current = "working";
				break;
			case "agent_settled":
				this.running = false;
				this.current = "idle";
				break;
			case "ui_prompt_start":
				if (event.kind && BLOCKING_PROMPT_KINDS.has(event.kind)) this.current = "awaiting_input";
				break;
			case "ui_prompt_end":
				if (event.kind && BLOCKING_PROMPT_KINDS.has(event.kind)) this.current = this.running ? "working" : "idle";
				break;
		}
		return this.current;
	}
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
	private activity: AgentActivity = "idle";
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly inflight = new Set<Promise<void>>();
	private stopped = false;
	/** The wait in flight, ended by stop(). */
	private waiting: AbortController | undefined;
	/** False once the daemon turns out to predate `wait`: heartbeats alone deliver. */
	private canWait = true;
	/** The last register delivered a tree, fork or clone: what follows it is for where the pane
	 *  moves to, so it waits for the next heartbeat, as the daemon's drain intends. */
	private moved = false;

	/** `onMessage`: another window's agent view asks this session something.
	 *  `id`: a pane registers under its tmux session's name, so its row outlives a session switch.
	 *  `getInfo` returns undefined while there is no session to list yet.
	 *  `onWatched`: after each heartbeat, whether a phone has this session open. */
	constructor(
		client: OrchestratorClient,
		getInfo: () => SelfSessionInfo | undefined,
		onMessage: (message: PaneMessage) => void = () => {},
		id: string = randomUUID(),
		onWatched: (watched: boolean) => void = () => {},
	) {
		this.client = client;
		this.getInfo = getInfo;
		this.onMessage = onMessage;
		this.onWatched = onWatched;
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
			leafId: info.leafId,
			launch: { command: piCommand() },
		};
		let watched = false;
		try {
			const res = await this.client.register(instance);
			watched = res?.watched === true;
			const messages = res?.messages ?? [];
			this.moved = messages.some((m) => m.type === "tree" || m.type === "fork" || m.type === "clone");
			if (!this.moved) this.wait();
			for (const message of messages) {
				// Stopped meanwhile: the session they were for is gone, so they wait for whatever
				// registers as this id next (the pane's next session), or go with the row. They go behind
				// anything queued since: the phone holds Send and its moves until the session has moved, so
				// little is, and navigate() skips a tree or fork to an entry the next session lacks.
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
		} catch {
			// a heartbeat must not reject: stop() awaits it and the timer fires it unawaited
		}
	}

	/**
	 * One wait at a time, from the first register that succeeds: a message queued for this pane
	 * wakes it, and the register that follows drains it at once, the same way a heartbeat does. A
	 * wait that fails waits again after the next register that succeeds.
	 */
	private wait(): void {
		if (this.waiting || !this.canWait || this.stopped || !this.timer) return;
		const waiting = new AbortController();
		this.waiting = waiting;
		const done = () => {
			if (this.waiting === waiting) this.waiting = undefined;
		};
		this.client.wait(this.id, waiting.signal).then((queued) => {
			done();
			if (queued === undefined) this.canWait = false;
			else if (this.moved) return;
			else if (queued) void this.heartbeat();
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
