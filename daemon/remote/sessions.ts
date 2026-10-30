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
	/** pi's session id: the same session under another row id, once it quits on the Mac or resumes. */
	sessionId?: string;
	/** While it needs input: the dialog it waits on. */
	dialog?: { kind: string; title?: string };
	/** How many times it stopped working: the notifier's cue for a turn too quick to be seen working. */
	settled?: number;
}

function sessionRows(instances: InstanceSummary[]): AgentRow[] {
	return collectRows(instances, undefined).filter((row) => !row.shell && !row.id.startsWith("pending:"));
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
				sessionId: row.sessionId,
				...(row.dialog ? { dialog: row.dialog } : {}),
				...(row.settled !== undefined ? { settled: row.settled } : {}),
			});
		}
	}
	return sessions;
}

/** `running`: a pane's pi is registered as this id, so a queued message reaches it. `busy`: mid-turn,
 *  working or waiting on an answer. `pane`: the tmux session that pi registered from, if any.
 *  `draft`: its prompt held unsent text at its last heartbeat. `createdAt` and `sessionId`: its
 *  pane's start and pi's session id. */
export interface ListedSession {
	sessionFile?: string;
	cwd: string;
	running: boolean;
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
	const pane = instances.find((i) => i.id === id && i.external === true);
	return {
		sessionFile: row.sessionFile,
		cwd: row.cwd,
		running: pane !== undefined,
		busy: row.state === "working" || row.state === "needs",
		...(pane?.leafId ? { leafId: pane.leafId } : {}),
		...(pane?.pane ? { pane: pane.pane } : {}),
		...(pane?.draft ? { draft: true } : {}),
		...(pane?.createdAt ? { createdAt: pane.createdAt } : {}),
		...(pane?.sessionId ? { sessionId: pane.sessionId } : {}),
	};
}
