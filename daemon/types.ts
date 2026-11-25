import type { PaneHeartbeat } from "./ipc/protocol.ts";

export type InstanceStatus = "starting" | "online" | "stopping" | "stopped" | "error";

export interface InstanceRecord extends PaneHeartbeat {
	id: string;
	status: InstanceStatus;
	createdAt: string;
	lastSeenAt?: string;
	paneLabel?: string;
	outcome?: "done" | "failed" | "stopped";
	pinned?: boolean;
	sortOrder?: number;
}

const LIVE_ONLY_KEYS = ["pane", "leafId", "dialog", "draft", "wakesAt", "turnStartedAt"] as const;

export type StoredRow = Omit<InstanceRecord, (typeof LIVE_ONLY_KEYS)[number]>;

export function storedRow(record: StoredRow): StoredRow {
	const row: Partial<Record<keyof InstanceRecord, unknown>> = { ...record };
	for (const key of LIVE_ONLY_KEYS) delete row[key];
	return row as StoredRow;
}

export const isRun = (record: { parent?: string }): boolean => Boolean(record.parent);
