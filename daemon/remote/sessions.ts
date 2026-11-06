/**
 * The phone's session list: agent view's own rows and bands (daemon/rows.ts, pure), so
 * the phone and the terminal agree on what is Needs input, Working or Idle.
 *
 * rows.ts is under daemon/, so editing it changes the daemon's build id and agent view
 * restarts the daemon: the phone never runs older rows than the terminal.
 */

import type { InstanceSummary } from "../ipc/protocol.ts";
import { type AgentRow, buildBands, collectRows, type RowState } from "../rows.ts";

export type RemoteBand = "pinned" | "needs" | "working" | "idle";

export interface RemoteSession {
	id: string;
	label: string;
	cwd: string;
	band: RemoteBand;
	state: RowState;
	/** A pane's pi runs it; a stored row has no process. */
	alive: boolean;
	detail: string;
	createdAt?: string;
	finishedAt?: string;
	/** When its latest prompt was written, when its pane says: mid-turn, when its turn began. */
	turnStartedAt?: string;
	/** While it needs input: the dialog it waits on. */
	dialog?: { kind: string; title?: string };
	/** How many times it stopped working: the notifier's cue for a turn too quick to be seen working. */
	settled?: number;
	/** Set when more than one live pi writes this session's file: how many. */
	livePanes?: number;
	/** A pane is being started on it and has not registered yet. */
	starting?: true;
	/** Its pane's pi stopped beating while tmux still has its pane (the Mac slept, pi is held up):
	 *  shown as it last beat, alive. */
	silent?: true;
	verdict: ChatVerdict;
}

/** Whether a Chat may act on a row (its pane's pi takes a message), and why not: only a live pane's
 *  row may. A Silent pane's takes nothing until it answers. */
export type ChatVerdict = { act: true } | { act: false; reason: "silent" | "starting" | "not_running" };

function sessionRows(instances: InstanceSummary[]): AgentRow[] {
	return collectRows(instances, undefined).filter((row) => !row.shell);
}

/** The pane's pi listed as row `id`, live or silent. */
function paneOf(instances: InstanceSummary[], id: string): InstanceSummary | undefined {
	return instances.find((i) => i.id === id && i.external === true);
}

/** Computed from the row's state, so phone control and the phone's list cannot disagree. */
function verdictOf(row: AgentRow, pane: InstanceSummary | undefined): ChatVerdict {
	if (row.silent) return { act: false, reason: "silent" };
	if (pane) return { act: true };
	return { act: false, reason: row.starting ? "starting" : "not_running" };
}

/** In display order: agent view's state bands, each sorted as agent view sorts it. */
export function remoteSessions(instances: InstanceSummary[]): RemoteSession[] {
	const sessions: RemoteSession[] = [];
	for (const band of buildBands(sessionRows(instances), "state", (path) => path)) {
		for (const row of band.rows) {
			sessions.push({
				id: row.id,
				label: row.label,
				cwd: row.cwd,
				band: band.key as RemoteBand,
				state: row.state,
				alive: row.alive,
				detail: row.detail,
				createdAt: row.createdAt,
				finishedAt: row.finishedAt,
				turnStartedAt: row.turnStartedAt,
				...(row.dialog ? { dialog: row.dialog } : {}),
				...(row.settled !== undefined ? { settled: row.settled } : {}),
				...(row.livePanes ? { livePanes: row.livePanes } : {}),
				...(row.starting ? { starting: true } : {}),
				...(row.silent ? { silent: true } : {}),
				verdict: verdictOf(row, paneOf(instances, row.id)),
			});
		}
	}
	return sessions;
}

/** `verdict`: whether a message for its pi is taken, and why not (a silent pane's row has a pane
 *  all the same; a stored or starting one has none). `busy`: mid-turn, working or waiting on an
 *  answer. `pane`: the tmux session that pi registered from, if any. `draft`: its prompt held unsent
 *  text at its last heartbeat. `createdAt` and `sessionId`: its pane's start and pi's session id. */
export interface ListedSession {
	sessionFile?: string;
	cwd: string;
	verdict: ChatVerdict;
	busy: boolean;
	leafId?: string;
	pane?: string;
	draft?: boolean;
	createdAt?: string;
	sessionId?: string;
}

export function findSession(instances: InstanceSummary[], id: string): ListedSession | undefined {
	const row = sessionRows(instances).find((r) => r.id === id);
	if (!row) return undefined;
	const pane = paneOf(instances, id);
	return {
		sessionFile: row.sessionFile,
		cwd: row.cwd,
		verdict: verdictOf(row, pane),
		busy: row.state === "working" || row.state === "needs",
		...(pane?.leafId ? { leafId: pane.leafId } : {}),
		...(pane?.pane ? { pane: pane.pane } : {}),
		...(pane?.draft ? { draft: true } : {}),
		...(pane?.createdAt ? { createdAt: pane.createdAt } : {}),
		...(pane?.sessionId ? { sessionId: pane.sessionId } : {}),
	};
}
