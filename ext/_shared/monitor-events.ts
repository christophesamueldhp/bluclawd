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
