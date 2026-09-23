/**
 * Agent view's data model, as Claude Code 2.1.280 defines it: a session has one of six states,
 * the state decides its band, and the band order puts what needs you on top. Pure — the view
 * renders what these functions return.
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
	/** A free-text `needs input:` question. */
	question?: string;
	createdAt?: string;
	finishedAt?: string;
	pinned: boolean;
	sortOrder?: number;
	/** The foreground session this view was opened from — returned to, never stopped. */
	self: boolean;
	/** Open in another window's foreground — attaching here would make a second writer. */
	elsewhere: boolean;
	updatedAt?: string;
}

/** Claude Code's untitled-row fallback: the first three words of the task. */
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
		else if (inst.activity === "awaiting_input" || inst.needs || inst.question) state = "needs";
		else if (inst.outcome === "failed") state = "failed";
		else if (inst.outcome === "done" || (inst.turns ?? 0) > 0) state = "done";
		else state = "idle";
	} else state = inst.outcome === "failed" ? "failed" : inst.outcome === "done" ? "done" : "stopped";

	let detail = inst.detail ?? "";
	if (inst.needs) detail = needsText(inst.needs);
	else if (state === "needs" && inst.question) detail = inst.question;
	else if (inst.status === "starting") detail = "starting…";
	else if (state === "idle") detail = "space to send it a prompt";

	return {
		id: inst.id,
		label: inst.label?.trim() || (self ? "current session" : "untitled session"),
		cwd: inst.cwd,
		sessionFile: inst.sessionFile,
		state,
		alive,
		detail,
		needs: inst.needs,
		question: inst.question,
		createdAt: inst.createdAt,
		finishedAt: inst.finishedAt,
		pinned: inst.pinned === true,
		sortOrder: inst.sortOrder,
		self,
		elsewhere: false,
		updatedAt: inst.lastSeenAt,
	};
}

export function needsText(needs: PendingNeeds): string {
	return needs.message ? `${needs.title} — ${needs.message}` : needs.title;
}

/**
 * The rows agent view lists: the daemon's sessions plus this window's own (`self`, built by the
 * caller). Other windows' foreground sessions are not listed — Claude Code keeps those behind a
 * flag, off by default — but a stored row they hold open is marked `elsewhere`. One row per
 * session file; this window's own and then a live one win over a stored twin.
 */
export function collectRows(instances: InstanceSummary[], self: InstanceSummary | undefined): AgentRow[] {
	const heldElsewhere = new Set(
		instances.filter((i) => i.external && i.id !== self?.id && i.sessionFile).map((i) => i.sessionFile),
	);
	const listed = instances.filter((i) => !i.external);
	const rows = (self ? [self, ...listed] : listed).map((i) => {
		const row = rowFromSummary(i, self?.id);
		if (!row.self && row.sessionFile && heldElsewhere.has(row.sessionFile)) {
			row.elsewhere = true;
			row.detail = "open in another terminal · continue it there";
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
	/** Shown even when empty (the state view's three fixed bands). */
	fixed: boolean;
}

export const STATE_BANDS = [
	{ key: "needs", title: "Needs input" },
	{ key: "working", title: "Working" },
	{ key: "completed", title: "Completed" },
] as const;

export function stateBandOf(row: AgentRow): "needs" | "working" | "completed" {
	if (row.state === "needs" || row.state === "idle") return "needs";
	if (row.state === "working") return "working";
	return "completed";
}

function stamp(iso: string | undefined): number {
	return iso ? Date.parse(iso) || 0 : 0;
}

/** Manual order first (shift+↑/↓), then the most recently active. */
export function sortRows(rows: AgentRow[]): AgentRow[] {
	return [...rows].sort((a, b) => {
		if (a.sortOrder !== undefined || b.sortOrder !== undefined) {
			return (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER);
		}
		return stamp(b.finishedAt ?? b.updatedAt ?? b.createdAt) - stamp(a.finishedAt ?? a.updatedAt ?? a.createdAt);
	});
}

export function buildBands(rows: AgentRow[], mode: ViewMode, shortenPath: (p: string) => string): Band[] {
	const bands: Band[] = [];
	const pinned = rows.filter((r) => r.pinned);
	if (pinned.length) bands.push({ key: "pinned", title: "Pinned", rows: sortRows(pinned), fixed: false });
	const rest = rows.filter((r) => !r.pinned);
	if (mode === "state") {
		for (const band of STATE_BANDS) {
			bands.push({
				key: band.key,
				title: band.title,
				rows: sortRows(rest.filter((r) => stateBandOf(r) === band.key)),
				fixed: true,
			});
		}
		return bands;
	}
	const byDir = new Map<string, AgentRow[]>();
	for (const row of sortRows(rest)) {
		const list = byDir.get(row.cwd);
		if (list) list.push(row);
		else byDir.set(row.cwd, [row]);
	}
	for (const [cwd, list] of byDir)
		bands.push({ key: `dir:${cwd}`, title: shortenPath(cwd), rows: list, fixed: false });
	return bands;
}

export interface AgentCounts {
	needs: number;
	working: number;
	completed: number;
}

export function countRows(rows: AgentRow[]): AgentCounts {
	const counts = { needs: 0, working: 0, completed: 0 };
	// A session idling before its first prompt sits in the Needs input band but is not waiting on you.
	for (const row of rows) if (row.state !== "idle") counts[stateBandOf(row)]++;
	return counts;
}

/** The composer's `s:<state>` filter; undefined when the text is not a filter. */
export function stateFilter(text: string): ((row: AgentRow) => boolean) | undefined {
	const match = /^s:(\S*)$/i.exec(text.trim());
	if (!match) return undefined;
	const want = match[1].toLowerCase();
	if (!want) return () => true;
	return (row) => {
		if (want === "blocked" || want === "needs" || want === "input") return row.state === "needs";
		if (want === "completed") return stateBandOf(row) === "completed";
		return row.state.startsWith(want);
	};
}

/** Largest unit only, as agent view prints ages: `42s`, `4m`, `3h`, `2d`. */
export function compactAge(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
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
