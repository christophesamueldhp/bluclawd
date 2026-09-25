/**
 * The interactive `/tasks` dialog, laid out as Claude Code's "Background" dialog:
 * shells, monitors and subagent runs of this session in sections, a detail view
 * with the tail of the output file, and stop. Rows are re-read on every render,
 * so the dialog stays live while it is open.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { agentTasks } from "../_shared/agent-tasks.ts";
import { stripAnsi } from "../_shared/ansi.ts";
import { type BackgroundJobInfo, backgroundBashJobs, jobOutcome } from "../_shared/background-bash.ts";
import { formatClaudeDuration } from "../_shared/bash-limits.ts";

/** Claude Code's detail view: the last 10 lines of the file's last 8 KiB. */
const DETAIL_TAIL_BYTES = 8192;
const DETAIL_TAIL_LINES = 10;
const MAX_COMMAND_CHARS = 280;
/** Claude Code's suggestion colour, for the selected row. */
const SUGGESTION = (text: string) => `\x1b[38;2;177;185;249m${text}\x1b[39m`;

export type TaskKind = "shell" | "monitor" | "agent";
export type TaskState = "running" | "completed" | "failed" | "killed";

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
	// A subagent's shells are listed too, as Claude Code lists them.
	const jobs = backgroundBashJobs
		.list()
		.filter((job) => owner === undefined || job.owner === owner || job.agentId !== undefined);
	const shells: TaskRow[] = jobs.map((job) => ({
		id: job.id,
		kind: job.kind === "monitor" ? "monitor" : "shell",
		// A shell shows its command, a monitor its description (Claude Code).
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
	return [...shells, ...agents].sort((a, b) => b.startedAt - a.startedAt);
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

const clean = (s: string) => stripAnsi(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/**
 * The last lines of a job's output file (its memory copy when there is no file), the
 * file's size, and how many bytes of it were read.
 */
export function outputTail(job: BackgroundJobInfo): { lines: string[]; size: number; read: number } {
	let text = "";
	let size = 0;
	let read = 0;
	if (job.outputFile) {
		try {
			size = statSync(job.outputFile).size;
			const length = Math.min(size, DETAIL_TAIL_BYTES);
			read = length;
			const buffer = Buffer.alloc(length);
			const fd = openSync(job.outputFile, "r");
			try {
				readSync(fd, buffer, 0, length, size - length);
			} finally {
				closeSync(fd);
			}
			text = buffer.toString("utf-8");
		} catch {
			text = backgroundBashJobs.peek(job.id) ?? "";
		}
	} else {
		text = backgroundBashJobs.peek(job.id) ?? "";
		size = Buffer.byteLength(text);
		read = size;
	}
	const lines = text.split("\n").map((line) => clean(line.replace(/\r$/, "")));
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return { lines: lines.slice(-DETAIL_TAIL_LINES), size, read };
}

/** Stops a task as the user: the model is told, as Claude Code tells it. */
export function stopTask(row: TaskRow): void {
	if (row.kind === "agent") agentTasks()?.stop(row.id);
	else backgroundBashJobs.kill(row.id, { byUser: true });
}

/** Claude Code's `background` colour (dark theme): the dialog's title and a running status. */
const BACKGROUND = (text: string) => `\x1b[38;2;0;204;204m${text}\x1b[39m`;
const ITALIC = (text: string) => `\x1b[3m${text}\x1b[23m`;

/** A row's status, dim and coloured by outcome (`fc`); only running tasks are listed. */
const STATUS_COLOR: Record<TaskState, "success" | "error" | "warning" | undefined> = {
	running: undefined,
	completed: "success",
	failed: "error",
	killed: "warning",
};
const STATUS_LABEL: Record<TaskState, string> = {
	running: "running",
	completed: "done",
	failed: "error",
	killed: "stopped",
};

/** Claude Code's sections, in its order: a shell's section holds its command monitors too. */
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

/** A WebSocket monitor has no detail view in Claude Code (`OA`). */
const hasDetail = (row: TaskRow) => sectionOf(row) !== "monitors";

/** The tasks the dialog lists: running ones only (Claude Code's `rm`), running first then newest. */
function visibleRows(owner: string | undefined): TaskRow[] {
	const rows = taskRows(owner).filter((row) => row.state === "running");
	return SECTIONS.flatMap(([section]) => rows.filter((row) => sectionOf(row) === section));
}

export class TasksDialog implements Component {
	private selected = 0;
	private detail: string | undefined;
	/** The detail view was opened straight away, the dialog holding a single task. */
	private direct = false;
	private readonly theme: Theme;
	private readonly owner: string | undefined;
	private readonly done: () => void;
	private readonly requestRender: () => void;
	private readonly notify: (message: string) => void;
	private readonly held: () => string | undefined;

	constructor(
		theme: Theme,
		owner: string | undefined,
		done: () => void,
		requestRender: () => void,
		options: { notify?: (message: string) => void; held?: () => string | undefined } = {},
	) {
		this.theme = theme;
		this.owner = owner;
		this.done = done;
		this.requestRender = requestRender;
		this.notify = options.notify ?? (() => {});
		this.held = options.held ?? (() => undefined);
		// With one task to show, Claude Code opens straight to it.
		const rows = visibleRows(owner);
		if (rows.length === 1 && hasDetail(rows[0])) {
			this.detail = rows[0].id;
			this.direct = true;
		}
	}

	invalidate(): void {}

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
			} else if (data === "x" && row) stopTask(row);
			this.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.done();
			return;
		}
		if (rows.length === 0) return;
		this.selected = Math.min(this.selected, rows.length - 1);
		const current = rows[this.selected];
		if (kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (kb.matches(data, "tui.select.down")) this.selected = Math.min(rows.length - 1, this.selected + 1);
		else if (data === "\r" && hasDetail(current)) this.detail = current.id;
		else if (data === "x") stopTask(current);
		this.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const rows = visibleRows(this.owner);
		const border = t.fg("borderMuted", "─".repeat(Math.max(0, width)));
		if (this.detail !== undefined) {
			const row = rows.find((r) => r.id === this.detail);
			if (row) return [border, ...this.renderDetail(row, width), ...this.heldLine(), border];
			// The task ended while it was on screen: Claude Code goes back to the list, or
			// closes a dialog that was opened straight to it.
			const direct = this.direct;
			this.leaveDetail(rows);
			if (direct && rows.length <= 1) return [];
		}
		const count = (section: Section) => rows.filter((r) => sectionOf(r) === section).length;
		const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
		const shells = count("shells");
		const agents = count("agents");
		const subtitle = [
			shells ? plural(shells, "active shell", "active shells") : "",
			agents ? plural(agents, "active agent", "active agents") : "",
		].filter(Boolean);
		const out = [border, ` ${t.bold(BACKGROUND("Background"))}`];
		if (subtitle.length > 0) out.push(` ${subtitle.join(" · ")}`);
		out.push("");
		if (rows.length === 0) {
			out.push(" No tasks currently running");
			out.push("");
		} else {
			this.selected = Math.min(this.selected, rows.length - 1);
			const labelWidth = Math.max(30, width - 26);
			let index = 0;
			for (const [section, title] of SECTIONS) {
				const items = rows.filter((r) => sectionOf(r) === section);
				if (items.length === 0) continue;
				// The Shells header only when the list holds agents too (Claude Code).
				if (section !== "shells" || agents > 0) out.push(t.fg("dim", `  ${t.bold(title)} (${items.length})`));
				for (const row of items) {
					const selected = index++ === this.selected;
					const color = STATUS_COLOR[row.state];
					const label = truncateToWidth(clean(row.label), labelWidth, "…");
					const status = `(${STATUS_LABEL[row.state]})`;
					const text = `${label} ${color ? t.fg(color, t.fg("dim", status)) : t.fg("dim", status)}`;
					const line = ` ${selected ? "❯ " : "  "}${selected ? SUGGESTION(text) : text}`;
					out.push(truncateToWidth(line, width, "…"));
				}
				out.push("");
			}
		}
		out.push(...this.heldLine());
		const current = rows[this.selected];
		const hints = [
			"↑/↓ to select",
			...(!current || hasDetail(current) ? ["Enter to view"] : []),
			...(current ? ["x to stop"] : []),
			"Esc to close",
		];
		out.push(t.fg("dim", ` ${hints.join(" · ")}`));
		out.push(border);
		return out;
	}

	/** Claude Code's line for notifications held while the panel is open. */
	private heldLine(): string[] {
		const line = this.held();
		return line ? [this.theme.fg("dim", ` ${line}`)] : [];
	}

	private renderDetail(row: TaskRow, width: number): string[] {
		const t = this.theme;
		const monitor = row.job?.kind === "monitor";
		const title = row.kind === "agent" ? "Agent details" : monitor ? "Monitor details" : "Shell details";
		const out = [` ${t.bold(BACKGROUND(title))}`, ""];
		const field = (name: string, value: string) =>
			out.push(truncateToWidth(` ${t.bold(`${name}:`)} ${value}`, width, "…"));
		const code = row.job?.exit?.code;
		const statusText = `${row.state}${code !== undefined && code !== null ? ` (exit code: ${code})` : ""}`;
		const statusColor = row.state === "completed" ? "success" : "error";
		field("Status", row.state === "running" ? BACKGROUND(statusText) : t.fg(statusColor, statusText));
		field("Runtime", formatClaudeDuration((row.endedAt ?? Date.now()) - row.startedAt));
		if (row.job) {
			const command = clean(row.job.command);
			field(
				monitor ? "Script" : "Command",
				command.length > MAX_COMMAND_CHARS ? `${command.slice(0, MAX_COMMAND_CHARS)}…` : command,
			);
			out.push("", ` ${t.bold("Output:")}`);
			const { lines, size, read } = outputTail(row.job);
			const inner = Math.max(10, width - 4);
			out.push(t.fg("borderMuted", ` ╭${"─".repeat(inner)}╮`));
			// A fixed 12 rows, borders included, as Claude Code's box.
			const body = lines.length > 0 ? lines : [t.fg("dim", "No output available")];
			for (let i = 0; i < DETAIL_TAIL_LINES; i++) {
				const text = truncateToWidth(body[i] ?? "", inner - 2, "…");
				const pad = " ".repeat(Math.max(0, inner - 2 - visibleWidth(text)));
				out.push(`${t.fg("borderMuted", " │")} ${text}${pad} ${t.fg("borderMuted", "│")}`);
			}
			out.push(t.fg("borderMuted", ` ╰${"─".repeat(inner)}╯`));
			if (lines.length > 0) {
				out.push(
					t.fg("dim", ITALIC(` Showing ${lines.length} lines${size > read ? ` of ${formatSize(size)}` : ""}`)),
				);
			}
		} else {
			field("Task", clean(row.label));
		}
		out.push("");
		out.push(t.fg("dim", ` ${["← to go back", "Esc/Enter/Space to close", "x to stop"].join(" · ")}`));
		return out;
	}
}
