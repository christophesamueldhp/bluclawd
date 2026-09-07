/**
 * The pure pieces of the monitor tool: lines into batches, batches into a
 * rate, and the tail of a job's output. Nothing here spawns a process or
 * talks to pi; the wiring lives in the sandbox extension.
 */

import { type BackgroundJobInfo, describeJobStatus } from "./background-bash.ts";

export interface Batch {
	lines: string[];
	/** Lines that did not fit under the caps; the registry still buffers them for bash_output. */
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
 * Counts events in a rolling window; `record` returns true once the count exceeds `max`.
 * Call it once per emitted batch, not per line, so the retained stamps stay bounded by
 * windowMs / batch delay.
 */
export class RateLimiter {
	private stamps: number[] = [];
	readonly max: number;
	readonly windowMs: number;

	constructor(options: { max: number; windowMs: number }) {
		this.max = options.max;
		this.windowMs = options.windowMs;
	}

	record(now: number): boolean {
		this.stamps = this.stamps.filter((stamp) => now - stamp < this.windowMs);
		this.stamps.push(now);
		return this.stamps.length > this.max;
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

export const MONITOR_MESSAGE_TYPE = "bluclawd:monitor";
export const TASK_EXIT_MESSAGE_TYPE = "bluclawd:task-exit";

export type EventStatus = "success" | "error" | "warning";

export interface MonitorMessageDetails {
	id: string;
	description: string;
	lines: string[];
	more: number;
	/** Present only on the terminal message. */
	end?: string;
	status?: EventStatus;
}

export interface TaskExitDetails {
	id: string;
	description: string;
	command: string;
	end: string;
	tail: string;
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

function overflowNote(more: number): string[] {
	return more > 0 ? [`…and ${more} more lines (read them with bash_output)`] : [];
}

export function monitorEventMessage(job: BackgroundJobInfo, batch: Batch): OutgoingMessage<MonitorMessageDetails> {
	const description = label(job);
	const content = [`[monitor ${job.id} · ${description}]`, ...batch.lines, ...overflowNote(batch.more)].join("\n");
	return {
		customType: MONITOR_MESSAGE_TYPE,
		content,
		display: true,
		details: { id: job.id, description, lines: batch.lines, more: batch.more },
	};
}

export function monitorEndMessage(job: BackgroundJobInfo, batch: Batch): OutgoingMessage<MonitorMessageDetails> {
	const description = label(job);
	const end = describeJobStatus(job);
	const content = [`[monitor ${job.id} · ${description}]`, ...batch.lines, ...overflowNote(batch.more), end].join(
		"\n",
	);
	return {
		customType: MONITOR_MESSAGE_TYPE,
		content,
		display: true,
		details: { id: job.id, description, lines: batch.lines, more: batch.more, end, status: endStatus(job) },
	};
}

export function taskExitMessage(job: BackgroundJobInfo, tail: string): OutgoingMessage<TaskExitDetails> {
	const description = label(job);
	const end = describeJobStatus(job);
	// label() already falls back to the command, so name it again only when it is not the label.
	const command = job.description?.trim() ? ` — ${job.command}` : "";
	const head = `[task ${job.id} · ${description}] ${end}${command}`;
	return {
		customType: TASK_EXIT_MESSAGE_TYPE,
		content: tail.length > 0 ? `${head}\n${tail}` : head,
		display: true,
		details: { id: job.id, description, command: job.command, end, tail, status: endStatus(job) },
	};
}
