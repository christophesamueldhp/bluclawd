import { randomUUID } from "node:crypto";
import type { AgentActivity } from "./fleet-status.ts";
import type { OrchestratorClient, RegisterInput } from "./orchestrator-client.ts";

export interface SelfSessionInfo {
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	label?: string;
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
