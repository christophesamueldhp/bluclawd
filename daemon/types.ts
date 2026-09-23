/**
 * Records the agent view daemon stores and exchanges.
 *
 * These lived in pi's `packages/server/src/types.ts` on the fork branch, added
 * there because the daemon modules did. They are self-contained — nothing here
 * extends or depends on a pi type — so they move wholesale rather than needing
 * pi to declare anything on bluclawd's behalf.
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
