import type { InstanceSummary } from "../ipc/protocol.ts";
import { type AgentRow, buildBands, collectRows, type RowState } from "../rows.ts";

export type RemoteBand = "pinned" | "needs" | "working" | "idle";

export interface RemoteSession {
	id: string;
	label: string;
	cwd: string;
	band: RemoteBand;
	state: RowState;
	alive: boolean;
	detail: string;
	createdAt?: string;
	finishedAt?: string;
	turnStartedAt?: string;
	dialog?: { kind: string; title?: string };
	settledCount?: number;
	livePanes?: number;
	starting?: true;
	silent?: true;
	verdict: ChatVerdict;
}

export type ListedRemoteSession = RemoteSession & { actions: ChatActions };

export type ChatVerdict = { act: true } | { act: false; reason: "silent" | "starting" | "not_running" };

export type ChatAction = "message" | "settings" | "rename" | "pin" | "delete" | "tasks";

export type ActionVerdict =
	| { act: true }
	| { act: false; reason: Extract<ChatVerdict, { act: false }>["reason"] | "running" | "no_terminal" };

export type ChatActions = Record<ChatAction, ActionVerdict>;

function deleteVerdict(verdict: ChatVerdict): ActionVerdict {
	if (verdict.act || verdict.reason === "silent") return { act: false, reason: "running" };
	return verdict.reason === "starting" ? verdict : { act: true };
}

export function chatActions(verdict: ChatVerdict, terminalOpen: boolean): ChatActions {
	if (!terminalOpen) {
		const closed = { act: false, reason: "no_terminal" } as const;
		return { message: closed, settings: closed, rename: closed, pin: closed, delete: closed, tasks: closed };
	}
	const allowed = { act: true } as const;
	const silent = verdict.act === false && verdict.reason === "silent";
	return {
		message: verdict,
		settings: verdict,
		tasks: verdict,
		rename: silent ? verdict : allowed,
		pin: allowed,
		delete: deleteVerdict(verdict),
	};
}

function sessionRows(instances: InstanceSummary[]): AgentRow[] {
	return collectRows(instances, undefined).filter((row) => !row.shell);
}

function paneOf(instances: InstanceSummary[], id: string): InstanceSummary | undefined {
	return instances.find((i) => i.id === id && i.external === true);
}

function verdictOf(row: AgentRow, pane: InstanceSummary | undefined): ChatVerdict {
	if (row.silent) return { act: false, reason: "silent" };
	if (pane) return { act: true };
	return { act: false, reason: row.starting ? "starting" : "not_running" };
}

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
				...(row.settled !== undefined ? { settledCount: row.settled } : {}),
				...(row.livePanes ? { livePanes: row.livePanes } : {}),
				...(row.starting ? { starting: true } : {}),
				...(row.silent ? { silent: true } : {}),
				verdict: verdictOf(row, paneOf(instances, row.id)),
			});
		}
	}
	return sessions;
}

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
