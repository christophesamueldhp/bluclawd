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

/** A pane's pi, as it last beat. */
interface Pane {
	/** As the pane registered it: `id` is the pane's own (its tmux session's name). */
	record: InstanceRecord;
	activity: AgentActivity;
	lastSeenAt: number;
	/** How many times it stopped working: a turn too quick for a poll to see still counts. */
	settled: number;
	/** Its row as last stored, so a heartbeat that changes none of it writes nothing. */
	persisted?: string;
}

/**
 * Where a row is in its lifecycle. `starting`: a start claimed it and its pane has not registered.
 * `live`: a pane beats as it. `silent`: its pane missed its heartbeats while tmux still has it (a
 * Silent pane): listed as it last beat, alive, and taking no messages. `stored`: only its stored
 * row, if any, is listed; a row with no entry in the table is stored too.
 */
type RowState = "starting" | "live" | "silent" | "stored";

/** A row's entry: only transitions change it. */
interface Row {
	state: RowState;
	/** Live or silent: the pane listed as it. */
	pane?: Pane;
	/** Silent panes another pane went on as this row since: listed no more, each ends as a Silent
	 *  pane does. The first goes on as the row, silent, when its pane goes. */
	held: Pane[];
	/** A start claimed it: its record as listed, and when it stops being listed so. It is starting
	 *  once no pane holds it: a pane past its TTL, not reaped yet, may still. */
	start?: Starting;
}

/** A pane and the row it is listed as, or was as it fell silent. */
interface PaneRow {
	id: string;
	row: Row;
	pane: Pane;
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

/** What the registry asks of tmux: whether a pane's session is still there, and ending a run's pane. */
export interface TmuxProbe {
	hasSession(name: string): boolean;
	/** {@link hasSession} without blocking; `hasSession` stands in when absent. */
	hasSessionAsync?(name: string): Promise<boolean>;
	/** Ends a pane's pi as quitting does: its session is kept. */
	end(name: string): void;
	/** Whether a terminal shows a pane; none does when absent. */
	shown?(name: string): boolean;
}

/** Whether tmux has a pane's session; "unknown" when it could not say. */
type TmuxAnswer = "up" | "gone" | "unknown";

/** What tmux said of each pane a list asks about, by pane, and the time the list reaps as of. */
export interface ListProbe {
	now: number;
	said: ReadonlyMap<string, TmuxAnswer>;
}

export interface RegistryDeps {
	/** Milliseconds since the epoch. */
	now: () => number;
	tmux: TmuxProbe;
	/** Where instances.json lives. */
	dir: string;
	/** The wake-ups the daemon holds: a deleted row's session has none fired for it. */
	wakeups?: { drop(sessionFile: string): void };
}

/**
 * Agent view's registry. Every running session is a pane's pi that registers itself with a
 * heartbeat; the daemon runs no sessions. A session whose pi quit while idle stays as a stored
 * row (instances.json), resumable from its .jsonl. Each row's state is in one table, by row id;
 * time passing is a transition too (reaping), applied before every list, so lists may be read in
 * any order.
 */
export class ServerSupervisor {
	private readonly deps: RegistryDeps;
	private readonly rows = new Map<string, Row>();
	/** Each pane's pending wait, by id; kept apart from its row, which every heartbeat replaces. */
	private readonly waits = new Map<string, (outcome: WaitOutcome) => void>();
	/** The latest send, settled once it is queued or refused. */
	private sending: Promise<unknown> = Promise.resolve();
	/** Each row's inbox and the phone's prompts in it, fed every pane's end and silence. */
	readonly delivery: PromptDelivery;
	/** By session file, the pane on it that reaping dropped, tmux unable to say whether it is up, and
	 *  that has not registered since: deleting the file's stored row ends that pane should it beat again. */
	private readonly droppedPaneOn = new Map<string, string>();

	constructor(deps: RegistryDeps) {
		this.deps = deps;
		this.delivery = new PromptDelivery(deps.now);
	}

