/**
 * Records the agent view daemon stores and exchanges.
 *
 * Self-contained: nothing here extends or depends on a pi type.
 */
import type { PaneHeartbeat } from "./ipc/protocol.ts";

export type InstanceStatus = "starting" | "online" | "stopping" | "stopped" | "error";

/** A row: its pane's last heartbeat, or what storage keeps of it (its leaf, dialog and draft are
 *  never stored), and what the daemon adds. */
export interface InstanceRecord extends PaneHeartbeat {
	id: string;
	status: InstanceStatus;
	createdAt: string;
	lastSeenAt?: string;
	/** The name its pane last gave it. A pane's name replaces the row's only once it changes, so a
	 *  name given to the stopped row survives a resume. */
	paneLabel?: string;
	outcome?: "done" | "failed" | "stopped";
	pinned?: boolean;
	sortOrder?: number;
}
