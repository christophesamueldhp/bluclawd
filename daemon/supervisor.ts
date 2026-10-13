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

/** How a pane's wait ends: a message is queued for it; none came (time up, or its row went); or a
 *  newer wait for the same id replaced it. */
export type WaitOutcome = "queued" | "none" | "superseded";

/**
 * Agent view's registry. Every running session is a pane's pi that registers itself with a
 * heartbeat; the daemon runs no sessions. A session whose pi quit while idle stays as a stored
 * row (instances.json), resumable from its .jsonl.
 */
export class ServerSupervisor {
	private readonly externalInstances = new Map<string, ExternalInstance>();
	/** Each pane's pending wait, by id; kept apart from its entry, which every heartbeat replaces. */
	private readonly waits = new Map<string, (outcome: WaitOutcome) => void>();

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
		this.settleWait(id, "none");
	}

	/** Queue a message for a self-registered session; false when none is registered as `id`. */
	sendExternal(id: string, message: PaneMessage): boolean {
		const entry = this.externalInstances.get(id);
		if (!entry) return false;
		entry.inbox.push(message);
		this.settleWait(id, "queued");
		return true;
	}

	/**
	 * "queued" once a message is queued for a self-registered session (at once if one is), "none"
	 * after `timeoutMs` with none or when its row goes; undefined when none is registered as `id`.
	 * It drains nothing: the pane's next register does, so no message goes into a reply its pane may
	 * no longer read, and a navigation still goes alone. One per pane: a newer wait settles the older
	 * one as "superseded" (an old runtime's and its successor's overlap across a fork or reload), on
	 * which that pane waits again only after its next heartbeat, so two live panes on one id do not
	 * replace each other's waits in a loop.
	 */
	waitExternal(id: string, timeoutMs: number): Promise<WaitOutcome> | undefined {
		const entry = this.externalInstances.get(id);
		if (!entry) return undefined;
		this.settleWait(id, "superseded");
		if (entry.inbox.length > 0) return Promise.resolve("queued");
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.settleWait(id, "none"), timeoutMs);
			this.waits.set(id, (outcome) => {
				clearTimeout(timer);
				resolve(outcome);
			});
		});
	}

	/** At shutdown: every pending wait answers "none". */
	settleWaits(): void {
		for (const id of [...this.waits.keys()]) this.settleWait(id, "none");
	}

	private settleWait(id: string, outcome: WaitOutcome): void {
		const settle = this.waits.get(id);
		if (!settle) return;
		this.waits.delete(id);
		settle(outcome);
	}

	/** The messages queued for a self-registered session, now delivered. A tree, fork or clone goes
	 *  alone: what follows it is for the branch or session the pane moves to, which the next
	 *  heartbeat comes from. A move just behind a prompt would still find the pane idle and cut its
	 *  turn short, so the pane registers again after a prompt only at its next heartbeat (the turn's
	 *  start), not when woken. */
	drainExternal(id: string): PaneMessage[] {
		const entry = this.externalInstances.get(id);
		if (!entry || entry.inbox.length === 0) return [];
		const moves = entry.inbox.findIndex((m) => m.type === "tree" || m.type === "fork" || m.type === "clone");
		return entry.inbox.splice(0, moves === -1 ? entry.inbox.length : Math.max(moves, 1));
	}

	/** External instances, reaping any whose last heartbeat is older than the TTL. */
	listExternalInstances(now: number = Date.now()): Array<{ record: InstanceRecord; activity: AgentActivity }> {
		const out: Array<{ record: InstanceRecord; activity: AgentActivity }> = [];
		for (const [id, entry] of this.externalInstances) {
			if (now - entry.lastSeenAt > EXTERNAL_TTL_MS) {
				this.externalInstances.delete(id);
				this.settleWait(id, "none");
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
		if (this.externalInstances.delete(instanceId)) {
			this.settleWait(instanceId, "none");
			return true;
		}
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
