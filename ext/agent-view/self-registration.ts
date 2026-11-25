import { randomUUID } from "node:crypto";
import type { EndReason, PaneDialog, PaneHeartbeat, PaneMessage } from "../../daemon/ipc/protocol.ts";
import type { AgentActivity, OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { lastLine, textOf } from "../../daemon/session-state.ts";
import { piCommand } from "../../daemon/tmux.ts";

interface EntryLike {
	id?: string;
	type: string;
	timestamp?: string;
	message?: { role?: string; content?: unknown };
}

const LABEL_MAX = 60;

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

export function turnStartedAt(entries: EntryLike[]): string | undefined {
	return [...entries].reverse().find((e) => e.type === "message" && e.message?.role === "user")?.timestamp;
}

export interface SessionReading {
	name: string | undefined;
	firstPrompt: string | undefined;
	lastAnswer: string | undefined;
	asked: boolean;
	answered: boolean;
	lastEntry: { id: string | undefined; timestamp: string | undefined } | undefined;
	turnStartedAt: string | undefined;
}

interface SessionSource {
	getLeafId(): string | null;
	getEntries(): EntryLike[];
	getBranch(): EntryLike[];
	getSessionName(): string | undefined;
	/** pi's session manager has it, outside its read-only type; without it every read walks the entries. */
	getEntryCount?(): number;
}

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

export const BLOCKING_PROMPT_KINDS: ReadonlySet<string> = new Set(["select", "confirm", "input", "editor"]);

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

	private busy(): AgentActivity {
		return this.running || this.waitingOn > 0 ? "working" : "idle";
	}

	setWaitingOn(count: number): AgentActivity {
		this.waitingOn = count;
		if (this.current !== "awaiting_input") this.current = this.busy();
		return this.current;
	}

	get waitingFor(): number {
		return this.running ? 0 : this.waitingOn;
	}
}

export function waitingDetail(activity: ForegroundActivity): string | undefined {
	const n = activity.waitingFor;
	if (n === 0) return undefined;
	return `Waiting for ${n} subagent${n === 1 ? "" : "s"}`;
}

export function dialogDetail(activity: ForegroundActivity): string | undefined {
	return activity.current === "awaiting_input" && activity.dialog?.title
		? `Waiting: ${activity.dialog.title}`
		: undefined;
}

export const HEARTBEAT_MS = 3000;

export class SelfRegistration {
	readonly id: string;
	private readonly client: OrchestratorClient;
	private readonly getInfo: () => PaneHeartbeat | undefined;
	private readonly onMessage: (message: PaneMessage) => void;
	private readonly onWatched: (watched: boolean) => void;
	private readonly onWantReport: () => void;
	private readonly onReconnect: () => void;
	private unreached = false;
	private activity: AgentActivity = "idle";
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly inflight = new Set<Promise<void>>();
	private stopped = false;
	private waiting: AbortController | undefined;
	private awaitingTurnStart = false;
	private listed = false;

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

	ensureListed(): void {
		if (!this.listed) void this.heartbeat();
	}

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
			this.awaitingTurnStart = messages.some((m) => m.type === "prompt" || m.type === "command");
			if (!this.awaitingTurnStart) this.wait();
			for (const message of messages) {
				if (this.stopped) await this.client.send(this.id, message);
				else this.onMessage(message);
			}
		} catch {
			this.unreached = true;
		}
		// Stopped meanwhile, so pi may have invalidated the extension API the callback uses.
		if (this.stopped) return;
		this.reportWithoutRejecting(watched, wantReport, reconnected);
	}

	private reportWithoutRejecting(watched: boolean, wantReport: boolean, reconnected: boolean): void {
		try {
			this.onWatched(watched);
			if (wantReport) this.onWantReport();
			if (reconnected) this.onReconnect();
		} catch {}
	}

	private wait(): void {
		if (this.waiting || this.stopped || !this.timer) return;
		const waiting = new AbortController();
		this.waiting = waiting;
		const done = () => {
			if (this.waiting === waiting) this.waiting = undefined;
		};
		this.client.wait(this.id, waiting.signal).then((queued) => {
			done();
			if (queued === undefined || this.awaitingTurnStart) return;
			if (queued) void this.heartbeat();
			else this.wait();
		}, done);
	}

	async stop(options: { unregister?: boolean; reason?: EndReason } = {}): Promise<void> {
		this.stopped = true;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.waiting?.abort();
		await Promise.allSettled([...this.inflight]);
		if (options.unregister === false) return;
		await this.unregisterIfReachable(options.reason);
	}

	private async unregisterIfReachable(reason: EndReason | undefined): Promise<void> {
		try {
			await this.client.unregister(this.id, reason);
		} catch {}
	}
}
