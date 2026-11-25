import type { InstanceSummary } from "./ipc/protocol.ts";
import type { ShellInfo } from "./tmux.ts";
import { isRun } from "./types.ts";

export type RowState = "working" | "needs" | "idle" | "done" | "failed" | "stopped";

export interface AgentRow {
	id: string;
	label: string;
	cwd: string;
	sessionFile?: string;
	state: RowState;
	alive: boolean;
	detail: string;
	createdAt?: string;
	finishedAt?: string;
	turnStartedAt?: string;
	pinned: boolean;
	sortOrder?: number;
	self: boolean;
	pane?: string;
	shell?: string;
	updatedAt?: string;
	dialog?: { kind: string; title?: string };
	settled?: number;
	livePanes?: number;
	starting?: true;
	silent?: true;
	wakesAt?: number;
	unlisted?: true;
}

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

export function labelFromTask(task: string): string {
	const words = task.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "untitled session";
	const head = words.slice(0, 3).join(" ");
	const label = words.length > 3 ? `${head}…` : head;
	return label.length > 25 ? `${label.slice(0, 24)}…` : label;
}

const IDLE_LINE_WRITTEN_BY_VIEW = "";

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
	else if (state === "idle") detail = IDLE_LINE_WRITTEN_BY_VIEW;

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
		turnStartedAt: inst.turnStartedAt,
		pinned: inst.pinned === true,
		sortOrder: inst.sortOrder,
		self,
		pane: inst.pane,
		updatedAt: inst.lastSeenAt,
		...(state === "needs" && inst.dialog ? { dialog: inst.dialog } : {}),
		...(inst.settled !== undefined ? { settled: inst.settled } : {}),
		...(inst.status === "starting" ? { starting: true } : {}),
		...(inst.silent ? { silent: true } : {}),
		...(alive && stateBandOf({ state }) === "idle" && inst.wakesAt !== undefined ? { wakesAt: inst.wakesAt } : {}),
	};
}

export function collectRows(instances: InstanceSummary[], self: InstanceSummary | undefined): AgentRow[] {
	const registered = registeredRow(instances, self);
	const listed = instances.filter((i) => i !== registered && !isRun(i));
	const own =
		self && registered
			? { ...self, id: registered.id, pinned: registered.pinned, sortOrder: registered.sortOrder }
			: self?.pane !== undefined
				? { ...self, id: `self:${self.pane}` }
				: self;
	const summaries = own && !isRun(own) ? [own, ...listed] : listed;
	const rows = summaries.map((i) => rowFromSummary(i, own?.id));
	if (own && !isRun(own) && own !== self && !registered) rows[0] = { ...rows[0], unlisted: true };
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

function registeredRow(
	instances: InstanceSummary[],
	self: { id?: string; pane?: string } | undefined,
): InstanceSummary | undefined {
	return self?.pane !== undefined
		? instances.find((i) => i.external && i.pane === self.pane)
		: instances.find((i) => i.id === self?.id);
}

export function otherRows(instances: InstanceSummary[], pane: string): AgentRow[] {
	const own = registeredRow(instances, { pane });
	return collectRows(instances, undefined).filter((r) => r.id !== own?.id);
}

export function collectRuns(
	instances: InstanceSummary[],
	rows: AgentRow[],
	self?: InstanceSummary,
): Map<string, AgentRow[]> {
	const owners = new Map(rows.flatMap((row) => (row.pane && row.alive ? [[row.pane, row.id]] : [])));
	const runs = new Map<string, AgentRow[]>();
	for (const instance of instances) {
		const owner = instance.parent && owners.get(instance.parent);
		const own = self?.pane !== undefined && instance.external && instance.pane === self.pane;
		const run = owner ? rowFromSummary(instance, own ? instance.id : undefined) : undefined;
		if (owner && run?.alive) runs.set(owner, [...(runs.get(owner) ?? []), run]);
	}
	return runs;
}

export type ViewMode = "state" | "directory";

export interface Band {
	key: string;
	title: string;
	rows: AgentRow[];
	fixed: boolean;
}

export interface BandOptions {
	launcherCwd?: string;
	onboarding?: boolean;
}

const STATE_BANDS = [
	{ key: "needs", title: "Needs input" },
	{ key: "working", title: "Working" },
	{ key: "idle", title: "Idle" },
] as const;

export function stateBandOf(row: Pick<AgentRow, "state">): "needs" | "working" | "idle" {
	if (row.state === "needs") return "needs";
	if (row.state === "working") return "working";
	return "idle";
}

function stamp(iso: string | undefined): number {
	return iso ? Date.parse(iso) || 0 : 0;
}

function byRecency(rows: AgentRow[]): AgentRow[] {
	const at = (r: AgentRow) => stamp(stateBandOf(r) === "idle" ? (r.finishedAt ?? r.updatedAt) : r.updatedAt);
	return [...rows].sort((a, b) => at(b) - at(a) || stamp(b.createdAt) - stamp(a.createdAt));
}

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

export function nameScore(row: AgentRow, text: string): number {
	const match = /^n:(.*)$/i.exec(text.trim());
	const want = match?.[1].trim().toLowerCase();
	if (!want) return 0;
	const name = row.label.toLowerCase();
	return name === want ? 2 : name.includes(want) ? 1 : 0;
}

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

export function rowAge(row: AgentRow, nowMs: number): string {
	const midTurn = row.alive && (row.state === "working" || row.state === "needs");
	const since = (midTurn && stamp(row.turnStartedAt)) || stamp(row.createdAt);
	if (!since) return "";
	const end = !row.alive || row.state === "done" || row.state === "failed" ? stamp(row.finishedAt) || nowMs : nowMs;
	return compactAge(end - since);
}

export const STATE_WORDS: Record<RowState, string> = {
	working: "Working",
	needs: "Needs input",
	idle: "Idle",
	done: "Done",
	failed: "Failed",
	stopped: "Stopped",
};

export function livePanesWarning(n: number): string {
	return `⚠ ${n} panes on one session`;
}
