import { randomUUID } from "node:crypto";
import type { AgentActivity } from "./activity.ts";
import type { PaneMessage } from "./ipc/protocol.ts";
import { readSessionTail } from "./session-state.ts";
import { getInstance, loadInstances, removeInstance, saveInstances, upsertInstance } from "./storage.ts";
import type { InstanceRecord } from "./types.ts";

function cloneInstance(record: InstanceRecord): InstanceRecord {
	return { ...record };
}

interface ExternalInstance {
	record: InstanceRecord;
	activity: AgentActivity;
	lastSeenAt: number;
	/** Messages for a pane's pi, drained by its next heartbeat. */
	inbox: PaneMessage[];
}

/** External (self-registered) instances expire this long after their last heartbeat. */
const EXTERNAL_TTL_MS = 15_000;

/**
 * Agent view's registry. Every running session is a pane's pi that registers itself with a
 * heartbeat; the daemon runs no sessions. A session whose pi quit while idle stays as a stored
 * row (instances.json), resumable from its .jsonl.
 */
export class ServerSupervisor {
	private readonly externalInstances = new Map<string, ExternalInstance>();

	/** Register/heartbeat a pane's pi. */
	registerExternal(record: InstanceRecord, activity: AgentActivity, now: number = Date.now()): void {
		const previous = this.externalInstances.get(record.id);
		// A heartbeat restates what the session knows; its age and agent-view meta are kept here.
		const kept = previous
			? {
					createdAt: previous.record.createdAt,
					pinned: previous.record.pinned,
					sortOrder: previous.record.sortOrder,
				}
			: {};
		this.externalInstances.set(record.id, {
			record: cloneInstance({ ...record, ...kept }),
			activity,
			lastSeenAt: now,
			inbox: previous?.inbox ?? [],
		});
	}

	unregisterExternal(id: string): void {
		this.externalInstances.delete(id);
	}

	/** Queue a message for a self-registered session; false when none is registered as `id`. */
	sendExternal(id: string, message: PaneMessage): boolean {
		const entry = this.externalInstances.get(id);
		if (!entry) return false;
		entry.inbox.push(message);
		return true;
	}

	/** The messages queued for a self-registered session, now delivered. */
	drainExternal(id: string): PaneMessage[] {
		const entry = this.externalInstances.get(id);
		if (!entry || entry.inbox.length === 0) return [];
		const messages = entry.inbox;
		entry.inbox = [];
		return messages;
	}

	/** External instances, reaping any whose last heartbeat is older than the TTL. */
	listExternalInstances(now: number = Date.now()): Array<{ record: InstanceRecord; activity: AgentActivity }> {
		const out: Array<{ record: InstanceRecord; activity: AgentActivity }> = [];
		for (const [id, entry] of this.externalInstances) {
			if (now - entry.lastSeenAt > EXTERNAL_TTL_MS) {
				this.externalInstances.delete(id);
				continue;
			}
			out.push({ record: cloneInstance(entry.record), activity: entry.activity });
		}
		return out;
	}

	/** Rows an older daemon left running: they ended with it, and stay resumable from their .jsonl. */
	recoverAfterRestart(): void {
		const recoveredAt = new Date().toISOString();
		const instances = loadInstances().map((instance) => {
			if (instance.status !== "online" && instance.status !== "starting" && instance.status !== "stopping") {
				return instance;
			}
			return {
				...instance,
				status: "stopped" as const,
				outcome: instance.outcome ?? "stopped",
				lastSeenAt: recoveredAt,
			};
		});
		saveInstances(instances);
	}

	listInstances(): InstanceRecord[] {
		return loadInstances().map(cloneInstance);
	}

	getInstance(instanceId: string): InstanceRecord | undefined {
		const stored = getInstance(instanceId);
		return stored ? cloneInstance(stored) : undefined;
	}

	/**
	 * Keep a session that left its window (pi exited while it was idle) as a stopped row, with no
	 * process: it resumes from its `.jsonl` when opened or replied to. A row the daemon already has
	 * for that file is reused, so the session keeps its id, name and pin.
	 */
	saveInstance(options: { cwd: string; label?: string; sessionFile: string }): InstanceRecord {
		const now = new Date().toISOString();
		const previous = loadInstances().find((instance) => instance.sessionFile === options.sessionFile);
		const tail = readSessionTail(options.sessionFile);
		const record: InstanceRecord = {
			...previous,
			id: previous?.id ?? randomUUID(),
			status: "stopped",
			cwd: previous?.cwd ?? options.cwd,
			createdAt: previous?.createdAt ?? now,
			lastSeenAt: now,
			label: previous?.label ?? options.label,
			sessionFile: options.sessionFile,
			detail: tail?.detail ?? previous?.detail,
			outcome: tail?.outcome ?? "stopped",
			turns: previous?.turns ?? tail?.turns,
			finishedAt: now,
		};
		upsertInstance(record);
		return cloneInstance(record);
	}

	/** Remove the row. The session's .jsonl stays on disk, resumable with /resume. */
	deleteInstance(instanceId: string): boolean {
		// A self-registered session's process is its pane's; its row goes until it registers again.
		if (this.externalInstances.delete(instanceId)) return true;
		if (!getInstance(instanceId)) return false;
		removeInstance(instanceId);
		return true;
	}

	renameInstance(instanceId: string, name: string): InstanceRecord | undefined {
		return this.updateStored(instanceId, { label: name });
	}

	/** Agent-view-only fields: pin and manual order. */
	setInstanceMeta(instanceId: string, meta: { pinned?: boolean; sortOrder?: number }): InstanceRecord | undefined {
		const external = this.externalInstances.get(instanceId);
		if (external) {
			external.record = { ...external.record, ...meta };
			return cloneInstance(external.record);
		}
		return this.updateStored(instanceId, meta);
	}

	private updateStored(instanceId: string, updates: Partial<InstanceRecord>): InstanceRecord | undefined {
		const stored = getInstance(instanceId);
		if (!stored) return undefined;
		const next = { ...stored, ...updates };
		upsertInstance(next);
		return next;
	}
}

export const supervisor = new ServerSupervisor();
