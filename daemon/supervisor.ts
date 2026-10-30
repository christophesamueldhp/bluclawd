import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentActivity } from "./activity.ts";
import type { EndReason, PaneMessage } from "./ipc/protocol.ts";
import { readSessionTail } from "./session-state.ts";
import { getInstance, loadInstances, removeInstance, saveInstances, upsertInstance } from "./storage.ts";
import type { InstanceRecord } from "./types.ts";

function cloneInstance(record: InstanceRecord): InstanceRecord {
	return { ...record };
}

/** A row's agent-view meta, once it has any. */
function paneMeta({ pinned, sortOrder }: InstanceRecord): Pick<InstanceRecord, "pinned" | "sortOrder"> | undefined {
	if (pinned === undefined && sortOrder === undefined) return undefined;
	return { ...(pinned !== undefined ? { pinned } : {}), ...(sortOrder !== undefined ? { sortOrder } : {}) };
}

interface ExternalInstance {
	/** As the pane registered it: `id` is the pane's own (its tmux session's name). */
	record: InstanceRecord;
	/** The row it is listed as: its session's, which keeps its id while the session moves between
	 *  a pane and storage. The pane's id for a session first seen in it, or a file-less one. */
	rowId: string;
	activity: AgentActivity;
	lastSeenAt: number;
	/** Messages for a pane's pi, drained by its next heartbeat. */
	inbox: PaneMessage[];
	/** How many times it stopped working: a turn too quick for a poll to see still counts. */
	settled: number;
}

/** External (self-registered) instances expire this long after their last heartbeat. */
const EXTERNAL_TTL_MS = 15_000;

/** How a pane's wait ends: a message is queued for it; none came (time up, or its row went); or a
 *  newer wait for the same id replaced it. */
export type WaitOutcome = "queued" | "none" | "superseded";

/** Whether a pane's tmux session is still there. */
export interface TmuxProbe {
	hasSession(name: string): boolean;
}

export interface RegistryDeps {
	/** Milliseconds since the epoch. */
	now: () => number;
	tmux: TmuxProbe;
	/** Where instances.json lives. */
	dir: string;
}

/**
 * Agent view's registry. Every running session is a pane's pi that registers itself with a
 * heartbeat; the daemon runs no sessions. A session whose pi quit while idle stays as a stored
 * row (instances.json), resumable from its .jsonl.
 */
export class ServerSupervisor {
	private readonly deps: RegistryDeps;
	private readonly externalInstances = new Map<string, ExternalInstance>();
	/** Each pane's pending wait, by id; kept apart from its entry, which every heartbeat replaces. */
	private readonly waits = new Map<string, (outcome: WaitOutcome) => void>();
	/** Panes that unregistered without quitting (or from an older build, with no reason), by session
	 *  file: the row, pin and order for the stored row a hand-off may save next. */
	private readonly quitMeta = new Map<string, Pick<ExternalInstance, "record" | "rowId">>();
	/** The pin and order of stored rows deleted before a pane resuming them registered, by session
	 *  file, for that pane's row. */
	private readonly resumedMeta = new Map<string, Pick<InstanceRecord, "pinned" | "sortOrder">>();

	constructor(deps: RegistryDeps) {
		this.deps = deps;
	}

	/** Register/heartbeat a pane's pi. */
	registerExternal(record: InstanceRecord, activity: AgentActivity, now: number = this.deps.now()): void {
		const previous = this.externalInstances.get(record.id);
		const resumed = record.sessionFile ? this.resumedMeta.get(record.sessionFile) : undefined;
		if (record.sessionFile) this.resumedMeta.delete(record.sessionFile);
		// A pane resuming a stored session goes on as its row, which stays stored behind it.
		const stored = previous ? undefined : this.storedRowFor(record.sessionFile);
		// A heartbeat restates what the session knows; its age and agent-view meta are kept here.
		const kept = previous
			? {
					createdAt: previous.record.createdAt,
					pinned: previous.record.pinned,
					sortOrder: previous.record.sortOrder,
				}
			: stored && paneMeta(stored);
		this.externalInstances.set(record.id, {
			record: cloneInstance({ ...record, ...kept, ...resumed }),
			rowId: previous?.rowId ?? stored?.id ?? record.id,
			activity,
			lastSeenAt: now,
			inbox: previous?.inbox ?? [],
			settled: (previous?.settled ?? 0) + (previous?.activity === "working" && activity !== "working" ? 1 : 0),
		});
	}

