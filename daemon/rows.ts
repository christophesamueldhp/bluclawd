/**
 * Agent view's data model: a session has one of six states, and its band says only whether it
 * is blocked on a prompt, running a turn, or idle; the band order puts what needs you on top. Pure — the view renders what these functions return.
 */

import type { InstanceSummary } from "./ipc/protocol.ts";
import type { ShellInfo } from "./tmux.ts";

export type RowState = "working" | "needs" | "idle" | "done" | "failed" | "stopped";

export interface AgentRow {
	id: string;
	/** Display name: the session's name, or the first words of its task. */
	label: string;
	cwd: string;
	sessionFile?: string;
	state: RowState;
	/** Whether a process is running it (✻ / spinner) or not (∙). */
	alive: boolean;
	detail: string;
	createdAt?: string;
	finishedAt?: string;
	pinned: boolean;
	sortOrder?: number;
	/** The foreground session this view was opened from — returned to, never stopped. */
	self: boolean;
	/** Pane mode: the tmux session its pi runs in. */
	pane?: string;
	/** A `!` command's tmux session: the row is the command, not a pi session. */
	shell?: string;
	updatedAt?: string;
	/** Needs input: the dialog it waits on, when its pane says. */
	dialog?: { kind: string; title?: string };
	/** A pane's pi: how many times it stopped working (the daemon counts). */
	settled?: number;
	/** Set when more than one live pi writes this row's session file: how many. */
	livePanes?: number;
	/** A pane is being started on it and has not registered yet. */
	starting?: true;
	/** Its pane's pi stopped beating while tmux still has its pane: shown as it last beat. */
	silent?: true;
}

/** A `!` command as a row, as bluclawd's: working while it runs (its last output line the
 *  detail), then done, failed with its exit status, or stopped. */
export function rowFromShell(info: ShellInfo): AgentRow {
	const last = info.lastLine?.trim() || undefined;
	let state: RowState = "working";
	let detail = last ?? "";
	if (info.stopped && info.exit !== undefined) {
		state = "stopped";
		detail = "stopped";
	} else if (info.exit === "0") {
		state = "done";
		detail = last ?? "(no output)";
	} else if (info.exit !== undefined) {
		state = "failed";
		detail = last ? `exit ${info.exit} — ${last}` : `exit ${info.exit}`;
	}
	return {
		id: info.name,
		label: labelFromTask(`!${info.command}`),
		cwd: info.cwd,
		state,
		alive: info.exit === undefined,
		detail,
		createdAt: info.createdAt,
		pinned: false,
		self: false,
		shell: info.name,
	};
}

/** Untitled-row fallback: the first three words of the task. */
export function labelFromTask(task: string): string {
	const words = task.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "untitled session";
	const head = words.slice(0, 3).join(" ");
	const label = words.length > 3 ? `${head}…` : head;
	return label.length > 25 ? `${label.slice(0, 24)}…` : label;
}

export function rowFromSummary(inst: InstanceSummary, selfId: string | undefined): AgentRow {
	const self = inst.id === selfId;
	const alive = inst.status === "online" || inst.status === "starting" || inst.status === "stopping";
	let state: RowState;
	if (inst.status === "starting") state = "working";
	else if (alive) {
		if (inst.activity === "working") state = "working";
		else if (inst.activity === "awaiting_input") state = "needs";
		else if (inst.outcome === "failed") state = "failed";
		else if (inst.outcome === "stopped") state = "stopped";
		else if (inst.outcome === "done" || (inst.turns ?? 0) > 0) state = "done";
		else state = "idle";
	} else state = inst.outcome === "failed" ? "failed" : inst.outcome === "done" ? "done" : "stopped";

	let detail = inst.detail ?? "";
	if (inst.status === "starting") detail = "starting…";
	// An idle session's line depends on focus, so the view writes it.
	else if (state === "idle") detail = "";

	return {
		id: inst.id,
		label:
			inst.label?.trim() || (self ? "current session" : state === "working" ? "new session" : "untitled session"),
		cwd: inst.cwd,
		sessionFile: inst.sessionFile,
		state,
		alive,
		detail,
		createdAt: inst.createdAt,
		finishedAt: inst.finishedAt,
		pinned: inst.pinned === true,
		sortOrder: inst.sortOrder,
		self,
		pane: inst.pane,
		updatedAt: inst.lastSeenAt,
		...(state === "needs" && inst.dialog ? { dialog: inst.dialog } : {}),
		...(inst.settled !== undefined ? { settled: inst.settled } : {}),
		...(inst.status === "starting" ? { starting: true } : {}),
		...(inst.silent ? { silent: true } : {}),
	};
}

