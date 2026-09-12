import { randomUUID } from "node:crypto";
import type { AgentActivity } from "./fleet-status.ts";
import type { OrchestratorClient, RegisterInput } from "./orchestrator-client.ts";

export interface SelfSessionInfo {
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	label?: string;
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
 *  (FleetView itself, /diff, …) is a view, not a question waiting on the user. */
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
 * 3000ms, not 5000ms. The daemon reaps an external registration after 15s
 * (`EXTERNAL_TTL_MS`, packages/server/src/supervisor.ts) — at the old 5000ms interval, exactly
 * 3 consecutive missed heartbeats (each a `register()` call that times out at 1000ms under
 * load) landed precisely ON that boundary with zero margin: a poll from ANY other FleetView
 * arriving microseconds later would reap the row (IMPROVEMENT-PLAN.md §5.2). At 3000ms, 4
 * consecutive misses (12s) are still safely inside the TTL — reaping now needs a 5th
 * consecutive failure, and the boundary no longer sits on an exact multiple of the interval.
 * Chosen over widening the daemon's own TTL because a TTL change only takes effect after every
 * running daemon restarts; this is client-side and applies to the very next heartbeat.
 */
const HEARTBEAT_MS = 3000;

/**
 * Registers the foreground interactive session with the orchestrator daemon as an
 * external instance and heartbeats it, so it appears in every FleetView. Best-effort:
 * if the daemon is down a heartbeat silently no-ops and re-registers once one exists.
 */
export class FleetSelfRegistration {
	readonly id = randomUUID();
	private readonly client: OrchestratorClient;
	private readonly getInfo: () => SelfSessionInfo;
	private activity: AgentActivity = "idle";
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(client: OrchestratorClient, getInfo: () => SelfSessionInfo) {
		this.client = client;
		this.getInfo = getInfo;
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

	private async heartbeat(): Promise<void> {
		const info = this.getInfo();
		const instance: RegisterInput = {
			id: this.id,
			cwd: info.cwd,
			sessionId: info.sessionId,
			sessionFile: info.sessionFile,
			label: info.label,
			activity: this.activity,
		};
		try {
			await this.client.register(instance);
		} catch {
			// daemon may be down; the next tick retries (register is an upsert).
		}
	}

	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		try {
			await this.client.unregister(this.id);
		} catch {
			// ignore
		}
	}
}
