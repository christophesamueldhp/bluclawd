export interface SplitResult {
	lines: string[];
	carry: string;
}

export function splitLines(carry: string, chunk: string): SplitResult {
	const parts = (carry + chunk).split("\n");
	const rest = parts.pop() ?? "";
	const lines = parts
		.map((line) => line.replace(/\r+$/, ""))
		.map((line) => line.slice(line.lastIndexOf("\r") + 1))
		.filter((line) => line.length > 0);
	return { lines, carry: rest };
}
