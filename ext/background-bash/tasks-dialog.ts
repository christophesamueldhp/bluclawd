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
import { type BackgroundJobInfo, backgroundBashJobs } from "../_shared/background-bash.ts";

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

function jobState(job: BackgroundJobInfo): TaskState {
	if (!job.exit) return "running";
	if (job.killed) return "killed";
	return job.exit.error || (job.exit.code ?? 0) !== 0 ? "failed" : "completed";
}

/** Every task of the session `owner`, newest first. */
export function taskRows(owner: string | undefined): TaskRow[] {
	const shells: TaskRow[] = backgroundBashJobs.list(owner).map((job) => ({
		id: job.id,
		kind: job.kind === "monitor" ? "monitor" : "shell",
		// A shell shows its command, a monitor its description (Claude Code).
		label: job.kind === "monitor" ? job.description?.trim() || job.command : job.command,
		state: jobState(job),
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

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

const clean = (s: string) => stripAnsi(s).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** The last lines of a job's output file (its memory copy when there is no file), and the file's size. */
export function outputTail(job: BackgroundJobInfo): { lines: string[]; size: number } {
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
		} catch {
			text = backgroundBashJobs.peek(job.id) ?? "";
		}
	} else {
		text = backgroundBashJobs.peek(job.id) ?? "";
		size = Buffer.byteLength(text);
	}
	const lines = text.split("\n").map((line) => clean(line.replace(/\r$/, "")));
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return { lines: lines.slice(-DETAIL_TAIL_LINES), size };
}

/** Stops a task as the user: the model is told, as Claude Code tells it. */
export function stopTask(row: TaskRow): void {
	if (row.kind === "agent") agentTasks()?.stop(row.id);
	else backgroundBashJobs.kill(row.id, undefined, true);
}

const STATUS_LABEL: Record<TaskState, string> = {
	running: "running",
	completed: "done",
	failed: "error",
	killed: "stopped",
};
const STATUS_COLOR: Record<TaskState, "success" | "error" | "warning" | undefined> = {
	running: undefined,
	completed: "success",
	failed: "error",
	killed: "warning",
};
const SECTIONS: [TaskKind, string][] = [
	["agent", "Agents"],
	["shell", "Shells"],
	["monitor", "Monitors"],
];

export class TasksDialog implements Component {
	private selected = 0;
	private detail: string | undefined;
	private readonly theme: Theme;
	private readonly owner: string | undefined;
	private readonly done: () => void;
	private readonly requestRender: () => void;

	constructor(theme: Theme, owner: string | undefined, done: () => void, requestRender: () => void) {
		this.theme = theme;
		this.owner = owner;
		this.done = done;
		this.requestRender = requestRender;
	}

	/** Rows in section order, which is also the selection order. */
	private rows(): TaskRow[] {
		const rows = taskRows(this.owner);
		return SECTIONS.flatMap(([kind]) => rows.filter((row) => row.kind === kind));
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const rows = this.rows();
		if (this.detail !== undefined) {
			const row = rows.find((r) => r.id === this.detail);
			if (matchesKey(data, "left")) this.detail = undefined;
			else if (kb.matches(data, "tui.select.cancel") || data === "\r" || data === " ") {
				this.done();
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
		this.selected = Math.min(this.selected, rows.length - 1);
		if (kb.matches(data, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
		else if (kb.matches(data, "tui.select.down")) this.selected = Math.min(rows.length - 1, this.selected + 1);
		else if (data === "\r" || matchesKey(data, "right")) this.detail = rows[this.selected].id;
		else if (data === "x" && rows[this.selected].state === "running") stopTask(rows[this.selected]);
		this.requestRender();
	}

	render(width: number): string[] {
		const t = this.theme;
		const rows = this.rows();
		const border = t.fg("borderMuted", "─".repeat(Math.max(0, width)));
		if (this.detail !== undefined) {
			const row = rows.find((r) => r.id === this.detail);
			if (row) return [border, ...this.renderDetail(row, width), border];
			this.detail = undefined;
		}
		const running = (kind: TaskKind) => rows.filter((r) => r.kind === kind && r.state === "running").length;
		const plural = (n: number, word: string) => `${n} active ${word}${n === 1 ? "" : "s"}`;
		const subtitle = [
			running("agent") ? plural(running("agent"), "agent") : "",
			running("shell") ? plural(running("shell"), "shell") : "",
			running("monitor") ? plural(running("monitor"), "monitor") : "",
		].filter(Boolean);
		const out = [border, ` ${t.bold("Background")}`];
		if (subtitle.length > 0) out.push(t.fg("dim", ` ${subtitle.join(" · ")}`));
		out.push("");
		if (rows.length === 0) {
			out.push(t.fg("dim", " No tasks currently running"));
			out.push("");
		} else {
			this.selected = Math.min(this.selected, rows.length - 1);
			const labelWidth = Math.max(30, width - 26);
			let index = 0;
			for (const [kind, title] of SECTIONS) {
				const section = rows.filter((r) => r.kind === kind);
				if (section.length === 0) continue;
				out.push(` ${t.bold(title)}`);
				for (const row of section) {
					const selected = index++ === this.selected;
					const color = STATUS_COLOR[row.state];
					const status = `(${STATUS_LABEL[row.state]})`;
					const label = truncateToWidth(clean(row.label), labelWidth, "…");
					const text = `${selected ? "❯ " : "  "}${label}`;
					const line = ` ${selected ? SUGGESTION(text) : text} ${t.fg(color ?? "dim", status)}`;
					out.push(truncateToWidth(line, width, "…"));
				}
				out.push("");
			}
		}
		const current = rows[this.selected];
		const hints = [
			"(↑/↓) to select",
			...(rows.length > 0 ? ["enter to view"] : []),
			...(current?.state === "running" ? ["x to stop"] : []),
			"esc to close",
		];
		out.push(t.fg("dim", ` ${hints.join(" · ")}`));
		out.push(border);
		return out;
	}

	private renderDetail(row: TaskRow, width: number): string[] {
		const t = this.theme;
		const title =
			row.kind === "monitor" ? "Monitor details" : row.kind === "agent" ? "Agent details" : "Shell details";
		const out = [` ${t.bold(title)}`, ""];
		const field = (name: string, value: string) =>
			out.push(truncateToWidth(` ${t.bold(`${name}:`)} ${value}`, width, "…"));
		const code = row.job?.exit?.code;
		const statusText = `${row.state}${code !== undefined && code !== null ? ` (exit code: ${code})` : ""}`;
		const statusColor = row.state === "running" ? undefined : row.state === "completed" ? "success" : "error";
		field("Status", statusColor ? t.fg(statusColor, statusText) : SUGGESTION(statusText));
		field("Runtime", formatElapsed((row.endedAt ?? Date.now()) - row.startedAt));
		if (row.job) {
			const command = clean(row.job.command);
			field(
				row.kind === "monitor" ? "Script" : "Command",
				command.length > MAX_COMMAND_CHARS ? `${command.slice(0, MAX_COMMAND_CHARS)}…` : command,
			);
			out.push("", ` ${t.bold("Output:")}`);
			const { lines, size } = outputTail(row.job);
			const inner = Math.max(10, width - 4);
			out.push(t.fg("borderMuted", ` ╭${"─".repeat(inner)}╮`));
			const body = lines.length > 0 ? lines : [t.fg("dim", "No output available")];
			for (const line of body) {
				const text = truncateToWidth(line, inner - 2, "…");
				const pad = " ".repeat(Math.max(0, inner - 2 - visibleWidth(text)));
				out.push(`${t.fg("borderMuted", " │")} ${text}${pad} ${t.fg("borderMuted", "│")}`);
			}
			out.push(t.fg("borderMuted", ` ╰${"─".repeat(inner)}╯`));
			if (lines.length > 0) {
				const partial = lines.length >= DETAIL_TAIL_LINES || size > DETAIL_TAIL_BYTES;
				out.push(t.fg("dim", ` Showing ${lines.length} lines${partial ? ` of ${formatSize(size)}` : ""}`));
			}
		} else {
			field("Task", clean(row.label));
		}
		out.push("");
		const hints = ["← to go back", "(esc/enter/space) to close", ...(row.state === "running" ? ["x to stop"] : [])];
		out.push(t.fg("dim", ` ${hints.join(" · ")}`));
		return out;
	}
}