	/** The stored row of `file`, unless a live pane already goes on as it. */
	private storedRowFor(file: string | undefined): InstanceRecord | undefined {
		if (!file) return undefined;
		const stored = loadInstances(this.deps.dir).find((instance) => instance.sessionFile === file);
		return stored && !this.paneListedAs(stored.id) ? stored : undefined;
	}

	private paneListedAs(rowId: string): [string, ExternalInstance] | undefined {
		return [...this.externalInstances].find(([, entry]) => entry.rowId === rowId);
	}

	/** The pane `id` addresses: a pane's own id, or the row a pane is listed as. */
	private paneOf(id: string): [string, ExternalInstance] | undefined {
		const own = this.externalInstances.get(id);
		return own ? [id, own] : this.paneListedAs(id);
	}

	/** The row a pane is listed as; its own id when it is not registered. */
	rowIdOf(paneId: string): string {
		return this.externalInstances.get(paneId)?.rowId ?? paneId;
	}

	/** A quit leaves its row, stopped, saved again by its hand-off once pi's writes are final. Any
	 *  other end, or none given, drops the row as before. */
	unregisterExternal(id: string, reason?: EndReason): void {
		const entry = this.externalInstances.get(id);
		const file = entry?.record.sessionFile;
		if (entry && file && reason === "quit" && existsSync(file)) {
			const { cwd, label, sessionId } = entry.record;
			this.stopRow({ cwd, label, sessionFile: file, sessionId }, [id, entry]);
			return;
		}
		if (entry && file) this.quitMeta.set(file, { record: entry.record, rowId: entry.rowId });
		this.externalInstances.delete(id);
		this.settleWait(id, "none");
	}

