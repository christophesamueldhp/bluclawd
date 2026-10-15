/** Byte-stream to lines. Its own file: the job registry imports it, and monitor-events.ts imports the registry. */

export interface SplitResult {
	lines: string[];
	/** The trailing partial line, to be prepended to the next chunk. */
	carry: string;
}

/**
 * Whole lines from `carry + chunk`; blank lines are dropped, `\r\n` is accepted. A bare `\r`
 * inside a line (a progress-bar rewrite) drops everything before it, keeping only the last write.
 */
export function splitLines(carry: string, chunk: string): SplitResult {
	const parts = (carry + chunk).split("\n");
	const rest = parts.pop() ?? "";
	const lines = parts
		.map((line) => line.replace(/\r+$/, ""))
		.map((line) => line.slice(line.lastIndexOf("\r") + 1))
		.filter((line) => line.length > 0);
	return { lines, carry: rest };
}