/**
 * The rows agent view lists: the daemon's, one per session, and this window's own (`self`, built by
 * the caller) in place of the row its pane is listed as. Live pis sharing a file are flagged with
 * `livePanes`.
 */
export function collectRows(instances: InstanceSummary[], self: InstanceSummary | undefined): AgentRow[] {
	// Its pane is listed under its id, or under the row of the session it resumed.
	const ownRow = (i: InstanceSummary) => i.id === self?.id || (self?.pane !== undefined && i.pane === self.pane);
	// A run is reached from its orchestrator, never listed.
	const listed = instances.filter((i) => !ownRow(i) && !i.parent);
	// A pane's own pin and order are kept by the daemon, on its registration.
	const registered = instances.find(ownRow);
	const own = self && registered ? { ...self, pinned: registered.pinned, sortOrder: registered.sortOrder } : self;
	const summaries = own ? [own, ...listed] : listed;
	const rows = summaries.map((i) => rowFromSummary(i, self?.id));
	// Only a registered, running pi writes the file: `starting` and `stopping` rows are alive but not yet, or no longer.
	const live = new Set(summaries.filter((i) => i.status === "online" && i.sessionFile).map((i) => i.id));
	const livePanes = new Map<string, number>();
	for (const row of rows)
		if (row.sessionFile && live.has(row.id))
			livePanes.set(row.sessionFile, (livePanes.get(row.sessionFile) ?? 0) + 1);
	return rows.map((row) => {
		const n = row.sessionFile && live.has(row.id) ? (livePanes.get(row.sessionFile) ?? 0) : 0;
		return n > 1 ? { ...row, livePanes: n } : row;
	});
}

export type ViewMode = "state" | "directory";

export interface Band {
	key: string;
	title: string;
	rows: AgentRow[];
	/** Shown even when empty: onboarding's three state bands, the launcher's directory. */
	fixed: boolean;
}

export interface BandOptions {
	/** The directory agent view was opened in: its band comes first, and shows even when empty. */
	launcherCwd?: string;
	/** Nothing but this window's own session is listed: every state band shows, with a hint. */
	onboarding?: boolean;
}

const STATE_BANDS = [
	{ key: "needs", title: "Needs input" },
	{ key: "working", title: "Working" },
	{ key: "idle", title: "Idle" },
] as const;

export function stateBandOf(row: AgentRow): "needs" | "working" | "idle" {
	if (row.state === "needs") return "needs";
	if (row.state === "working") return "working";
	return "idle";
}

function stamp(iso: string | undefined): number {
	return iso ? Date.parse(iso) || 0 : 0;
}

/** The state view: manual order (shift+↑/↓) first, then the most recently active. A finished
 *  run counts from when it finished, anything else from its last activity. */
function byRecency(rows: AgentRow[]): AgentRow[] {
	const at = (r: AgentRow) => stamp(stateBandOf(r) === "idle" ? (r.finishedAt ?? r.updatedAt) : r.updatedAt);
	return [...rows].sort((a, b) => {
		if (a.sortOrder !== undefined || b.sortOrder !== undefined) {
			return (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER);
		}
		return at(b) - at(a) || stamp(b.createdAt) - stamp(a.createdAt);
	});
}

/** The directory view and the Pinned band: manual order, else oldest first. */
function byCreation(rows: AgentRow[]): AgentRow[] {
	const key = (r: AgentRow) => r.sortOrder ?? stamp(r.createdAt);
	return [...rows].sort((a, b) => key(a) - key(b));
}