	/** Register/heartbeat a pane's pi. */
	registerExternal(record: InstanceRecord, activity: AgentActivity, now: number = this.deps.now()): void {
		if (this.endIfDeleted(record)) return;
		for (const [file, paneId] of this.droppedPaneOn) {
			if (paneId === record.id || file === record.sessionFile) this.droppedPaneOn.delete(file);
		}
		// Another pane on a deleted row's session file resumes it, as a new row.
		if (record.sessionFile) this.forgetDeletedSession(record.sessionFile);
		const found = this.paneRow(record.id);
		const previous = found && this.isLive(found) ? found : undefined;
		const silent = found && !previous ? found : undefined;
		const sameSession =
			silent?.pane.record.pane === record.pane && silent?.pane.record.sessionFile === record.sessionFile;
		// The same pane beating again on the same session goes on as the row it fell silent as, which
		// may have no stored row yet (a row a start claimed, before pi wrote its file), unless another
		// pane went on as that row meanwhile.
		const back = silent && sameSession && silent.row.state !== "live" ? silent : undefined;
		if (back && back.row.pane !== back.pane) back.row.held.splice(back.row.held.indexOf(back.pane), 1);
		// Otherwise it went on to another session while silent (a new one or a /resume, which its beat
		// does not say): it ended the one it was listed as for that one.
		if (silent && !back) this.paneEnded(silent, sameSession ? undefined : "resume");
		// A pane resuming a stored session goes on as its row, which stays stored behind it, unless a live
		// pane already goes on as it.
		const file = record.sessionFile;
		const storedRow =
			file && !previous ? loadInstances(this.deps.dir).find((i) => i.sessionFile === file) : undefined;
		const stored = storedRow && this.rows.get(storedRow.id)?.state !== "live" ? storedRow : undefined;
		const started = this.takeStarting(record);
		const claimed = previous ? undefined : started;
		// A heartbeat restates what the session knows; its age and agent-view meta are kept here.
		// A pane back from silence keeps what it was given meanwhile, which a row a start claimed
		// has stored nowhere else.
		const last = previous ?? back;
		// A live pane beating a new file went on to a new session (/new): its row carries on with it,
		// keeping its pin and order but not the old session's age or name.
		const renewed = previous !== undefined && previous.pane.record.sessionFile !== record.sessionFile;
		const kept = last
			? {
					...(renewed ? {} : { createdAt: last.pane.record.createdAt }),
					pinned: last.pane.record.pinned,
					sortOrder: last.pane.record.sortOrder,
				}
			: stored && paneMeta(stored);
		const label = renewed ? record.label : nameOf(previous?.pane.record ?? stored, record.label);
		const pane: Pane = {
			record: cloneInstance({ ...record, ...kept, label, paneLabel: record.label }),
			activity,
			lastSeenAt: now,
			settled:
				(previous?.pane.settled ?? 0) + (previous?.pane.activity === "working" && activity !== "working" ? 1 : 0),
			persisted: previous?.pane.persisted,
		};
		// A pane that went on to another session leaves the row stored under its id to that one.
		const rowId =
			previous?.id ??
			back?.id ??
			stored?.id ??
			claimed?.id ??
			(getInstance(this.deps.dir, record.id) ? randomUUID() : record.id);
		if (previous) previous.row.pane = pane;
		else {
			const row = this.entry(rowId);
			// A silent pane another pane goes on as its row is held until it ends.
			if (row.pane && row.pane !== back?.pane) row.held.push(row.pane);
			row.pane = pane;
			row.start = undefined;
			this.enter(rowId, row, "live");
		}
		// Until the new session has a file, the row stored for the old one must not show for it.
		if (renewed && !(record.sessionFile && existsSync(record.sessionFile))) removeInstance(this.deps.dir, rowId);
		this.persistRow(rowId, pane);
		this.closeOrphanedRun(rowId, record, activity);
	}

	/** A pane whose row was deleted is not listed again: its pi ends, as a quit does, and the save its
	 *  quit hands off lists nothing, whatever session it went on to before it heard. Should tmux not
	 *  answer, its next heartbeat tries again. */
	private endIfDeleted({ id, pane, sessionFile }: InstanceRecord): boolean {
		const deleted = loadDeleted(this.deps.dir);
		if (!deleted.some((row) => row.paneId === id)) return false;
		if (sessionFile && !deleted.some((row) => row.sessionFile === sessionFile)) this.recordDeleted(id, sessionFile);
		if (pane) endPane(this.deps.tmux, pane);
		return true;
	}

