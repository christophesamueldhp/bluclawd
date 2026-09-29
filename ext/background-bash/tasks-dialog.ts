/**
 * The interactive `/tasks` dialog: shells, monitors and subagent runs of this
 * session in sections, a detail view with the tail of the output file, and stop.
 * Rows are re-read on every render, so the dialog stays live while it is open.
 *
 * Laid out as Claude Code's Background dialog: a blank line, a rule in the
 * background colour, then the body two columns in, and the key hints dim and
 * italic below it. There is no bottom rule.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getKeybindings,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { agentTasks } from "../_shared/agent-tasks.ts";
import { stripAnsi } from "../_shared/ansi.ts";
import { type BackgroundJobInfo, backgroundBashJobs, jobOutcome } from "../_shared/background-bash.ts";
import { formatClaudeDuration } from "../_shared/bash-limits.ts";

/** The detail view reads the file's last 8 KiB and shows its last 10 lines. */
const DETAIL_TAIL_BYTES = 8192;
const DETAIL_TAIL_LINES = 10;
const MAX_COMMAND_CHARS = 280;
/** The body sits this many columns in from each side. */
const PAD = 2;
/** Between a label and its value in the detail view's table. */
const TABLE_GAP = 2;
/** Between a row's label column and its status. */
const META_GAP = 3;
/** The list shows at least this many lines before it scrolls. */
const MIN_VISIBLE_LINES = 7;

/** The focused row's colour. */
const SUGGESTION = (text: string) => `\x1b[38;2;177;185;249m${text}\x1b[39m`;
/** The dialog's rule, titles and a running status. */
const BACKGROUND = (text: string) => `\x1b[38;2;0;204;204m${text}\x1b[39m`;
const ITALIC = (text: string) => `\x1b[3m${text}\x1b[23m`;
const POINTER = "❯";
/** A running task's icon (`⏺` on macOS, `●` elsewhere). */
const RUNNING_ICON = process.platform === "darwin" ? "⏺" : "●";

type TaskKind = "shell" | "monitor" | "agent";
type TaskState = "running" | "completed" | "failed" | "killed";

export interface TaskRow {
	id: string;
	kind: TaskKind;
	label: string;
	state: TaskState;
	startedAt: number;
	endedAt?: number;
	job?: BackgroundJobInfo;
}

/** Every task of the session `owner`, newest first. */
export function taskRows(owner: string | undefined): TaskRow[] {
	// A subagent's shells are listed too.
	const jobs = backgroundBashJobs
		.list()
		.filter((job) => owner === undefined || job.owner === owner || job.agentId !== undefined);
	const shells: TaskRow[] = jobs.map((job) => ({
		id: job.id,
		kind: job.kind === "monitor" ? "monitor" : "shell",
		// A shell shows its command, a monitor its description.
		label: job.kind === "monitor" ? job.description?.trim() || job.command : job.command,
		state: jobOutcome(job).state,
		startedAt: job.startedAt,
		endedAt: job.exit?.at,
		job,
	}));
	const agents: TaskRow[] = (agentTasks()?.list() ?? []).map((run) => ({
		id: run.id,
		kind: "agent",
		label: `${run.agent}: ${run.task}`,
		state: "running",
		startedAt: run.startedAt,
	}));
	// Reversed first: the sort is stable, so tasks started in the same millisecond stay newest first.
	return [...shells, ...agents].reverse().sort((a, b) => b.startedAt - a.startedAt);
}

