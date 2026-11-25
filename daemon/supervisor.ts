import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentActivity } from "./activity.ts";
import {
	type EndReason,
	endedForAnother,
	type NewPaneSpec,
	type PaneMessage,
	type ResumeSpec,
} from "./ipc/protocol.ts";
import { PromptDelivery } from "./remote/delivery.ts";
import { readSessionTail } from "./session-state.ts";
import {
	getInstance,
	loadDeleted,
	loadInstances,
	removeInstance,
	saveDeleted,
	saveInstances,
	upsertInstance,
} from "./storage.ts";
import { endPane } from "./tmux.ts";
import type { InstanceRecord } from "./types.ts";

function cloneInstance(record: InstanceRecord): InstanceRecord {
	return { ...record };
}

function nameOf(row: InstanceRecord | undefined, paneLabel: string | undefined): string | undefined {
	const paneRenamedSinceRow = row?.paneLabel !== undefined && row.paneLabel !== paneLabel;
	if (row?.label === undefined || paneRenamedSinceRow) return paneLabel ?? row?.label;
	return row.label;
}

function paneMeta({ pinned, sortOrder }: InstanceRecord): Pick<InstanceRecord, "pinned" | "sortOrder"> | undefined {
	if (pinned === undefined && sortOrder === undefined) return undefined;
	return { ...(pinned !== undefined ? { pinned } : {}), ...(sortOrder !== undefined ? { sortOrder } : {}) };
}

function onSameSession(pane: Pane, record: InstanceRecord): boolean {
	return pane.record.pane === record.pane && pane.record.sessionFile === record.sessionFile;
}

function wokeFromSilence(silent: PaneRow, record: InstanceRecord): boolean {
	return onSameSession(silent.pane, record) && silent.row.state !== "live";
}

interface Pane {
	record: InstanceRecord;
	activity: AgentActivity;
	lastSeenAt: number;
	settled: number;
	lastStoredJson?: string;
}

type RowState = "starting" | "live" | "silent" | "stored";

interface Row {
	state: RowState;
	pane?: Pane;
	supersededSilentPanes: Pane[];
	start?: Starting;
}

interface PaneRow {
	id: string;
	row: Row;
	pane: Pane;
}

export const EXTERNAL_TTL_MS = 15_000;

export const START_MS = 90_000;

export type StartClaim = { ok: true; id: string } | { ok: false; refused: "starting" | "running" };

interface Starting {
	record: InstanceRecord;
	until: number;
}

export type WaitOutcome = "queued" | "none" | "superseded";

export interface TmuxProbe {
	hasSession(name: string): boolean;
	hasSessionAsync?(name: string): Promise<boolean>;
	hangUpAsQuit(name: string): void;
	shown?(name: string): boolean;
}

type TmuxAnswer = "up" | "gone" | "unknown";

export interface ListProbe {
	now: number;
	said: ReadonlyMap<string, TmuxAnswer>;
}

export interface RegistryDeps {
	now: () => number;
	tmux: TmuxProbe;
	dir: string;
	wakeups?: { drop(sessionFile: string): void };
}

export class ServerSupervisor {
	private readonly deps: RegistryDeps;
	private readonly rows = new Map<string, Row>();
	private readonly waits = new Map<string, (outcome: WaitOutcome) => void>();
	private sending: Promise<unknown> = Promise.resolve();
	readonly delivery: PromptDelivery;
	private readonly droppedPaneOn = new Map<string, string>();

	constructor(deps: RegistryDeps) {
		this.deps = deps;
		this.delivery = new PromptDelivery(deps.now);
	}

