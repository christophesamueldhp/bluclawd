/**
 * Records the agent view daemon stores and exchanges.
 *
 * Self-contained: nothing here extends or depends on a pi type.
 */
export type InstanceStatus = "starting" | "online" | "stopping" | "stopped" | "error";

export interface MachineRecord {
	id: string;
	createdAt: string;
	lastSeenAt?: string;
	label?: string;
}

export interface RadiusRegistration {
	heartbeatIntervalMs: number;
	expiresInMs: number;
}

export interface InstanceRecord {
	id: string;
	status: InstanceStatus;
	cwd: string;
	createdAt: string;
	lastSeenAt?: string;
	label?: string;
	sessionId?: string;
	sessionFile?: string;
	radiusPiId?: string;
	/** Agent-view row state (daemon/session-state.ts), persisted so a row survives a restart. */
	detail?: string;
	outcome?: "done" | "failed" | "stopped";
	/** A `needs input:` line the session ended its last turn with. */
	question?: string;
	turns?: number;
	finishedAt?: string;
	pinned?: boolean;
	sortOrder?: number;
}