/** `512 bytes`, `8.2KB`, `3MB`: a trailing `.0` is dropped. */
function formatSize(bytes: number): string {
	const kb = bytes / 1024;
	if (kb < 1) return `${bytes} bytes`;
	if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, "")}KB`;
	const mb = kb / 1024;
	if (mb < 1024) return `${mb.toFixed(1).replace(/\.0$/, "")}MB`;
	return `${(mb / 1024).toFixed(1).replace(/\.0$/, "")}GB`;
}

const clean = (s: string) => stripAnsi(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/**
 * The last lines of a job's output file (its memory copy when there is no file), the
 * file's size, and how many bytes of it were read. As Claude Code counts them: the
 * last ten newline-separated pieces, empty ones dropped, so output that ends in a
 * newline shows nine.
 */
function outputTail(job: BackgroundJobInfo): { lines: string[]; size: number; read: number } {
	let text = "";
	let size = 0;
	if (job.outputFile) {
		try {
			size = statSync(job.outputFile).size;
			const length = Math.min(size, DETAIL_TAIL_BYTES);
			const buffer = Buffer.alloc(length);
			const fd = openSync(job.outputFile, "r");
			try {
				readSync(fd, buffer, 0, length, size - length);
			} finally {
				closeSync(fd);
			}
			text = buffer.toString("utf-8");
			// The write stream flushes asynchronously: output that has not reached the file yet is still in memory.
			if (size === 0) {
				text = backgroundBashJobs.peek(job.id) ?? "";
				size = Buffer.byteLength(text);
			}
		} catch {
			text = backgroundBashJobs.peek(job.id) ?? "";
			size = Buffer.byteLength(text);
		}
	} else {
		text = backgroundBashJobs.peek(job.id) ?? "";
		size = Buffer.byteLength(text);
	}
	const pieces = text.split("\n").slice(-DETAIL_TAIL_LINES);
	const lines = pieces.filter((line) => line !== "").map((line) => clean(line.replace(/\r$/, "")));
	return { lines, size, read: Buffer.byteLength(text) };
}

/** Stops a task as the user; the model is told. */
function stopTask(row: TaskRow): void {
	if (row.kind === "agent") agentTasks()?.stop(row.id);
	else backgroundBashJobs.kill(row.id, { byUser: true });
}

/** Sections, in display order: a shell's section holds its command monitors too. */
type Section = "shells" | "monitors" | "agents";
const SECTIONS: [Section, string][] = [
	["shells", "Shells"],
	["monitors", "Monitors"],
	["agents", "Local agents"],
];

function sectionOf(row: TaskRow): Section {
	if (row.kind === "agent") return "agents";
	return row.id.startsWith("s") ? "monitors" : "shells";
}

/** A WebSocket monitor has no detail view. */
const hasDetail = (row: TaskRow) => sectionOf(row) !== "monitors";

/** The tasks the dialog lists: running ones only, in section order, newest first within each. */
function visibleRows(owner: string | undefined): TaskRow[] {
	const rows = taskRows(owner).filter((row) => row.state === "running");
	return SECTIONS.flatMap(([section]) => rows.filter((row) => sectionOf(row) === section));
}

/** A row's status beside its label, as Claude Code words it. */
const META: Record<TaskState, string> = {
	running: "running",
	completed: "done",
	failed: "error",
	killed: "stopped",
};

type ListLine = { kind: "gap" } | { kind: "heading"; text: string } | { kind: "row"; row: TaskRow; index: number };

export interface TasksDialogOptions {
	notify?: (message: string) => void;
	held?: () => string | undefined;
	/** The terminal's height, which sets how many lines the list shows before it scrolls. */
	rows?: () => number;
}

export class TasksDialog implements Component {
	/** The focused task, by id so it stays put as others start and end; its index is the fallback. */
	private focusId: string | undefined;
	private focusIndex = 0;
	/** The focused task ended since it was focused: the next `x` would stop whatever slid under the cursor. */
	private focusLost = false;
	private windowStart = 0;
	private detail: string | undefined;
	/** The detail view was opened straight away, the dialog holding a single task. */
	private direct = false;
	private readonly theme: Theme;
	private readonly owner: string | undefined;
	private readonly done: () => void;
	private readonly requestRender: () => void;
	private readonly notify: (message: string) => void;
	private readonly held: () => string | undefined;
	private readonly terminalRows: (() => number) | undefined;

	constructor(
		theme: Theme,
		owner: string | undefined,
		done: () => void,
		requestRender: () => void,
		options: TasksDialogOptions = {},
	) {
		this.theme = theme;
		this.owner = owner;
		this.done = done;
		this.requestRender = requestRender;
		this.notify = options.notify ?? (() => {});
		this.held = options.held ?? (() => undefined);
		this.terminalRows = options.rows;
		// With one task to show, open straight to it.
		const rows = visibleRows(owner);
		if (rows.length === 1 && hasDetail(rows[0])) {
			this.detail = rows[0].id;
			this.direct = true;
		}
	}

	invalidate(): void {}

	/** The focused row's index, following its id; notes when that task is gone. */
	private cursor(rows: TaskRow[]): number {
		if (rows.length === 0) return 0;
		const byId = this.focusId === undefined ? -1 : rows.findIndex((r) => r.id === this.focusId);
		if (byId >= 0) {
			this.focusIndex = byId;
			return byId;
		}
		if (this.focusId !== undefined) this.focusLost = true;
		this.focusIndex = Math.min(this.focusIndex, rows.length - 1);
		this.focusId = rows[this.focusIndex].id;
		return this.focusIndex;
	}

	private focus(rows: TaskRow[], index: number): void {
		this.focusIndex = Math.max(0, Math.min(rows.length - 1, index));
		this.focusId = rows[this.focusIndex]?.id;
		this.focusLost = false;
	}

	/** Leaves the detail view: back to the list, or out of the dialog when it was opened straight to it. */
	private leaveDetail(rows: TaskRow[]): void {
		this.detail = undefined;
		if (this.direct && rows.length <= 1) this.done();
		this.direct = false;
	}

	private closeFromDetail(): void {
		this.notify("Shell details dismissed");
		this.done();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const rows = visibleRows(this.owner);
		if (this.detail !== undefined) {
			const row = rows.find((r) => r.id === this.detail);
			if (matchesKey(data, "left")) this.leaveDetail(rows);
			else if (kb.matches(data, "tui.select.cancel") || data === "\r" || data === " ") {
				this.closeFromDetail();
				return;
			} else if (data === "x" && row?.state === "running") stopTask(row);
			this.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (rows.length === 0) return;
		const index = this.cursor(rows);
		const current = rows[index];
		if (kb.matches(data, "tui.select.up")) this.focus(rows, index - 1);
		else if (kb.matches(data, "tui.select.down")) this.focus(rows, index + 1);
		else if (data === "\r" && hasDetail(current)) this.detail = current.id;
		else if (data === "x") {
			// The task under the cursor is not the one that was focused: swallow this one press.
			if (this.focusLost) this.focusLost = false;
			else stopTask(current);
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const rows = visibleRows(this.owner);
		if (this.detail !== undefined) {
			const row = rows.find((r) => r.id === this.detail);
			if (row) return this.frame(width, this.renderDetail(row, width - 2 * PAD), this.detailHints(row));
			// The task ended while on screen: a dialog opened straight to it closes, else back to the list.
			if (this.direct) {
				this.detail = undefined;
				this.direct = false;
				this.done();
				return [];
			}
			this.detail = undefined;
		}
		return this.frame(width, this.renderList(rows, width - 2 * PAD), this.listHints(rows));
	}

	/** Claude Code's dialog frame: a blank line, the rule, the body two columns in, then the hints. */
	private frame(width: number, body: string[], hints: string[]): string[] {
		const t = this.theme;
		const pad = " ".repeat(PAD);
		const inner = Math.max(1, width - 2 * PAD);
		const held = this.held();
		const out = ["", BACKGROUND("─".repeat(Math.max(0, width)))];
		for (const line of body) out.push(line === "" ? "" : truncateToWidth(`${pad}${line}`, width, "…"));
		out.push("");
		if (held) out.push(truncateToWidth(`${pad}${t.fg("dim", held)}`, width, "…"));
		out.push(`${pad}${truncateToWidth(t.fg("dim", ITALIC(hints.join(" · "))), inner, "…")}`);
		return out;
	}

	/** Title in bold background colour, an optional dim subtitle, a blank line, then the content. */
	private titled(title: string, subtitle: string | undefined, content: string[]): string[] {
		const t = this.theme;
		const out = [t.bold(BACKGROUND(title))];
		if (subtitle) out.push(t.fg("dim", subtitle));
		out.push("", ...content);
		return out;
	}

	private listHints(rows: TaskRow[]): string[] {
		const current = rows.length > 0 ? rows[this.cursor(rows)] : undefined;
		return [
			"↑/↓ to select",
			...(!current || hasDetail(current) ? ["Enter to view"] : []),
			...(current ? ["x to stop"] : []),
			"Esc to close",
		];
	}

	private detailHints(row: TaskRow): string[] {
		return ["← to go back", "Esc/Enter/Space to close", ...(row.state === "running" ? ["x to stop"] : [])];
	}

	private renderList(rows: TaskRow[], width: number): string[] {
		const t = this.theme;
		const count = (section: Section) => rows.filter((r) => sectionOf(r) === section).length;
		const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
		const shells = count("shells");
		const agents = count("agents");
		const subtitle = [
			shells ? plural(shells, "active shell", "active shells") : "",
			agents ? plural(agents, "active agent", "active agents") : "",
		]
			.filter(Boolean)
			.join(" · ");
		if (rows.length === 0) return this.titled("Background", subtitle, [t.fg("dim", "No tasks currently running")]);

		const cursor = this.cursor(rows);
		const lines: ListLine[] = [];
		let index = 0;
		for (const [section, title] of SECTIONS) {
			const items = rows.filter((r) => sectionOf(r) === section);
			if (items.length === 0) continue;
			if (lines.length > 0) lines.push({ kind: "gap" });
			// The Shells header only when the list holds agents too.
			if (section !== "shells" || agents > 0) {
				lines.push({ kind: "heading", text: `${t.bold(title)}${t.fg("dim", ` (${items.length})`)}` });
			}
			for (const row of items) lines.push({ kind: "row", row, index: index++ });
		}

		// Pointer, icon, label and status. The status sits in a column past the longest
		// label when that fits the width; otherwise the label is cut and the status
		// pushed to the right edge.
		const labels = rows.map((r) => clean(r.label));
		const labelWidth = Math.max(0, ...labels.map(visibleWidth));
		const metaWidth = Math.max(0, ...rows.map((r) => visibleWidth(META[r.state])));
		const rowWidth = Math.max(1, width - 2);
		const columns = 2 + labelWidth + META_GAP + metaWidth <= rowWidth;

		const renderRow = (row: TaskRow, i: number) => {
			const focused = i === cursor;
			const pointer = focused ? SUGGESTION(POINTER) : " ";
			const icon = row.state === "running" ? t.fg("dim", RUNNING_ICON) : " ";
			const meta = META[row.state];
			const room = columns ? labelWidth : Math.max(1, rowWidth - 2 - META_GAP - visibleWidth(meta));
			const label = truncateToWidth(labels[i], room, "…");
			const gap = columns
				? labelWidth + META_GAP - visibleWidth(label)
				: rowWidth - 2 - visibleWidth(label) - visibleWidth(meta);
			const shown = focused ? SUGGESTION(label) : label;
			return `${pointer} ${icon} ${shown}${" ".repeat(Math.max(1, gap))}${t.fg("dim", meta)}`;
		};
		const renderLine = (line: ListLine) => {
			if (line.kind === "gap") return "";
			if (line.kind === "heading") return `  ${t.fg("dim", line.text)}`;
			return renderRow(line.row, line.index);
		};

		// Taller than the window: a slice around the cursor, with counts of the rows beyond it.
		const terminal = this.terminalRows?.();
		const visible =
			terminal === undefined
				? lines.length
				: Math.min(lines.length, Math.max(MIN_VISIBLE_LINES, Math.floor(terminal / 2)));
		if (lines.length <= visible) return this.titled("Background", subtitle, lines.map(renderLine));
		const size = Math.max(1, visible - 2);
		const at = lines.findIndex((l) => l.kind === "row" && l.index === cursor);
		if (at < this.windowStart) this.windowStart = at;
		if (at >= this.windowStart + size) this.windowStart = at - size + 1;
		this.windowStart = Math.max(0, Math.min(this.windowStart, lines.length - size));
		const rowsIn = (from: number, to: number) => lines.slice(from, to).filter((l) => l.kind === "row").length;
		const above = rowsIn(0, this.windowStart);
		const below = rowsIn(this.windowStart + size, lines.length);
		const content = [
			...(above > 0 ? [`  ${t.fg("dim", `↑ ${above} more above`)}`] : []),
			...lines.slice(this.windowStart, this.windowStart + size).map(renderLine),
			...(below > 0 ? [`  ${t.fg("dim", `↓ ${below} more below`)}`] : []),
		];
		return this.titled("Background", subtitle, content);
	}

	private renderDetail(row: TaskRow, width: number): string[] {
		const t = this.theme;
		const monitor = row.job?.kind === "monitor";
		const title = row.kind === "agent" ? "Agent details" : monitor ? "Monitor details" : "Shell details";
		const code = row.job?.exit?.code;
		const statusText = `${row.state}${code !== undefined && code !== null ? ` (exit code: ${code})` : ""}`;
		const status =
			row.state === "running"
				? BACKGROUND(statusText)
				: t.fg(row.state === "completed" ? "success" : "error", statusText);
		const fields: [string, string][] = [
			["Status:", status],
			["Runtime:", formatClaudeDuration((row.endedAt ?? Date.now()) - row.startedAt)],
		];
		if (row.job) {
			const command = clean(row.job.command);
			fields.push([
				monitor ? "Script:" : "Command:",
				command.length > MAX_COMMAND_CHARS ? `${command.slice(0, MAX_COMMAND_CHARS)}…` : command,
			]);
		} else fields.push(["Task:", clean(row.label)]);

		// A table two columns narrower than the body: labels bold in a column as wide as
		// the widest, values wrapped beside them.
		const labelWidth = Math.max(...fields.map(([name]) => visibleWidth(name)));
		const valueWidth = Math.max(1, width - 2 - labelWidth - TABLE_GAP);
		const table: string[] = [];
		for (const [name, value] of fields) {
			const wrapped = wrapTextWithAnsi(value, valueWidth);
			const lead = `${t.bold(name)}${" ".repeat(labelWidth - visibleWidth(name) + TABLE_GAP)}`;
			const indent = " ".repeat(labelWidth + TABLE_GAP);
			for (const [i, part] of wrapped.entries()) table.push(`${i === 0 ? lead : indent}${part}`);
		}
		if (!row.job) return this.titled(title, undefined, table);

		const out = [...table, "", t.bold("Output:")];
		const { lines, size, read } = outputTail(row.job);
		if (lines.length === 0) {
			out.push(t.fg("dim", "No output available"));
			return this.titled(title, undefined, out);
		}
		// A rounded box twelve rows high, two columns narrower than the body.
		const boxWidth = Math.max(6, width - 2);
		const text = boxWidth - 4;
		out.push(`╭${"─".repeat(boxWidth - 2)}╮`);
		for (let i = 0; i < DETAIL_TAIL_LINES; i++) {
			const line = truncateToWidth(lines[i] ?? "", text, "…");
			out.push(`│ ${line}${" ".repeat(Math.max(0, text - visibleWidth(line)))} │`);
		}
		out.push(`╰${"─".repeat(boxWidth - 2)}╯`);
		out.push(t.fg("dim", ITALIC(`Showing ${lines.length} lines${size > read ? ` of ${formatSize(size)}` : ""}`)));
		return this.titled(title, undefined, out);
	}
}