	/** Queue a message for a self-registered session, by its pane's id or its row's; false when no
	 *  pane is registered as either. */
	sendExternal(id: string, message: PaneMessage): boolean {
		const pane = this.paneOf(id);
		if (!pane) return false;
		pane[1].inbox.push(message);
		this.settleWait(pane[0], "queued");
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

	/** The messages queued for a self-registered session, now delivered. */
	drainExternal(id: string): PaneMessage[] {
		const entry = this.externalInstances.get(id);
		if (!entry || entry.inbox.length === 0) return [];
		return entry.inbox.splice(0);
	}

	/** External instances, each as its row, reaping any whose last heartbeat is older than the TTL. */
	listExternalInstances(
		now: number = this.deps.now(),
	): Array<{ record: InstanceRecord; activity: AgentActivity; settled: number }> {
		const out: Array<{ record: InstanceRecord; activity: AgentActivity; settled: number }> = [];
		for (const [id, entry] of this.externalInstances) {
			if (now - entry.lastSeenAt > EXTERNAL_TTL_MS) {
				this.externalInstances.delete(id);
				this.settleWait(id, "none");
				continue;
			}
			out.push({ record: { ...entry.record, id: entry.rowId }, activity: entry.activity, settled: entry.settled });
		}
		return out;
	}

	/** Rows an older daemon left running: they ended with it, and stay resumable from their .jsonl. */
	recoverAfterRestart(): void {
		const recoveredAt = new Date(this.deps.now()).toISOString();
		const instances = loadInstances(this.deps.dir).map((instance) => {
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
		saveInstances(this.deps.dir, instances);
	}

	/** Stored rows, but for those a live pane goes on as: that pane lists them. */
	listInstances(): InstanceRecord[] {
		const live = new Set([...this.externalInstances.values()].map((entry) => entry.rowId));
		return loadInstances(this.deps.dir)
			.filter((instance) => !live.has(instance.id))
			.map(cloneInstance);
	}

	getInstance(instanceId: string): InstanceRecord | undefined {
		const stored = getInstance(this.deps.dir, instanceId);
		return stored ? cloneInstance(stored) : undefined;
	}

	/**
	 * Keep a session that left its window (pi exited while it was idle) as a stopped row, with no
	 * process: it resumes from its `.jsonl` when opened or replied to. A row the daemon already has
	 * for that file is reused, so the session keeps its id, name and pin. A pane still listed on it
	 * (a quitting pane does not wait for its unregister to land) is converted in place.
	 */
	saveInstance(options: { cwd: string; label?: string; sessionFile: string; sessionId?: string }): InstanceRecord {
		const pane = [...this.externalInstances].find(([, e]) => e.record.sessionFile === options.sessionFile);
		return this.stopRow(options, pane);
	}

	private stopRow(
		options: { cwd: string; label?: string; sessionFile: string; sessionId?: string },
		pane: [string, ExternalInstance] | undefined,
	): InstanceRecord {
		const now = new Date(this.deps.now()).toISOString();
		const previous = loadInstances(this.deps.dir).find((instance) => instance.sessionFile === options.sessionFile);
		const tail = readSessionTail(options.sessionFile);
		const unregistered = this.quitMeta.get(options.sessionFile);
		this.quitMeta.delete(options.sessionFile);
		// The pane it ran in, newer than the row it may have had before: its pin, order and age.
		const ended = pane?.[1] ?? unregistered;
		// Not an unregistered pane's id that another live pane is listed as by now.
		const rowId = pane || (ended && !this.paneOf(ended.rowId)) ? ended?.rowId : undefined;
		if (pane) {
			this.externalInstances.delete(pane[0]);
			this.settleWait(pane[0], "none");
		}
		const record: InstanceRecord = {
			...previous,
			...(ended && paneMeta(ended.record)),
			id: previous?.id ?? rowId ?? randomUUID(),
			status: "stopped",
			cwd: previous?.cwd ?? options.cwd,
			createdAt: previous?.createdAt ?? ended?.record.createdAt ?? now,
			lastSeenAt: now,
			label: previous?.label ?? options.label,
			sessionId: options.sessionId ?? previous?.sessionId,
			sessionFile: options.sessionFile,
			detail: tail?.detail ?? previous?.detail,
			outcome: tail?.outcome ?? "stopped",
			turns: previous?.turns ?? tail?.turns,
			finishedAt: now,
		};
		upsertInstance(this.deps.dir, record);
		return cloneInstance(record);
	}

	/** Remove the row. The session's .jsonl stays on disk, resumable with /resume. */
	deleteInstance(instanceId: string): boolean {
		// A self-registered session's process is its pane's; its row goes until it registers again,
		// with the stored row it went on as.
		const pane = this.paneOf(instanceId);
		if (pane) {
			this.externalInstances.delete(pane[0]);
			this.settleWait(pane[0], "none");
			if (getInstance(this.deps.dir, pane[1].rowId)) removeInstance(this.deps.dir, pane[1].rowId);
			return true;
		}
		const stored = getInstance(this.deps.dir, instanceId);
		if (!stored) return false;
		// A pane resuming it keeps its pin and order: the phone's goes once its pane registered,
		// agent view's before it has.
		const meta = paneMeta(stored);
		if (stored.sessionFile && meta) {
			const pane = [...this.externalInstances.values()].find((e) => e.record.sessionFile === stored.sessionFile);
			if (pane) pane.record = { ...pane.record, ...meta };
			else this.resumedMeta.set(stored.sessionFile, meta);
		}
		removeInstance(this.deps.dir, instanceId);
		return true;
	}

	renameInstance(instanceId: string, name: string): InstanceRecord | undefined {
		return this.updateStored(instanceId, { label: name });
	}

	/** Agent-view-only fields: pin and manual order. */
	setInstanceMeta(instanceId: string, meta: { pinned?: boolean; sortOrder?: number }): InstanceRecord | undefined {
		const external = this.paneOf(instanceId)?.[1];
		if (external) {
			external.record = { ...external.record, ...meta };
			// The stored row behind it shows again if its pane dies unseen.
			this.updateStored(external.rowId, meta);
			return { ...external.record, id: external.rowId };
		}
		return this.updateStored(instanceId, meta);
	}

	private updateStored(instanceId: string, updates: Partial<InstanceRecord>): InstanceRecord | undefined {
		const stored = getInstance(this.deps.dir, instanceId);
		if (!stored) return undefined;
		const next = { ...stored, ...updates };
		upsertInstance(this.deps.dir, next);
		return next;
	}
}
