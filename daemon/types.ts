/**
 * Records the agent view daemon stores and exchanges.
 *
 * Self-contained: nothing here extends or depends on a pi type.
 */
export type InstanceStatus = "starting" | "online" | "stopping" | "stopped" | "error";

export interface InstanceRecord {
	id: string;
	status: InstanceStatus;
	cwd: string;
	createdAt: string;
	lastSeenAt?: string;
	label?: string;
	sessionId?: string;
	sessionFile?: string;
	/** Agent-view row state (daemon/session-state.ts), persisted so a row survives a restart. */
	detail?: string;
	outcome?: "done" | "failed" | "stopped";
	turns?: number;
	finishedAt?: string;
	pinned?: boolean;
	sortOrder?: number;
	/** The tmux session an interactive pi runs this session in (agent view's pane mode). */
	pane?: string;
}