export function buildBands(
	rows: AgentRow[],
	mode: ViewMode,
	shortenPath: (p: string) => string,
	options: BandOptions = {},
): Band[] {
	const bands: Band[] = [];
	const pinned = rows.filter((r) => r.pinned);
	if (pinned.length) bands.push({ key: "pinned", title: "Pinned", rows: byCreation(pinned), fixed: false });
	const rest = rows.filter((r) => !r.pinned);
	if (mode === "state") {
		for (const band of STATE_BANDS) {
			const list = byRecency(rest.filter((r) => stateBandOf(r) === band.key));
			if (list.length || options.onboarding) {
				bands.push({ key: band.key, title: band.title, rows: list, fixed: !!options.onboarding });
			}
		}
		return bands;
	}
	const byDir = new Map<string, AgentRow[]>();
	const launcher = options.launcherCwd;
	// The launcher's directory is where a new session starts, so it is listed even with no rows.
	if (launcher && rows.length > 0) byDir.set(launcher, []);
	for (const row of byCreation(rest)) {
		const list = byDir.get(row.cwd);
		if (list) list.push(row);
		else byDir.set(row.cwd, [row]);
	}
	const dirs = [...byDir.keys()].sort((a, b) => (a === launcher ? -1 : b === launcher ? 1 : a.localeCompare(b)));
	for (const cwd of dirs) {
		const list = byDir.get(cwd) ?? [];
		bands.push({ key: `dir:${cwd}`, title: shortenPath(cwd), rows: list, fixed: cwd === launcher });
	}
	return bands;
}

export interface AgentCounts {
	needs: number;
	working: number;
	idle: number;
}

export function countRows(rows: AgentRow[]): AgentCounts {
	const counts = { needs: 0, working: 0, idle: 0 };
	for (const row of rows) if (!row.starting) counts[stateBandOf(row)]++;
	return counts;
}

const BAND_ALIASES: Record<ReturnType<typeof stateBandOf>, string[]> = {
	needs: ["blocked", "needs input", "input"],
	working: ["active", "working"],
	idle: ["idle"],
};

function stateMatches(row: AgentRow, want: string): boolean {
	return (
		row.state.startsWith(want) ||
		STATE_WORDS[row.state].toLowerCase().startsWith(want) ||
		(row.state === "done" && "completed".startsWith(want)) ||
		BAND_ALIASES[stateBandOf(row)].some((alias) => alias.startsWith(want))
	);
}

/**
 * The composer as a filter: text that starts with `s:<state>` or `n:<name>`. Further words
 * narrow it — `s:` tokens by state, the rest by name (after `n:`) or name and detail.
 * Undefined when the text is a task instead.
 */
export function queryFilter(text: string): ((row: AgentRow) => boolean) | undefined {
	const trimmed = text.trim();
	if (!/^[sn]:/i.test(trimmed)) return undefined;
	const states: string[] = [];
	const words: string[] = [];
	let byName = false;
	for (const token of trimmed.toLowerCase().split(/\s+/)) {
		if (token.startsWith("s:")) states.push(token.slice(2));
		else if (token.startsWith("n:")) {
			byName = true;
			if (token.length > 2) words.push(token.slice(2));
		} else words.push(token);
	}
	return (row) => {
		if (!states.every((want) => !want || stateMatches(row, want))) return false;
		const haystack = (byName ? row.label : `${row.label} ${row.detail}`).toLowerCase();
		return words.every((word) => haystack.includes(word));
	};
}

/** How well a row's name matches an `n:` query, as bluclawd ranks them: exact, then contains. */
export function nameScore(row: AgentRow, text: string): number {
	const match = /^n:(.*)$/i.exec(text.trim());
	const want = match?.[1].trim().toLowerCase();
	if (!want) return 0;
	const name = row.label.toLowerCase();
	return name === want ? 2 : name.includes(want) ? 1 : 0;
}

/** Largest unit only, as agent view prints ages: `42s`, `4m`, `3h`, `2d`. From a minute up the
 *  seconds round, carrying into the larger units (1m59.6s is `2m`). */
export function compactAge(ms: number): string {
	const exact = Math.max(0, ms / 1000);
	if (exact < 60) return `${Math.floor(exact)}s`;
	const seconds = Math.round(exact);
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** Age counts from creation; a finished run's age freezes at how long it took. */
export function rowAge(row: AgentRow, nowMs: number): string {
	const created = stamp(row.createdAt);
	if (!created) return "";
	const end = !row.alive || row.state === "done" || row.state === "failed" ? stamp(row.finishedAt) || nowMs : nowMs;
	return compactAge(end - created);
}

export const STATE_WORDS: Record<RowState, string> = {
	working: "Working",
	needs: "Needs input",
	idle: "Idle",
	done: "Done",
	failed: "Failed",
	stopped: "Stopped",
};

/** A row's warning when several live pis write its session file; the phone mirrors it. */
export function livePanesWarning(n: number): string {
	return `⚠ ${n} panes on one session`;
}
