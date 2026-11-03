import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentActivity } from "./activity.ts";
import type { EndReason, NewPaneSpec, PaneMessage, ResumeSpec } from "./ipc/protocol.ts";
import { readSessionTail } from "./session-state.ts";
import { getInstance, loadInstances, removeInstance, saveInstances, upsertInstance } from "./storage.ts";
import type { InstanceRecord } from "./types.ts";

function cloneInstance(record: InstanceRecord): InstanceRecord {
	return { ...record };
}

/** The name a row keeps: its own, unless its pane's changed since the row last heard it. */
function nameOf(row: InstanceRecord | undefined, paneLabel: string | undefined): string | undefined {
	const keeps = row?.label !== undefined && (row.paneLabel === undefined || row.paneLabel === paneLabel);
	return keeps ? row?.label : (paneLabel ?? row?.label);
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
	/** Its row as last stored, so a heartbeat that changes none of it writes nothing. */
	persisted?: string;
}

/** External (self-registered) instances expire this long after their last heartbeat. */
const EXTERNAL_TTL_MS = 15_000;

/** How long a row a start claimed is listed as starting: no pane registers later than this (the
 *  phone's are ended then, see remote/control.ts), so a resume is refused no longer. */
export const START_MS = 90_000;

/** A pane being started on a row: refused while one is starting or live on its session file. */
export type StartClaim = { ok: true; id: string } | { ok: false; refused: "starting" | "running" };

