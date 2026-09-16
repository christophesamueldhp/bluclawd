/**
 * The pure parts of working vibes: prompts, response cleanup, and the seeded
 * no-repeat order file mode walks.
 *
 * Adapted from pi-powerline-footer's working vibes (MIT, Nico Bailon).
 */

export function buildVibePrompt(theme: string, task: string, recent: readonly string[]): string {
	return [
		`Generate a 2-4 word "${theme}" themed loading message ending in "...".`,
		"",
		// The start of a request carries most of its meaning; the rest only costs tokens.
		`Task: ${task.slice(0, 100)}`,
		"",
		"Be creative and unexpected. Avoid obvious or clichéd phrases for this theme.",
		"The message should hint at the task using theme vocabulary.",
		recent.length > 0 ? `Don't use: ${recent.join(", ")}` : "",
		"Output only the message, nothing else.",
	]
		.filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
		.join("\n");
}

export function buildBatchPrompt(theme: string, count: number): string {
	return [
		`Generate ${count} unique 2-4 word loading messages for a "${theme}" theme.`,
		'Each message should end with "..."',
		"Be creative, varied, and thematic. No duplicates.",
		"Output one message per line, nothing else. No numbering, no bullets.",
	].join("\n");
}

export const VIBE_SYSTEM_PROMPT = "You generate short themed loading messages and reply with the requested text only.";

function withEllipsis(text: string): string {
	return text.endsWith("...") ? text : `${text.replace(/\.+$/, "")}...`;
}

/** One model reply → one working message: first line, unquoted, `...`-terminated, at most `maxLength`. */
export function cleanVibe(reply: string, fallback: string, maxLength: number): string {
	let vibe = withEllipsis((reply.trim().split("\n")[0] ?? "").trim().replace(/^["']|["']$/g, ""));
	if (vibe.length > maxLength) vibe = `${vibe.slice(0, maxLength - 3)}...`;
	return vibe === "..." ? `${fallback}...` : vibe;
}

/** A batch reply → the vibes it contains, numbering/bullets/quotes removed. */
export function parseVibeBatch(reply: string): string[] {
	return reply
		.split("\n")
		.map((line) =>
			line
				.trim()
				.replace(/^["'\d.\-)\s]+/, "")
				.replace(/["']$/, "")
				.trim(),
		)
		.filter((line) => line.length > 0)
		.map(withEllipsis)
		.filter((vibe) => vibe !== "...");
}

/** `/vibe generate <theme words> [count]`: a trailing number is the count (1-500, default 100). */
export function parseGenerateArgs(args: readonly string[]): { theme: string; count: number } | undefined {
	if (args.length === 0) return undefined;
	const last = args[args.length - 1] ?? "";
	const hasCount = args.length > 1 && /^\d+$/.test(last);
	const theme = (hasCount ? args.slice(0, -1) : args).join(" ");
	const count = hasCount ? Math.min(Math.max(Number.parseInt(last, 10), 1), 500) : 100;
	return { theme, count };
}

export function vibeFileSlug(theme: string): string {
	const slug = theme
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "");
	return slug || "theme";
}

/** Mulberry32: small, fast, deterministic. */
function mulberry32(seed: number): () => number {
	let state = seed;
	return () => {
		state += 0x6d2b79f5;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** The `index`-th vibe of a seeded shuffle: every vibe once before any repeats. */
export function pickVibe(vibes: readonly string[], index: number, seed: number): string {
	const order = vibes.map((_, i) => i);
	const random = mulberry32(seed);
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[order[i], order[j]] = [order[j], order[i]];
	}
	return vibes[order[index % vibes.length]];
}