	/** Keeps a row deleted past a daemon restart: pane `paneId`, and session `sessionFile` through a
	 *  quit's hand-off save. */
	private recordDeleted(paneId: string | undefined, sessionFile: string | undefined): void {
		if (!paneId && !sessionFile) return;
		const row = { paneId, sessionFile, ...(paneId ? {} : { goneAt: this.deps.now() }) };
		saveDeleted(this.deps.dir, [...loadDeleted(this.deps.dir), row]);
	}

	/** Whether `file` was a deleted row's session, which it is no longer: a save of it is the last that
	 *  row hears of, and another pane on it is a new row. */
	private forgetDeletedSession(file: string): boolean {
		const deleted = loadDeleted(this.deps.dir);
		if (!deleted.some((row) => row.sessionFile === file)) return false;
		const kept = deleted.flatMap(({ sessionFile, ...rest }) =>
			sessionFile !== file ? [{ ...rest, sessionFile }] : rest.paneId ? [rest] : [],
		);
		saveDeleted(this.deps.dir, kept);
		return true;
	}

	/** A deleted row is kept while tmux may still have its pane, then as long as a start may take
	 *  (`START_MS`) for its quit's hand-off save to land. */
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

	/**
	 * A run outlives its orchestrator's crash only to finish the turn in flight (ADR-0008): once tmux
	 * no longer has the orchestrator's pane, its pi is gone for good (a Silent pane's tmux still has
	 * it), and the run's first heartbeat that is not working closes it. A reopened orchestrator that
	 * adopts the run first moves its heartbeat to its own pane.
	 */
	private closeOrphanedRun(rowId: string, { pane, parent }: InstanceRecord, activity: AgentActivity): void {
		if (!pane || !parent || activity === "working" || this.tmuxSays(parent) !== "gone") return;
		// One a terminal shows is only told, so the user is not thrown out of it: it ends once the terminal leaves.
		if (this.shown(pane)) {
			if (!this.delivery.pending(rowId))
				this.delivery.queue(rowId, { type: "session_message", kind: "close", from: parent });
			return;
		}
		// Should tmux not answer, the run's next heartbeat tries again.
		endPane(this.deps.tmux, pane);
	}

	/** Whether a terminal shows a pane; taken to when tmux cannot say, as the run then ends itself once it hears. */
	private shown(pane: string): boolean {
		try {
			return this.deps.tmux.shown?.(pane) ?? false;
		} catch {
			return true;
		}
	}

	/** Store a pane's row as it shows without its pane, stopped, once its session has a file to resume
	 *  from: its pin, order, name and age survive a daemon restart, and its pane's next heartbeat goes
	 *  on as it. */
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
		if (persisted === pane.persisted || !sessionFile || !existsSync(sessionFile)) return;
		upsertInstance(this.deps.dir, { ...getInstance(this.deps.dir, rowId), ...row, pinned, sortOrder });
		pane.persisted = persisted;
	}

	/** A pane registering as `record` ends the start of its session file's row, or of its own id's,
	 *  which it goes on as. */
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

	/** Rows listed as starting stop being so once their pane will not register: its time is up, or a
	 *  new session's tmux session is gone (pi failed to start). */
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

