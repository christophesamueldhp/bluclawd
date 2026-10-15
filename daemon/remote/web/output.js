// @ts-check
/**
 * What the chat shows of a tool's result and of a marker, as Claude Code's transcript does: a
 * call is one line, `● Read(src/x.ts)`, and its result one more under it, `⎿ Read 120 lines`;
 * the whole output is a tap away. Pure, so the tests import it.
 */

/** A shell's output shows this many lines before "… +N lines". */
const HEAD_LINES = 3;

/** @param {string} text */
function lines(text) {
	const all = text.replace(/\s+$/, "").split("\n");
	return all.length === 1 && all[0] === "" ? [] : all;
}

/** "1 line", "3 lines", "3+ lines". @param {number} count @param {string} one @param {boolean} [more] the count is at least this */
function count(count, one, more = false) {
	const plural = count === 1 && !more ? "" : one.endsWith("ch") ? "es" : "s";
	return `${count}${more ? "+" : ""} ${one}${plural}`;
}

/**
 * The lines under a tool call: a summary of what it did, as Claude Code words it, or the output's
 * first lines. `truncated`: the text is cut short, so a count of its lines is a lower bound.
 * @param {string} tool @param {{ text?: string, ok?: boolean, truncated?: boolean }} result
 * @returns {string[]}
 */
export function resultSummary(tool, { text = "", ok = true, truncated = false }) {
	const all = lines(text);
	if (!ok) return all.length ? head(all, truncated) : ["Error"];
	// pi's note on what it left out, under the output, says how much there is.
	const note = all.at(-1)?.match(/^\[Showing lines (\d+)-(\d+) of (\d+)/);
	const body = /^\[.*\]$/.test(all.at(-1) ?? "") ? lines(all.slice(0, -1).join("\n")) : all;
	const name = tool.toLowerCase();
	if (name === "read") {
		if (note) return [`Read ${count(Number(note[2]) - Number(note[1]) + 1, "line")}`];
		return [`Read ${count(body.length, "line", truncated)}`];
	}
	if (name === "grep") {
		if (/^No matches found/.test(all[0] ?? "")) return ["No matches found"];
		return [`Found ${count(body.filter((line) => /^.+?:\d+: /.test(line)).length, "match", truncated)}`];
	}
	if (name === "find" || name === "glob") {
		if (/^No files found/.test(all[0] ?? "")) return ["No files found"];
		return [`Found ${count(body.length, "file", truncated)}`];
	}
	if (name === "ls") return [`Listed ${count(body.length, "path", truncated)}`];
	const first = all.find((line) => line.trim());
	// "Successfully wrote to x.ts" → "Wrote to x.ts".
	if (first && /^Successfully /.test(first) && all.length === 1) {
		const said = first.replace(/^Successfully /, "");
		return [said.charAt(0).toUpperCase() + said.slice(1)];
	}
	return all.length ? head(all, truncated) : ["(No output)"];
}

/** The first lines with text, then how many more: "… +12 lines". @param {string[]} all @param {boolean} truncated */
function head(all, truncated) {
	const filled = all.filter((line) => line.trim());
	const shown = filled.slice(0, HEAD_LINES);
	const rest = filled.length - shown.length;
	if (rest > 0) shown.push(`… +${count(rest, "line", truncated)}`);
	else if (truncated) shown.push("…");
	return shown;
}

/** An edit's line under its call: "Added 3 lines, removed 1 line". @param {number} added @param {number} removed */
export function diffSummary(added, removed) {
	const parts = [];
	if (added) parts.push(`Added ${count(added, "line")}`);
	if (removed) parts.push(`${parts.length ? "removed" : "Removed"} ${count(removed, "line")}`);
	return parts.join(", ") || "No changes";
}

/**
 * How a marker shows: an interrupted turn in red, as Claude Code's "Interrupted"; the model a
 * session starts with is noise, before its first prompt (a later switch shows). `hidden` ones show not at all.
 * @param {string} text @param {boolean} beforeFirstPrompt
 * @returns {"interrupted" | "hidden" | "plain"}
 */
export function markerKind(text, beforeFirstPrompt) {
	if (!text.trim()) return "hidden";
	if (/^(interrupted|aborted)\b/i.test(text.trim())) return "interrupted";
	if (beforeFirstPrompt && /^Model: /.test(text)) return "hidden";
	return "plain";
}