	registerExternal(record: InstanceRecord, activity: AgentActivity, now: number = this.deps.now()): void {
		if (this.endIfDeleted(record)) return;
		for (const [file, paneId] of this.droppedPaneOn) {
			if (paneId === record.id || file === record.sessionFile) this.droppedPaneOn.delete(file);
		}
		if (record.sessionFile) this.forgetDeletedSession(record.sessionFile);
		const found = this.paneRow(record.id);
		const previous = found && this.isLive(found) ? found : undefined;
		const silent = found && !previous ? found : undefined;
		const back = silent && wokeFromSilence(silent, record) ? silent : undefined;
		if (back && back.row.pane !== back.pane)
			back.row.supersededSilentPanes.splice(back.row.supersededSilentPanes.indexOf(back.pane), 1);
		if (silent && !back) this.paneEnded(silent, onSameSession(silent.pane, record) ? undefined : "resume");
		const stored = previous ? undefined : this.resumesStoredRow(record.sessionFile);
		const started = this.takeStarting(record);
		const claimed = previous ? undefined : started;
		const last = previous ?? back;
		const renewedBySlashNew = previous !== undefined && previous.pane.record.sessionFile !== record.sessionFile;
		const carriedOver = last
			? {
					...(renewedBySlashNew ? {} : { createdAt: last.pane.record.createdAt }),
					pinned: last.pane.record.pinned,
					sortOrder: last.pane.record.sortOrder,
				}
			: stored && paneMeta(stored);
		const label = renewedBySlashNew ? record.label : nameOf(previous?.pane.record ?? stored, record.label);
		const pane: Pane = {
			record: cloneInstance({ ...record, ...carriedOver, label, paneLabel: record.label }),
			activity,
			lastSeenAt: now,
			settled:
				(previous?.pane.settled ?? 0) + (previous?.pane.activity === "working" && activity !== "working" ? 1 : 0),
			lastStoredJson: previous?.pane.lastStoredJson,
		};
		const rowId = previous?.id ?? back?.id ?? stored?.id ?? claimed?.id ?? this.rowIdFor(record.id);
		if (previous) previous.row.pane = pane;
		else {
			const row = this.entry(rowId);
			if (row.pane && row.pane !== back?.pane) row.supersededSilentPanes.push(row.pane);
			row.pane = pane;
			row.start = undefined;
			this.enterLast(rowId, row, "live");
		}
		if (renewedBySlashNew && !(record.sessionFile && existsSync(record.sessionFile)))
			removeInstance(this.deps.dir, rowId);
		this.persistRow(rowId, pane);
		this.closeOrphanedRun(rowId, record, activity);
	}

	private resumesStoredRow(file: string | undefined): InstanceRecord | undefined {
		const storedRow = file ? loadInstances(this.deps.dir).find((i) => i.sessionFile === file) : undefined;
		return storedRow && this.rows.get(storedRow.id)?.state !== "live" ? storedRow : undefined;
	}

	private rowIdFor(paneId: string): string {
		return getInstance(this.deps.dir, paneId) ? randomUUID() : paneId;
	}

	private endIfDeleted({ id, pane, sessionFile }: InstanceRecord): boolean {
		const deleted = loadDeleted(this.deps.dir);
		if (!deleted.some((row) => row.paneId === id)) return false;
		if (sessionFile && !deleted.some((row) => row.sessionFile === sessionFile)) this.recordDeleted(id, sessionFile);
		if (pane) endPane(this.deps.tmux, pane);
		return true;
	}

	private recordDeleted(paneId: string | undefined, sessionFile: string | undefined): void {
		if (!paneId && !sessionFile) return;
		const row = { paneId, sessionFile, ...(paneId ? {} : { goneAt: this.deps.now() }) };
		saveDeleted(this.deps.dir, [...loadDeleted(this.deps.dir), row]);
	}

	private forgetDeletedSession(file: string): boolean {
		const deleted = loadDeleted(this.deps.dir);
		if (!deleted.some((row) => row.sessionFile === file)) return false;
		const kept = deleted.flatMap(({ sessionFile, ...rest }) =>
			sessionFile !== file ? [{ ...rest, sessionFile }] : rest.paneId ? [rest] : [],
		);
		saveDeleted(this.deps.dir, kept);
		return true;
	}

	private expireDeleted(now: number, said?: ListProbe["said"]): void {
		const deleted = loadDeleted(this.deps.dir);
		let changed = false;
		const kept = deleted.flatMap((row) => {
			const goneAt = row.goneAt ?? (row.paneId && this.tmuxSays(row.paneId, said) === "gone" ? now : undefined);
			if (goneAt === undefined) return [row];
			changed ||= goneAt !== row.goneAt || now - goneAt > START_MS;
			return now - goneAt > START_MS ? [] : [{ ...row, goneAt }];
		});
		if (changed) saveDeleted(this.deps.dir, kept);
	}