	/**
	 * Before a pane is started on a session file: its row (the file's stored one, else a new one) is
	 * listed as starting until the pane registers, and another start on that file is refused
	 * meanwhile, or while a pane runs it (a Silent pane too).
	 */
	claimStart(spec: ResumeSpec): StartClaim {
		const now = this.deps.now();
		const file = spec.sessionFile;
		// A live pane past its TTL is not reaped here, so when prompts settle does not change, but it is
		// no longer taken to run the file.
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

	/** A new session's pane, just started: listed as starting by its id, which its row registers as. */
	paneStarting(spec: NewPaneSpec): void {
		this.listStarting({ id: spec.pane, cwd: spec.cwd, label: spec.label, pane: spec.pane });
	}

	private listStarting(fields: Omit<InstanceRecord, "status" | "createdAt"> & { createdAt?: string }): void {
		const now = this.deps.now();
		const createdAt = fields.createdAt ?? new Date(now).toISOString();
		const row = this.entry(fields.id);
		row.start = { record: { ...fields, createdAt, status: "starting" }, until: now + START_MS };
		// A pane past its TTL, not reaped yet, keeps the row until it is.
		if (!row.pane) this.enter(fields.id, row, "starting");
	}

	/** Its pane could not be started: the row is listed as it was. */
	startFailed(id: string): void {
		const row = this.rows.get(id);
		if (row?.start) this.leaveStart(id, row);
	}

	/** Every pane, each with the row it is listed as or was as it fell silent. */
	private panes(): PaneRow[] {
		return [...this.rows].flatMap(([id, row]) =>
			[row.pane, ...row.held].flatMap((pane) => (pane ? [{ id, row, pane }] : [])),
		);
	}

	/** Which row pane `paneId` is: the one place that answers it. */
	private paneRow(paneId: string): PaneRow | undefined {
		return this.panes().find((at) => at.pane.record.id === paneId);
	}

	/** The panes on session file `file`, live or silent. */
	private panesOn(file: string): PaneRow[] {
		return this.panes().filter((at) => at.pane.record.sessionFile === file);
	}

	/** The live pane on session file `file`, if any. */
	private livePaneOn(file: string): PaneRow | undefined {
		return this.panesOn(file).find((at) => this.isLive(at));
	}

	/** Whether a pane is its row's live one: the only pane a message is queued for. */
	private isLive({ row, pane }: PaneRow): boolean {
		return row.state === "live" && row.pane === pane;
	}

	/** Whether a live pane's last heartbeat is older than the TTL, so reaping takes it as of `now`. */
	private lapsed(at: PaneRow, now: number): boolean {
		return this.isLive(at) && now - at.pane.lastSeenAt > EXTERNAL_TTL_MS;
	}

	/** The pane `id` addresses: the row's pane, live or silent, or a live pane's own id, unless that
	 *  is the stopped row of a session the pane switched away from. */
	private addressed(id: string): PaneRow | undefined {
		const row = this.rows.get(id);
		if (row?.pane) return { id, row, pane: row.pane };
		const own = this.paneRow(id);
		return own && this.isLive(own) && !getInstance(this.deps.dir, id) ? own : undefined;
	}

	/** The row a pane is listed as, or was as it fell silent; its own id when it is not registered. */
	rowIdOf(paneId: string): string {
		return this.paneRow(paneId)?.id ?? paneId;
	}

	/** A quit leaves its row, stopped, saved again by its hand-off once pi's writes are final. A
	 *  switch to another session or a fork leaves it stopped too: pi settled its turn before ending
	 *  it, so its file is final already (a reload never unregisters). With no reason given (an older
	 *  pane, which may still quit and save), its stored row stays. */
	unregisterExternal(id: string, reason?: EndReason): void {
		const at = this.paneRow(id);
		if (!at) return;
		if (!this.isLive(at)) {
			// Its session ended for another, so its file is final; a quit's hand-off saves its row.
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

	/** A pane's registration ends, and with it its inbox: its row goes on with the first silent pane
	 *  it holds, or as its stored row. */
	private drop(at: PaneRow, reason?: EndReason): void {
		const { id, row, pane } = at;
		const listed = row.pane === pane;
		if (listed) {
			row.pane = row.held.shift();
			if (row.pane) this.enter(id, row, "silent");
			else row.state = row.start ? "starting" : "stored";
		} else row.held.splice(row.held.indexOf(pane), 1);
		this.tidy(id);
		this.settleWait(pane.record.id, "none");
		this.delivery.ended(id, pane.record.id, reason, listed);
	}

	/** Its pane missed its heartbeats while tmux still has it: it may only be held up. */
	private silence({ id, row, pane }: PaneRow): void {
		this.enter(id, row, "silent");
		this.settleWait(pane.record.id, "none");
		this.delivery.silent(id);
	}

	/** Queue a message for a self-registered session, by its pane's id or its row's; false when no
	 *  live pane is registered as either, or tmux no longer has that pane, which then ends: its pi
	 *  died unseen within its TTL, so nothing would take the message. tmux is asked without blocking. */
	async sendExternal(id: string, message: PaneMessage): Promise<boolean> {
		const before = this.addressed(id);
		if (!before || !this.isLive(before)) return false;
		const { pane } = before.pane.record;
		// Queued in the order sent, whichever of tmux's answers comes back first.
		const turn = Promise.all([pane && this.tmuxSaysAsync(pane), this.sending]);
		this.sending = turn;
		const [answer] = await turn;
		// Its pane may have beaten, ended or been replaced meanwhile: only the same pi, still live, is meant.
		const at = this.addressed(id);
		if (!at || !this.isLive(at) || at.pane.record.id !== before.pane.record.id) return false;
		// A beat since says its pi is up, whatever tmux answered before it.
		if (answer === "gone" && at.pane === before.pane) {
			this.paneEnded(at);
			return false;
		}
		this.delivery.queue(at.id, message);
		this.settleWait(at.pane.record.id, "queued");
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

	/** Pane `id`'s heartbeat takes the messages queued for its row, when it is the row's live pane. */
	drainExternal(id: string): PaneMessage[] {
		const at = this.paneRow(id);
		if (!at || !this.isLive(at)) return [];
		return this.delivery.take(at.id, id);
	}

	/** External instances, each as its row, after reaping: live ones, then silent ones, each `silent`. */
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

	/**
	 * Time passing, as of `now`. A start whose pane will not register ends. A Silent pane tmux no
	 * longer has ends. A pane whose last heartbeat is older than the TTL is reaped: if tmux says its
	 * pane is gone, its pi died unseen (a crash, a SIGKILL) and its row is stopped with what its file
	 * holds last; if tmux still has it, it falls silent; if tmux could not say, or it
	 * has no pane to ask about, it is dropped and its stored row shows until it beats again.
	 */
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
			// The pane runs pi itself, so its pi is gone.
			if (answer === "gone") this.paneEnded(at);
			else if (answer === "up") this.silence(at);
			else {
				const { id, sessionFile } = at.pane.record;
				if (sessionFile) this.droppedPaneOn.set(sessionFile, id);
				this.drop(at);
			}
		}
	}

	/** A pane's pi ended, so its session's writes are final: its row is stopped with what its file
	 *  holds last, unless another pane goes on as it. */
	private paneEnded(at: PaneRow, reason?: EndReason): void {
		const { cwd, paneLabel, sessionFile, sessionId } = at.pane.record;
		const taken = at.row.state === "live" && at.row.pane !== at.pane;
		if (sessionFile && existsSync(sessionFile) && !taken) {
			this.stopRow({ cwd, label: paneLabel, sessionFile, sessionId }, at, reason);
		} else this.drop(at, reason);
	}

	/** Whether tmux has a pane's session; "unknown" when it could not say, so a pane that may be up is
	 *  not taken for dead. A pane a list's probe did not ask about (it came up during the probe) is
	 *  asked now, so the list reaps as it would have. */
	private tmuxSays(pane: string, said?: ListProbe["said"]): TmuxAnswer {
		const answer = said?.get(pane);
		if (answer) return answer;
		try {
			return this.deps.tmux.hasSession(pane) ? "up" : "gone";
		} catch {
			return "unknown";
		}
	}

	/**
	 * What a list as of now asks tmux, asked of it at once and without blocking, so other requests are
	 * answered meanwhile: the panes and deleted rows reaping asks about, and the orchestrators of stored
	 * runs. Each is asked once, for both of a list's halves.
	 */
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

	/** Whether tmux has a pane's session, asked without blocking; "unknown" when it could not say. */
	private async tmuxSaysAsync(pane: string): Promise<TmuxAnswer> {
		const { tmux } = this.deps;
		try {
			return (tmux.hasSessionAsync ? await tmux.hasSessionAsync(pane) : tmux.hasSession(pane)) ? "up" : "gone";
		} catch {
			return "unknown";
		}
	}

	/** Row `id`'s entry, a stored one if it had none. */
	private entry(id: string): Row {
		let row = this.rows.get(id);
		if (!row) {
			row = { state: "stored", held: [] };
			this.rows.set(id, row);
		}
		return row;
	}

	/** A row enters `state` last in the table, so rows list in the order they entered theirs. */
	private enter(id: string, row: Row, state: RowState): void {
		row.state = state;
		this.rows.delete(id);
		this.rows.set(id, row);
	}

	/** A stored row's entry goes. */
	private tidy(id: string): void {
		if (this.rows.get(id)?.state === "stored") this.rows.delete(id);
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

	/** Stored rows after reaping, but for those a live or silent pane goes on as: that pane lists them. */
	listInstances(now: number = this.deps.now(), said?: ListProbe["said"]): InstanceRecord[] {
		this.reap(now, said);
		this.removeOrphanedRuns(said);
		const paned = new Set([...this.rows].flatMap(([id, row]) => (row.pane ? [id] : [])));
		const starting = new Map(
			[...this.rows].flatMap(([id, row]) => (!row.pane && row.start ? [[id, row.start.record]] : [])),
		);
		const stored = loadInstances(this.deps.dir).filter((instance) => !paned.has(instance.id));
		// A row a start claimed shows as starting, in its stored row's place if it has one.
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
		// The pane it ran in, newer than the row it may have had before: its pin, order, name and age
		// (its session header's time).
		const ended = at?.pane;
		const last = ended?.record ?? previous;
		if (at) this.drop(at, reason);
		// A run's row keeps its orchestrator, so agent view and the phone leave it out.
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

	/** A closed run's stored row goes once tmux no longer has its orchestrator's pane, as an open
	 *  run's pi does (closeOrphanedRun); a registered orchestrator costs no tmux call. */
	private removeOrphanedRuns(said?: ListProbe["said"]): void {
		const registered = new Set(this.panes().flatMap((at) => (at.pane.record.pane ? [at.pane.record.pane] : [])));
		const gone = new Map<string, boolean>();
		for (const { id, parent } of loadInstances(this.deps.dir)) {
			if (!parent || registered.has(parent)) continue;
			if (!gone.has(parent)) gone.set(parent, this.tmuxSays(parent, said) === "gone");
			if (gone.get(parent)) removeInstance(this.deps.dir, id);
		}
	}

	/** Remove the row, and the rows of the runs it orchestrates, whose pis end. The sessions' .jsonl
	 *  stay on disk, resumable with /resume. */
	deleteInstance(instanceId: string): boolean {
		const at = this.addressed(instanceId);
		const pane = at ? at.pane.record.pane : getInstance(this.deps.dir, instanceId)?.pane;
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
		// A self-registered session's process is its pane's, a Silent pane's too: its row goes with
		// the stored row it went on as, and its pane is ended should it beat again.
		const at = this.addressed(instanceId);
		if (at) {
			this.drop(at);
			if (getInstance(this.deps.dir, at.id)) removeInstance(this.deps.dir, at.id);
			// Its pi may be quitting already: that quit's hand-off save does not bring it back.
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

	/** Agent-view-only fields: pin and manual order. A Silent pane's row takes them as a live one's. */
	setInstanceMeta(
		instanceId: string,
		{ pinned, sortOrder }: Pick<InstanceRecord, "pinned" | "sortOrder">,
	): InstanceRecord | undefined {
		const at = this.addressed(instanceId);
		const wasPinned = at ? at.pane.record.pinned : getInstance(this.deps.dir, instanceId)?.pinned;
		// A field left out stays as it is: a reorder does not unpin. Pinning or unpinning moves the
		// row to another band, so its old order is dropped unless one is given.
		const meta: Pick<InstanceRecord, "pinned" | "sortOrder"> = {
			...(pinned !== undefined ? { pinned } : {}),
			...(pinned !== undefined && pinned !== !!wasPinned ? { sortOrder: undefined } : {}),
			...(sortOrder !== undefined ? { sortOrder } : {}),
		};
		if (at) {
			at.pane.record = { ...at.pane.record, ...meta };
			// The stored row behind it shows again if its pane dies unseen.
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
