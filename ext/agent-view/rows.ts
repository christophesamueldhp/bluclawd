/**
 * Agent view's data model: a session has one of six states, and its band says only whether it
 * is blocked on a prompt, running a turn, or idle; the band order puts what needs you on top. Pure — the view renders what these functions return.
 */

import type { InstanceSummary, PendingNeeds } from "./orchestrator-client.ts";

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
	/** The blocking prompt it is waiting on (answerable from the peek panel). */
	needs?: PendingNeeds;
	createdAt?: string;
	finishedAt?: string;
	pinned: boolean;
	sortOrder?: number;
	/** The foreground session this view was opened from — returned to, never stopped. */
	self: boolean;
	/** Open in another window's foreground — attaching here would make a second writer. */
	elsewhere: boolean;
	/** Pane mode: the tmux session its pi runs in. */
	pane?: string;
	updatedAt?: string;
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
		else if (inst.activity === "awaiting_input" || inst.needs) state = "needs";
		else if (inst.outcome === "failed") state = "failed";
		else if (inst.outcome === "stopped") state = "stopped";
		else if (inst.outcome === "done" || (inst.turns ?? 0) > 0) state = "done";
		else state = "idle";
	} else state = inst.outcome === "failed" ? "failed" : inst.outcome === "done" ? "done" : "stopped";

	let detail = inst.detail ?? "";
	if (inst.needs) detail = needsText(inst.needs);
	else if (inst.status === "starting") detail = "starting…";
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
		needs: inst.needs,
		createdAt: inst.createdAt,
		finishedAt: inst.finishedAt,
		pinned: inst.pinned === true,
		sortOrder: inst.sortOrder,
		self,
		elsewhere: false,
		pane: inst.pane,
		updatedAt: inst.lastSeenAt,
	};
}

function needsText(needs: PendingNeeds): string {
	return needs.message ? `${needs.title} — ${needs.message}` : needs.title;
}

/**
 * The rows agent view lists: the daemon's sessions, every pane's pi, and this window's own
 * (`self`, built by the caller). Other plain windows' sessions are not listed, but a stored row
 * they hold open is marked `elsewhere`. One row per session file; this window's own and then a
 * live one win over a stored twin.
 */
export function collectRows(instances: InstanceSummary[], self: InstanceSummary | undefined): AgentRow[] {
	const heldElsewhere = new Set(
		instances.filter((i) => i.external && i.id !== self?.id && i.sessionFile).map((i) => i.sessionFile),
	);
	const listed = instances.filter((i) => (!i.external || i.pane) && i.id !== self?.id);
	// A pane's own pin and order are kept by the daemon, on its registration.
	const registered = self && instances.find((i) => i.id === self.id);
	const own = self && registered ? { ...self, pinned: registered.pinned, sortOrder: registered.sortOrder } : self;
	const rows = (own ? [own, ...listed] : listed).map((i) => {
		const row = rowFromSummary(i, self?.id);
		if (!row.self && !row.pane && row.sessionFile && heldElsewhere.has(row.sessionFile)) {
			row.elsewhere = true;
			row.detail = "open in another terminal · enter moves it here";
		}
		return row;
	});
	const rank = (row: AgentRow): number => (row.self ? 0 : row.alive ? 1 : 2);
	const byFile = new Map<string, AgentRow>();
	const out: AgentRow[] = [];
	for (const row of rows) {
		if (!row.sessionFile) {
			out.push(row);
			continue;
		}
		const seen = byFile.get(row.sessionFile);
		if (!seen) {
			byFile.set(row.sessionFile, row);
			out.push(row);
			continue;
		}
		// The pin and manual order belong to the session, whichever twin is shown.
		const keep = rank(row) < rank(seen) ? row : seen;
		const merged = {
			...keep,
			pinned: row.pinned || seen.pinned,
			sortOrder: keep.sortOrder ?? (keep === row ? seen : row).sortOrder,
		};
		out[out.indexOf(seen)] = merged;
		byFile.set(row.sessionFile, merged);
	}
	return out;
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
	for (const row of rows) if (!row.id.startsWith("pending:")) counts[stateBandOf(row)]++;
	return counts;
}

const BAND_ALIASES: Record<ReturnType<typeof stateBandOf>, string[]> = {
	needs: ["blocked", "needs input", "input"],
	working: ["active", "working"],
	idle: ["idle", "completed", "done", "failed", "stopped"],
};

function stateMatches(row: AgentRow, want: string): boolean {
	return (
		row.state.startsWith(want) ||
		STATE_WORDS[row.state].toLowerCase().startsWith(want) ||
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

/** How well a row's name matches an `n:` query, as Claude Code ranks them: exact, then contains. */
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
	done: "Idle",
	failed: "Idle",
	stopped: "Idle",
};
