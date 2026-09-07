/**
 * The pure pieces of the monitor tool: lines into batches, batches into a
 * rate, and all of it into the messages the model sees. Nothing here touches
 * pi or a process, so all of it is unit tested; the wiring lives in
 * ext/sandbox/monitor-tool.ts.
 */

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
		return { lines, more: all.length - lines.length };
	}
}

/** Counts events in a rolling window; `record` returns true once the count exceeds `max`. */
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

/** The last `maxLines` lines of `text`, trimmed further to fit `maxBytes` on a line boundary. */
export function tailOutput(text: string, maxLines: number, maxBytes: number): string {
	const lines = text
		.replace(/\n$/, "")
		.split("\n")
		.filter((line) => line.length > 0);
	const kept: string[] = [];
	let bytes = 0;
	for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
		const size = Buffer.byteLength(lines[i], "utf-8") + 1;
		if (bytes + size > maxBytes) break;
		kept.unshift(lines[i]);
		bytes += size;
	}
	return kept.join("\n");
}