	private closeOrphanedRun(rowId: string, { pane, parent }: InstanceRecord, activity: AgentActivity): void {
		if (!pane || !parent || activity === "working" || this.tmuxSays(parent) !== "gone") return;
		if (this.shownOrUnknown(pane)) {
			if (!this.delivery.pending(rowId))
				this.delivery.queue(rowId, { type: "session_message", kind: "close", from: parent });
			return;
		}
		endPane(this.deps.tmux, pane);
	}

	private shownOrUnknown(pane: string): boolean {
		try {
			return this.deps.tmux.shown?.(pane) ?? false;
		} catch {
			return true;
		}
	}

	private persistRow(rowId: string, pane: Pane): void {
		const { cwd, createdAt, label, paneLabel, sessionId, sessionFile, pinned, sortOrder, parent } = pane.record;
		const row = {
			id: rowId,
			status: "stopped" as const,
			outcome: "stopped" as const,
			cwd,
			createdAt,
			label,
			paneLabel,
			sessionId,
			sessionFile,
			...(parent ? { parent } : {}),
		};
		const persisted = JSON.stringify({ ...row, pinned, sortOrder });
		if (persisted === pane.lastStoredJson || !sessionFile || !existsSync(sessionFile)) return;
		upsertInstance(this.deps.dir, { ...getInstance(this.deps.dir, rowId), ...row, pinned, sortOrder });
		pane.lastStoredJson = persisted;
	}

	private takeStarting(record: InstanceRecord): InstanceRecord | undefined {
		let taken: InstanceRecord | undefined;
		for (const [id, row] of [...this.rows]) {
			const { start } = row;
			if (start && (id === record.id || (record.sessionFile && start.record.sessionFile === record.sessionFile))) {
				this.leaveStart(id, row);
				taken ??= start.record;
			}
		}
		return taken;
	}

	private expireStarts(now: number, said?: ListProbe["said"]): void {
		for (const [id, row] of [...this.rows]) {
			const { start } = row;
			if (start && (now > start.until || (start.record.pane && this.tmuxSays(start.record.pane, said) === "gone"))) {
				this.leaveStart(id, row);
			}
		}
	}

	private leaveStart(id: string, row: Row): void {
		row.start = undefined;
		if (row.pane) return;
		row.state = "stored";
		this.tidy(id);
	}