/** A row listed as starting: its record, and when it stops being listed so. */
interface Starting {
	record: InstanceRecord;
	until: number;
}

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
	/** Rows a quit stopped whose hand-off save is still to come, by session file: whether the row
	 *  was deleted meanwhile, so that save does not bring it back. */
	private readonly savesDue = new Map<string, { deleted: boolean }>();
	/** The pin and order of stored rows deleted before a pane resuming them registered, by session
	 *  file, for that pane's row. */
	private readonly resumedMeta = new Map<string, Pick<InstanceRecord, "pinned" | "sortOrder">>();
	/** Rows a start claimed whose pane has not registered yet, by row id. */
	private readonly startingRows = new Map<string, Starting>();
	/** A pane went, reaped or unregistered, listed as `rowId` and with `inbox` still queued for it.
	 *  `reason`: why its session ended, when it unregistered saying so. */
	onDropped: ((rowId: string, inbox: PaneMessage[], reason?: EndReason) => void) | undefined;

	constructor(deps: RegistryDeps) {
		this.deps = deps;
	}

	/** Register/heartbeat a pane's pi. */
	registerExternal(record: InstanceRecord, activity: AgentActivity, now: number = this.deps.now()): void {
		const previous = this.externalInstances.get(record.id);
		const resumed = record.sessionFile ? this.resumedMeta.get(record.sessionFile) : undefined;
		if (record.sessionFile) {
			this.resumedMeta.delete(record.sessionFile);
			this.savesDue.delete(record.sessionFile);
		}
		// A pane resuming a stored session goes on as its row, which stays stored behind it.
		const stored = previous ? undefined : this.storedRowFor(record.sessionFile);
		const started = this.takeStarting(record);
		const claimed = previous ? undefined : started;
		// A heartbeat restates what the session knows; its age and agent-view meta are kept here.
		const kept = previous
			? {
					createdAt: previous.record.createdAt,
					pinned: previous.record.pinned,
					sortOrder: previous.record.sortOrder,
				}
			: stored && paneMeta(stored);
		const label = nameOf(previous?.record ?? stored, record.label);
		const entry: ExternalInstance = {
			record: cloneInstance({ ...record, ...kept, ...resumed, label, paneLabel: record.label }),
			// A pane that went on to another session leaves the row stored under its id to that one.
			rowId:
				previous?.rowId ??
				stored?.id ??
				claimed?.id ??
				(getInstance(this.deps.dir, record.id) ? randomUUID() : record.id),
			activity,
			lastSeenAt: now,
			inbox: previous?.inbox ?? [],
			settled: (previous?.settled ?? 0) + (previous?.activity === "working" && activity !== "working" ? 1 : 0),
			persisted: previous?.persisted,
		};
		this.externalInstances.set(record.id, entry);
		this.persistRow(entry);
	}

	/** Store a pane's row as it shows without its pane, stopped, once its session has a file to resume
	 *  from: its pin, order, name and age survive a daemon restart, and its pane's next heartbeat goes
	 *  on as it. */
	private persistRow(entry: ExternalInstance): void {
		const { cwd, createdAt, label, paneLabel, sessionId, sessionFile, pinned, sortOrder } = entry.record;
		const row = {
			id: entry.rowId,
			status: "stopped" as const,
			outcome: "stopped" as const,
			cwd,
			createdAt,
			label,
			paneLabel,
			sessionId,
			sessionFile,
		};
		const persisted = JSON.stringify({ ...row, pinned, sortOrder });
		if (persisted === entry.persisted || !sessionFile || !existsSync(sessionFile)) return;
		upsertInstance(this.deps.dir, { ...getInstance(this.deps.dir, entry.rowId), ...row, pinned, sortOrder });
		entry.persisted = persisted;
	}

	/** A pane registering as `record` ends the start of its session file's row, or of its own id's,
	 *  which it goes on as. */
	private takeStarting(record: InstanceRecord): InstanceRecord | undefined {
		let taken: InstanceRecord | undefined;
		for (const [id, starting] of this.startingRows) {
			if (id === record.id || (record.sessionFile && starting.record.sessionFile === record.sessionFile)) {
				this.startingRows.delete(id);
				taken ??= starting.record;
			}
		}
		return taken;
	}

	/** Rows listed as starting, but for those whose pane will not register: its time is up, or a
	 *  new session's tmux session is gone (pi failed to start). */
	private starting(): Map<string, Starting> {
		const now = this.deps.now();
		for (const [id, { record, until }] of this.startingRows) {
			if (now > until || (record.pane && this.paneGone(record.pane))) this.startingRows.delete(id);
		}
		return this.startingRows;
	}

	/**
	 * Before a pane is started on a session file: its row (the file's stored one, else a new one) is
	 * listed as starting until the pane registers, and another start on that file is refused
	 * meanwhile, or while a pane runs it.
	 */
	claimStart(spec: ResumeSpec): StartClaim {
		const now = this.deps.now();
		const file = spec.sessionFile;
		const running = [...this.externalInstances.values()].some(
			(entry) => entry.record.sessionFile === file && now - entry.lastSeenAt <= EXTERNAL_TTL_MS,
		);
		if (running) return { ok: false, refused: "running" };
		if ([...this.starting().values()].some((starting) => starting.record.sessionFile === file)) {
			return { ok: false, refused: "starting" };
		}
		const stored = loadInstances(this.deps.dir).find((instance) => instance.sessionFile === file);
		const id = stored?.id ?? randomUUID();
		this.listStarting({
			id,
			cwd: stored?.cwd ?? spec.cwd,
			label: stored?.label ?? spec.label,
			createdAt: stored?.createdAt,
			sessionFile: file,
		});
		return { ok: true, id };
	}

	/** A new session's pane, just started: listed as starting by its id, which its row registers as. */
	paneStarting(spec: NewPaneSpec): void {
		this.listStarting({ id: spec.pane, cwd: spec.cwd, label: spec.label, pane: spec.pane });
	}

	private listStarting(fields: Omit<InstanceRecord, "status" | "createdAt"> & { createdAt?: string }): void {
		const now = this.deps.now();
		const createdAt = fields.createdAt ?? new Date(now).toISOString();
		this.startingRows.set(fields.id, { record: { ...fields, createdAt, status: "starting" }, until: now + START_MS });
	}

	/** Its pane could not be started: the row is listed as it was. */
	startFailed(id: string): void {
		this.startingRows.delete(id);
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

	/** The pane `id` addresses: the row a pane is listed as, or a pane's own id, unless that is the
	 *  stopped row of a session the pane switched away from. */
	private paneOf(id: string): [string, ExternalInstance] | undefined {
		const listed = this.paneListedAs(id);
		if (listed) return listed;
		const own = this.externalInstances.get(id);
		return own && !getInstance(this.deps.dir, id) ? [id, own] : undefined;
	}

	/** The row a pane is listed as; its own id when it is not registered. */
	rowIdOf(paneId: string): string {
		return this.externalInstances.get(paneId)?.rowId ?? paneId;
	}

	/** A quit leaves its row, stopped, saved again by its hand-off once pi's writes are final. A
	 *  switch to another session or a fork leaves it stopped too: pi settled its turn before ending
	 *  it, so its file is final already (a reload never unregisters). With no reason given (an older
	 *  pane, which may still quit and save), its stored row stays. */
	unregisterExternal(id: string, reason?: EndReason): void {
		const entry = this.externalInstances.get(id);
		const file = entry?.record.sessionFile;
		const stops = reason === "quit" || reason === "new" || reason === "resume" || reason === "fork";
		if (entry && file && stops && existsSync(file)) {
			const { cwd, paneLabel, sessionId } = entry.record;
			this.stopRow({ cwd, label: paneLabel, sessionFile: file, sessionId }, [id, entry], reason);
			if (reason === "quit") this.savesDue.set(file, { deleted: false });
			return;
		}
		if (entry?.rowId === id && reason) removeInstance(this.deps.dir, id);
		if (entry) this.drop(id, entry, reason);
	}

	/** A pane's registration ends, and with it its inbox. */
	private drop(id: string, entry: ExternalInstance, reason?: EndReason): void {
		this.externalInstances.delete(id);
		this.settleWait(id, "none");
		this.onDropped?.(entry.rowId, entry.inbox, reason);
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

	/** External instances, each as its row, reaping any whose last heartbeat is older than the TTL: its
	 *  stored row shows until it beats again. One whose pane tmux says is gone died unseen (a crash, a
	 *  SIGKILL), so its row is stopped with what its file holds last. */
	listExternalInstances(
		now: number = this.deps.now(),
	): Array<{ record: InstanceRecord; activity: AgentActivity; settled: number }> {
		const out: Array<{ record: InstanceRecord; activity: AgentActivity; settled: number }> = [];
		for (const [id, entry] of this.externalInstances) {
			if (now - entry.lastSeenAt > EXTERNAL_TTL_MS) {
				const { cwd, paneLabel, sessionFile, sessionId, pane } = entry.record;
				if (pane && sessionFile && existsSync(sessionFile) && this.paneGone(pane)) {
					// The pane runs pi itself, so its pi is gone and its writes are final.
					this.stopRow({ cwd, label: paneLabel, sessionFile, sessionId }, [id, entry]);
					continue;
				}
				this.drop(id, entry);
				continue;
			}
			out.push({ record: { ...entry.record, id: entry.rowId }, activity: entry.activity, settled: entry.settled });
		}
		return out;
	}

	/** Not when tmux could not say: a pane that may be up is not taken for dead. */
	private paneGone(pane: string): boolean {
		try {
			return !this.deps.tmux.hasSession(pane);
		} catch {
			return false;
		}
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
		const starting = this.starting();
		const stored = loadInstances(this.deps.dir).filter((instance) => !live.has(instance.id));
		// A row a start claimed shows as starting, in its stored row's place if it has one.
		const unstored = [...starting.values()]
			.map((s) => s.record)
			.filter((record) => !live.has(record.id) && !stored.some((instance) => instance.id === record.id));
		return [
			...stored.map((instance) =>
				starting.has(instance.id) ? { ...instance, status: "starting" as const } : cloneInstance(instance),
			),
			...unstored.map(cloneInstance),
		];
	}

	getInstance(instanceId: string): InstanceRecord | undefined {
		const stored = getInstance(this.deps.dir, instanceId);
		return stored ? cloneInstance(stored) : undefined;
	}

	/**
	 * Keep a session that left its window (pi exited while it was idle) as a stopped row, with no
	 * process: it resumes from its `.jsonl` when opened or replied to. A row the daemon already has
	 * for that file is reused, so the session keeps its id, name and pin. A pane still listed on it
	 * (a quitting pane does not wait for its unregister to land) is converted in place. Undefined:
	 * its row was deleted after its quit, before this save.
	 */
	saveInstance(options: {
		cwd: string;
		label?: string;
		sessionFile: string;
		sessionId?: string;
	}): InstanceRecord | undefined {
		const due = this.savesDue.get(options.sessionFile);
		this.savesDue.delete(options.sessionFile);
		if (due?.deleted) return undefined;
		const pane = [...this.externalInstances].find(([, e]) => e.record.sessionFile === options.sessionFile);
		return this.stopRow(options, pane);
	}

	private stopRow(
		options: { cwd: string; label?: string; sessionFile: string; sessionId?: string },
		pane: [string, ExternalInstance] | undefined,
		reason?: EndReason,
	): InstanceRecord {
		const now = new Date(this.deps.now()).toISOString();
		const previous = loadInstances(this.deps.dir).find((instance) => instance.sessionFile === options.sessionFile);
		const tail = readSessionTail(options.sessionFile);
		// The pane it ran in, newer than the row it may have had before: its pin, order, name and age
		// (its session header's time).
		const ended = pane?.[1];
		const last = ended?.record ?? previous;
		if (pane) this.drop(pane[0], pane[1], reason);
		const record: InstanceRecord = {
			...previous,
			...(ended && paneMeta(ended.record)),
			id: previous?.id ?? ended?.rowId ?? randomUUID(),
			status: "stopped",
			cwd: previous?.cwd ?? options.cwd,
			createdAt: ended?.record.createdAt ?? previous?.createdAt ?? now,
			lastSeenAt: now,
			// `options.label` is its pane's name as it quit.
			label: nameOf(last, options.label),
			paneLabel: options.label ?? last?.paneLabel,
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
			this.drop(pane[0], pane[1]);
			if (getInstance(this.deps.dir, pane[1].rowId)) removeInstance(this.deps.dir, pane[1].rowId);
			// Its pi may be quitting already: that quit's hand-off save does not bring it back.
			const file = pane[1].record.sessionFile;
			if (file) this.savesDue.set(file, { deleted: true });
			return true;
		}
		const stored = getInstance(this.deps.dir, instanceId);
		if (!stored) return false;
		const due = stored.sessionFile ? this.savesDue.get(stored.sessionFile) : undefined;
		if (due) due.deleted = true;
		// A pane resuming it, registered or still starting, keeps its pin and order.
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
