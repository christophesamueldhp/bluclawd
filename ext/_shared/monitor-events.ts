/**
 * The pure pieces of the monitor tool: lines into batches, batches into a
 * rate, and the tail of a job's output. Nothing here spawns a process or
 * talks to pi; the wiring lives in the sandbox extension.
 */

import { type BackgroundJobInfo, describeJobStatus } from "./background-bash.ts";

export interface Batch {
	lines: string[];
	/** Lines that did not fit under the caps; the output file still has them. */
	more: number;
}

export interface EventBatcherOptions {
	delayMs: number;
	onFlush: (batch: Batch) => void;
	maxLines?: number;
	maxBytes?: number;
}

/** Lines pushed within `delayMs` of the first one form a single batch. */
export class EventBatcher {
	private pending: string[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly delayMs: number;
	private readonly onFlush: (batch: Batch) => void;
	private readonly maxLines: number;
	private readonly maxBytes: number;

	constructor(options: EventBatcherOptions) {
		this.delayMs = options.delayMs;
		this.onFlush = options.onFlush;
		this.maxLines = options.maxLines ?? 50;
		this.maxBytes = options.maxBytes ?? 8 * 1024;
	}

	push(lines: string[]): void {
		if (lines.length === 0) return;
		this.pending.push(...lines);
		if (this.timer === undefined) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.onFlush(this.take());
			}, this.delayMs);
		}
	}

	/** Pending lines under the caps, clearing them and cancelling any scheduled flush. */
	take(): Batch {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const all = this.pending;
		this.pending = [];
		const lines: string[] = [];
		let bytes = 0;
		for (const line of all) {
			const size = Buffer.byteLength(line, "utf-8") + 1;
			if (lines.length >= this.maxLines || bytes + size > this.maxBytes) break;
			lines.push(line);
			bytes += size;
		}
		if (lines.length === 0 && all.length > 0) {
			lines.push(all[0].slice(0, this.maxBytes));
		}
		return { lines, more: all.length - lines.length };
	}
}

/**
 * Claude Code's monitor rate limit: a bucket of `capacity` events refilled one per
 * `refillMs`. `take` spends one and says whether the event may go out.
 */
export class TokenBucket {
	readonly capacity: number;
	readonly refillMs: number;
	private tokens: number;
	private last: number | undefined;

	constructor(options: { capacity: number; refillMs: number }) {
		this.capacity = options.capacity;
		this.refillMs = options.refillMs;
		this.tokens = options.capacity;
	}

	take(now: number): boolean {
		if (this.last !== undefined) {
			this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) / this.refillMs);
		}
		this.last = now;
		if (this.tokens < 1) return false;
		this.tokens -= 1;
		return true;
	}
}

/**
 * The last `maxLines` lines of `text`, trimmed further to fit `maxBytes` on a line boundary.
 * A single line past `maxBytes` on its own keeps the end of that line instead of going empty.
 */
export function tailOutput(text: string, maxLines: number, maxBytes: number): string {
	const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const kept: string[] = [];
	let bytes = 0;
	for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
		const size = Buffer.byteLength(lines[i], "utf-8") + 1;
		if (bytes + size > maxBytes) break;
		kept.unshift(lines[i]);
		bytes += size;
	}
	if (kept.length === 0 && lines.length > 0) {
		kept.push(lines[lines.length - 1].slice(-maxBytes));
	}
	return kept.join("\n");
}

/** How every event reaches the model: after the current turn's tool calls, or as a new turn when idle. */
export const EVENT_DELIVERY = { deliverAs: "steer", triggerTurn: true } as const;

export const MONITOR_MESSAGE_TYPE = "bluclawd:monitor";
export const TASK_EXIT_MESSAGE_TYPE = "bluclawd:task-exit";

export type EventStatus = "success" | "error" | "warning";

export interface MonitorMessageDetails {
	id: string;
	description: string;
	/** Event text, one entry per line; empty on an end notice with nothing left over. */
	lines: string[];
	/** Present only on the terminal message. */
	end?: string;
	status?: EventStatus;
}

export interface TaskExitDetails {
	id: string;
	description: string;
	command: string;
	/** The notification's summary line. */
	end: string;
	outputFile?: string;
	status: EventStatus;
}

/** The shape pi.sendMessage takes, minus the fields it fills in. */
export interface OutgoingMessage<T> {
	customType: string;
	content: string;
	display: true;
	details: T;
}

function label(job: BackgroundJobInfo): string {
	return job.description?.trim() || job.command;
}

function endStatus(job: BackgroundJobInfo): EventStatus {
	if (job.killed) return "warning";
	if (job.exit?.error || (job.exit?.code ?? 0) !== 0) return "error";
	return "success";
}

/** Claude Code's `<task-notification>`: each tag only when it has a value. */
export function taskNotification(fields: {
	taskId: string;
	toolUseId?: string;
	outputFile?: string;
	status?: string;
	summary: string;
	body?: string;
	/** Text after the closing tag. */
	trailing?: string;
}): string {
	const tag = (name: string, value: string | undefined) => (value ? [`<${name}>${value}</${name}>`] : []);
	const head = [
		"<task-notification>",
		...tag("task-id", fields.taskId),
		...tag("tool-use-id", fields.toolUseId),
		...tag("output-file", fields.outputFile),
		...tag("status", fields.status),
		...tag("summary", fields.summary),
	].join("\n");
	// The body follows the tags, as in Claude Code; `trailing` follows the envelope.
	return `${head}${fields.body ?? ""}\n</task-notification>${fields.trailing ?? ""}`;
}