	claimStart(spec: ResumeSpec): StartClaim {
		const now = this.deps.now();
		const file = spec.sessionFile;
		if (this.panesOn(file).some((at) => !this.lapsed(at, now))) return { ok: false, refused: "running" };
		this.expireStarts(now);
		if ([...this.rows.values()].some((row) => row.start?.record.sessionFile === file)) {
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

	paneStarting(spec: NewPaneSpec): void {
		this.listStarting({ id: spec.pane, cwd: spec.cwd, label: spec.label, pane: spec.pane });
	}

	private listStarting(fields: Omit<InstanceRecord, "status" | "createdAt"> & { createdAt?: string }): void {
		const now = this.deps.now();
		const createdAt = fields.createdAt ?? new Date(now).toISOString();
		const row = this.entry(fields.id);
		row.start = { record: { ...fields, createdAt, status: "starting" }, until: now + START_MS };
		if (!row.pane) this.enterLast(fields.id, row, "starting");
	}

	startFailed(id: string): void {
		const row = this.rows.get(id);
		if (row?.start) this.leaveStart(id, row);
	}

	private panes(): PaneRow[] {
		return [...this.rows].flatMap(([id, row]) =>
			[row.pane, ...row.supersededSilentPanes].flatMap((pane) => (pane ? [{ id, row, pane }] : [])),
		);
	}

	private paneRow(paneId: string): PaneRow | undefined {
		return this.panes().find((at) => at.pane.record.id === paneId);
	}

	private panesOn(file: string): PaneRow[] {
		return this.panes().filter((at) => at.pane.record.sessionFile === file);
	}

	private livePaneOn(file: string): PaneRow | undefined {
		return this.panesOn(file).find((at) => this.isLive(at));
	}

	private isLive({ row, pane }: PaneRow): boolean {
		return row.state === "live" && row.pane === pane;
	}

	private lapsed(at: PaneRow, now: number): boolean {
		return this.isLive(at) && now - at.pane.lastSeenAt > EXTERNAL_TTL_MS;
	}

	private addressed(id: string): PaneRow | undefined {
		const row = this.rows.get(id);
		if (row?.pane) return { id, row, pane: row.pane };
		const own = this.paneRow(id);
		return own && this.isLive(own) && !getInstance(this.deps.dir, id) ? own : undefined;
	}

	rowIdOf(paneId: string): string {
		return this.paneRow(paneId)?.id ?? paneId;
	}

	unregisterExternal(id: string, reason?: EndReason): void {
		const at = this.paneRow(id);
		if (!at) return;
		if (!this.isLive(at)) {
			if (endedForAnother(reason)) this.paneEnded(at, reason);
			else this.drop(at, reason);
			return;
		}
		const file = at.pane.record.sessionFile;
		const stops = reason === "quit" || endedForAnother(reason);
		if (file && stops && existsSync(file)) {
			const { cwd, paneLabel, sessionId } = at.pane.record;
			this.stopRow({ cwd, label: paneLabel, sessionFile: file, sessionId }, at, reason);
			return;
		}
		if (at.id === id && reason) removeInstance(this.deps.dir, id);
		this.drop(at, reason);
	}

	private drop(at: PaneRow, reason?: EndReason): void {
		const { id, row, pane } = at;
		const listed = row.pane === pane;
		if (listed) {
			row.pane = row.supersededSilentPanes.shift();
			if (row.pane) this.enterLast(id, row, "silent");
			else row.state = row.start ? "starting" : "stored";
		} else row.supersededSilentPanes.splice(row.supersededSilentPanes.indexOf(pane), 1);
		this.tidy(id);
		this.settleWait(pane.record.id, "none");
		this.delivery.ended(id, pane.record.id, reason, listed);
	}

	private silence({ id, row, pane }: PaneRow): void {
		this.enterLast(id, row, "silent");
		this.settleWait(pane.record.id, "none");
		this.delivery.silent(id);
	}

	async sendExternal(id: string, message: PaneMessage): Promise<boolean> {
		const before = this.addressed(id);
		if (!before || !this.isLive(before)) return false;
		const { pane } = before.pane.record;
		const turn = Promise.all([pane && this.tmuxSaysAsync(pane), this.sending]);
		this.sending = turn;
		const [answer] = await turn;
		const at = this.addressed(id);
		if (!at || !this.isLive(at) || at.pane.record.id !== before.pane.record.id) return false;
		const beatSince = at.pane !== before.pane;
		if (answer === "gone" && !beatSince) {
			this.paneEnded(at);
			return false;
		}
		this.delivery.queue(at.id, message);
		this.settleWait(at.pane.record.id, "queued");
		return true;
	}

	waitExternal(id: string, timeoutMs: number): Promise<WaitOutcome> | undefined {
		const at = this.paneRow(id);
		if (!at || !this.isLive(at)) return undefined;
		this.settleWait(id, "superseded");
		if (this.delivery.pending(at.id)) return Promise.resolve("queued");
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.settleWait(id, "none"), timeoutMs);
			this.waits.set(id, (outcome) => {
				clearTimeout(timer);
				resolve(outcome);
			});
		});
	}

	settleWaits(): void {
		for (const id of [...this.waits.keys()]) this.settleWait(id, "none");
	}

	private settleWait(id: string, outcome: WaitOutcome): void {
		const settle = this.waits.get(id);
		if (!settle) return;
		this.waits.delete(id);
		settle(outcome);
	}

	drainExternal(id: string): PaneMessage[] {
		const at = this.paneRow(id);
		if (!at || !this.isLive(at)) return [];
		return this.delivery.take(at.id, id);
	}

	listExternalInstances(
		now: number = this.deps.now(),
		said?: ListProbe["said"],
	): Array<{ record: InstanceRecord; activity: AgentActivity; settled: number; silent?: true }> {
		this.reap(now, said);
		const listed = (state: RowState) =>
			[...this.rows].flatMap(([id, row]) =>
				row.state === state && row.pane
					? [{ record: { ...row.pane.record, id }, activity: row.pane.activity, settled: row.pane.settled }]
					: [],
			);
		return [...listed("live"), ...listed("silent").map((row) => ({ ...row, silent: true as const }))];
	}

	private reap(now: number, said?: ListProbe["said"]): void {
		this.expireStarts(now, said);
		this.expireDeleted(now, said);
		for (const at of this.panes()) {
			const { pane } = at.pane.record;
			if (!this.isLive(at) && pane && this.tmuxSays(pane, said) === "gone") this.paneEnded(at);
		}
		for (const at of this.panes()) {
			if (!this.lapsed(at, now)) continue;
			const { pane } = at.pane.record;
			const answer = pane ? this.tmuxSays(pane, said) : "unknown";
			if (answer === "gone") this.paneEnded(at);
			else if (answer === "up") this.silence(at);
			else {
				const { id, sessionFile } = at.pane.record;
				if (sessionFile) this.droppedPaneOn.set(sessionFile, id);
				this.drop(at);
			}
		}
	}

	private paneEnded(at: PaneRow, reason?: EndReason): void {
		const { cwd, paneLabel, sessionFile, sessionId } = at.pane.record;
		const taken = at.row.state === "live" && at.row.pane !== at.pane;
		if (sessionFile && existsSync(sessionFile) && !taken) {
			this.stopRow({ cwd, label: paneLabel, sessionFile, sessionId }, at, reason);
		} else this.drop(at, reason);
	}

	private tmuxSays(pane: string, said?: ListProbe["said"]): TmuxAnswer {
		const answer = said?.get(pane);
		if (answer) return answer;
		try {
			return this.deps.tmux.hasSession(pane) ? "up" : "gone";
		} catch {
			return "unknown";
		}
	}

	async probeForList(): Promise<ListProbe> {
		const now = this.deps.now();
		const names = new Set<string>();
		for (const { start } of this.rows.values()) {
			if (start?.record.pane && now <= start.until) names.add(start.record.pane);
		}
		for (const { paneId, goneAt } of loadDeleted(this.deps.dir)) {
			if (paneId && goneAt === undefined) names.add(paneId);
		}
		const registered = new Set<string>();
		for (const at of this.panes()) {
			const { pane } = at.pane.record;
			if (!pane) continue;
			registered.add(pane);
			if (!this.isLive(at) || this.lapsed(at, now)) names.add(pane);
		}
		for (const { parent } of loadInstances(this.deps.dir)) {
			if (parent && !registered.has(parent)) names.add(parent);
		}
		const answers = await Promise.all(
			[...names].map(async (name): Promise<[string, TmuxAnswer]> => [name, await this.tmuxSaysAsync(name)]),
		);
		return { now, said: new Map(answers) };
	}

	private async tmuxSaysAsync(pane: string): Promise<TmuxAnswer> {
		const { tmux } = this.deps;
		try {
			return (tmux.hasSessionAsync ? await tmux.hasSessionAsync(pane) : tmux.hasSession(pane)) ? "up" : "gone";
		} catch {
			return "unknown";
		}
	}

	private entry(id: string): Row {
		let row = this.rows.get(id);
		if (!row) {
			row = { state: "stored", supersededSilentPanes: [] };
			this.rows.set(id, row);
		}
		return row;
	}

	private enterLast(id: string, row: Row, state: RowState): void {
		row.state = state;
		this.rows.delete(id);
		this.rows.set(id, row);
	}

	private tidy(id: string): void {
		if (this.rows.get(id)?.state === "stored") this.rows.delete(id);
	}

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

	listInstances(now: number = this.deps.now(), said?: ListProbe["said"]): InstanceRecord[] {
		this.reap(now, said);
		this.removeOrphanedRuns(said);
		const paned = new Set([...this.rows].flatMap(([id, row]) => (row.pane ? [id] : [])));
		const starting = new Map(
			[...this.rows].flatMap(([id, row]) => (!row.pane && row.start ? [[id, row.start.record]] : [])),
		);
		const stored = loadInstances(this.deps.dir).filter((instance) => !paned.has(instance.id));
		const unstored = [...starting.values()].filter((record) => !stored.some((instance) => instance.id === record.id));
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

	saveInstance(options: {
		cwd: string;
		label?: string;
		sessionFile: string;
		sessionId?: string;
		parent?: string;
	}): InstanceRecord | undefined {
		if (this.forgetDeletedSession(options.sessionFile)) return undefined;
		return this.stopRow(options, this.livePaneOn(options.sessionFile));
	}

	private stopRow(
		options: { cwd: string; label?: string; sessionFile: string; sessionId?: string; parent?: string },
		at: PaneRow | undefined,
		reason?: EndReason,
	): InstanceRecord {
		const now = new Date(this.deps.now()).toISOString();
		const previous = loadInstances(this.deps.dir).find((instance) => instance.sessionFile === options.sessionFile);
		const tail = readSessionTail(options.sessionFile);
		const ended = at?.pane;
		const last = ended?.record ?? previous;
		if (at) this.drop(at, reason);
		const parent = ended?.record.parent ?? options.parent ?? previous?.parent;
		const record: InstanceRecord = {
			...previous,
			...(ended && paneMeta(ended.record)),
			...(parent ? { parent } : {}),
			id: previous?.id ?? at?.id ?? randomUUID(),
			status: "stopped",
			cwd: previous?.cwd ?? options.cwd,
			createdAt: ended?.record.createdAt ?? previous?.createdAt ?? now,
			lastSeenAt: now,
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

	private removeOrphanedRuns(said?: ListProbe["said"]): void {
		const registered = new Set(this.panes().flatMap((at) => (at.pane.record.pane ? [at.pane.record.pane] : [])));
		const gone = new Map<string, boolean>();
		for (const { id, parent } of loadInstances(this.deps.dir)) {
			if (!parent || registered.has(parent)) continue;
			if (!gone.has(parent)) gone.set(parent, this.tmuxSays(parent, said) === "gone");
			if (gone.get(parent)) removeInstance(this.deps.dir, id);
		}
	}

	deleteInstance(instanceId: string): boolean {
		const at = this.addressed(instanceId);
		const pane = at?.pane.record.pane;
		if (!this.deleteRow(instanceId)) return false;
		if (pane) this.deleteRuns(pane);
		return true;
	}

	private deleteRuns(parent: string): void {
		const open = this.panes().filter((at) => at.pane.record.parent === parent);
		for (const at of open) if (at.pane.record.pane) endPane(this.deps.tmux, at.pane.record.pane);
		const stored = loadInstances(this.deps.dir).filter((instance) => instance.parent === parent);
		for (const id of new Set([...open.map((at) => at.id), ...stored.map((instance) => instance.id)]))
			this.deleteRow(id);
	}

	private deleteRow(instanceId: string): boolean {
		const at = this.addressed(instanceId);
		if (at) {
			this.drop(at);
			if (getInstance(this.deps.dir, at.id)) removeInstance(this.deps.dir, at.id);
			this.recordDeleted(at.pane.record.id, at.pane.record.sessionFile);
			if (at.pane.record.sessionFile) this.deps.wakeups?.drop(at.pane.record.sessionFile);
			return true;
		}
		const stored = getInstance(this.deps.dir, instanceId);
		if (!stored) return false;
		this.recordDeleted(stored.sessionFile && this.droppedPaneOn.get(stored.sessionFile), stored.sessionFile);
		if (stored.sessionFile) this.deps.wakeups?.drop(stored.sessionFile);
		removeInstance(this.deps.dir, instanceId);
		return true;
	}

	renameInstance(instanceId: string, name: string): InstanceRecord | undefined {
		return this.updateStored(instanceId, { label: name });
	}

	setInstanceMeta(
		instanceId: string,
		{ pinned, sortOrder }: Pick<InstanceRecord, "pinned" | "sortOrder">,
	): InstanceRecord | undefined {
		const at = this.addressed(instanceId);
		const wasPinned = at ? at.pane.record.pinned : getInstance(this.deps.dir, instanceId)?.pinned;
		const pinFlipped = pinned !== undefined && pinned !== !!wasPinned;
		const meta: Pick<InstanceRecord, "pinned" | "sortOrder"> = {
			...(pinned !== undefined ? { pinned } : {}),
			...(pinFlipped ? { sortOrder: undefined } : {}),
			...(sortOrder !== undefined ? { sortOrder } : {}),
		};
		if (at) {
			at.pane.record = { ...at.pane.record, ...meta };
			this.updateStored(at.id, meta);
			return { ...at.pane.record, id: at.id };
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