/** Monitor event caps, Claude Code's: per line and per event. */
const MAX_EVENT_LINE_CHARS = 500;
const MAX_EVENT_CHARS = 3000;
const TRUNCATED = "...(truncated)";

/** An event's text under Claude Code's caps. */
export function eventText(lines: string[]): string {
	const text = lines
		.map((line) => (line.length > MAX_EVENT_LINE_CHARS ? `${line.slice(0, MAX_EVENT_LINE_CHARS)}${TRUNCATED}` : line))
		.join("\n");
	return text.length > MAX_EVENT_CHARS ? `${text.slice(0, MAX_EVENT_CHARS)}${TRUNCATED}` : text;
}

/** 300000 → "5m", 90000 → "1m 30s", as the expiry notice names the timeout. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return [h ? `${h}h` : "", m ? `${m}m` : "", s || total === 0 ? `${s}s` : ""].filter(Boolean).join(" ");
}

/** One monitor event: `lines` as the event, or a notice line of the monitor's own. */
export function monitorEventMessage(job: BackgroundJobInfo, lines: string[]): OutgoingMessage<MonitorMessageDetails> {
	const description = label(job);
	const text = eventText(lines);
	return {
		customType: MONITOR_MESSAGE_TYPE,
		content: taskNotification({
			taskId: job.id,
			summary: `Monitor event: "${description}"`,
			body: `\n<event>${text}</event>`,
		}),
		display: true,
		details: { id: job.id, description, lines: text.split("\n") },
	};
}

/**
 * How a monitor's end reads. `expiry` is the notice sent instead when the timeout
 * killed it; a stop the registry made (the rate limit) carries its own notice.
 */
export function monitorEndSummary(job: BackgroundJobInfo): string {
	const d = label(job);
	if (job.killed) return `Monitor "${d}" stopped`;
	const code = job.exit?.code ?? null;
	if (job.exit?.error || (code !== null && code !== 0)) return `Monitor "${d}" script failed (exit ${code})`;
	return job.events > 0
		? `Monitor "${d}" stream ended`
		: `Monitor "${d}" ended without producing output (exit ${code})`;
}

/** The terminal notification, with any lines that arrived too late for their own event. */
export function monitorEndMessage(job: BackgroundJobInfo, leftover: string[]): OutgoingMessage<MonitorMessageDetails> {
	const description = label(job);
	const end = job.stopReason ?? monitorEndSummary(job);
	const text = leftover.length > 0 ? eventText(leftover) : "";
	return {
		customType: MONITOR_MESSAGE_TYPE,
		content: taskNotification({
			taskId: job.id,
			outputFile: job.outputFile,
			status: job.killed ? "killed" : endStatus(job) === "error" ? "failed" : "completed",
			summary: job.stopReason ? `Monitor event: "${description}"` : end,
			body: job.stopReason ? `\n<event>${end}</event>` : text ? `\n<event>${text}</event>` : undefined,
		}),
		display: true,
		details: { id: job.id, description, lines: text ? text.split("\n") : [], end, status: endStatus(job) },
	};
}

/** The summary of a finished background command, in Claude Code's words. */
export function taskExitSummary(job: BackgroundJobInfo): string {
	const d = label(job);
	if (job.stoppedByUser) return `Task "${d}" was stopped by the user`;
	if (job.killed) return `Background command "${d}" was stopped`;
	const code = job.exit?.code;
	if (job.exit?.error && code === null) return `Background command "${d}" ${describeJobStatus(job)}`;
	return code === 0
		? `Background command "${d}" completed (exit code 0)`
		: `Background command "${d}" failed with exit code ${code}`;
}

export function taskExitMessage(job: BackgroundJobInfo, toolUseId?: string): OutgoingMessage<TaskExitDetails> {
	const end = taskExitSummary(job);
	const status = job.killed ? "killed" : endStatus(job) === "error" ? "failed" : "completed";
	return {
		customType: TASK_EXIT_MESSAGE_TYPE,
		content: taskNotification({
			taskId: job.id,
			toolUseId,
			// A stop the user made is the whole news; Claude Code names no file then.
			outputFile: job.stoppedByUser ? undefined : job.outputFile,
			status,
			summary: end,
		}),
		display: true,
		details: {
			id: job.id,
			description: label(job),
			command: job.command,
			end,
			outputFile: job.outputFile,
			status: endStatus(job),
		},
	};
}

/** Claude Code's notice for a background shell that looks blocked on a prompt; the task keeps running. */
export function taskStallMessage(
	job: BackgroundJobInfo,
	tail: string,
	toolUseId?: string,
): OutgoingMessage<TaskExitDetails> {
	const end = `Background command "${label(job)}" appears to be waiting for interactive input`;
	return {
		customType: TASK_EXIT_MESSAGE_TYPE,
		content: taskNotification({
			taskId: job.id,
			toolUseId,
			outputFile: job.outputFile,
			summary: end,
			trailing: `\nLast output:\n${tail.trimEnd()}\n\nThe command is likely blocked on an interactive prompt. Stop this task and re-run with piped input (e.g., \`echo y | command\`) or a non-interactive flag if one exists.`,
		}),
		display: true,
		details: {
			id: job.id,
			description: label(job),
			command: job.command,
			end,
			outputFile: job.outputFile,
			status: "warning",
		},
	};
}

/**
 * A job the model stopped itself already got its answer from task_stop, and one a
 * blocking task_output was waiting on got it there; everything else is news.
 */
export function shouldNotifyExit(job: BackgroundJobInfo): boolean {
	if (job.awaited) return false;
	return !(job.killed && !job.stopReason && !job.stoppedByUser);
}
