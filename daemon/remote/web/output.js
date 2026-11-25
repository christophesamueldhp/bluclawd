// @ts-check

const HEAD_LINES = 3;

/** @param {string} text */
function lines(text) {
	const all = text.replace(/\s+$/, "").split("\n");
	return all.length === 1 && all[0] === "" ? [] : all;
}

/** @param {number} count @param {string} one @param {boolean} [more] */
function count(count, one, more = false) {
	const plural = count === 1 && !more ? "" : one.endsWith("ch") ? "es" : "s";
	return `${count}${more ? "+" : ""} ${one}${plural}`;
}

/** @param {string} tool @param {{ text?: string, ok?: boolean, truncated?: boolean }} result @returns {string[]} */
export function resultSummary(tool, { text = "", ok = true, truncated = false }) {
	const all = lines(text);
	if (!ok) return all.length ? head(all, truncated) : ["Error"];
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
	if (first && /^Successfully /.test(first) && all.length === 1) {
		const said = first.replace(/^Successfully /, "");
		return [said.charAt(0).toUpperCase() + said.slice(1)];
	}
	return all.length ? head(all, truncated) : ["(No output)"];
}

/** @param {string[]} all @param {boolean} truncated */
function head(all, truncated) {
	const filled = all.filter((line) => line.trim());
	const shown = filled.slice(0, HEAD_LINES);
	const rest = filled.length - shown.length;
	if (rest > 0) shown.push(`… +${count(rest, "line", truncated)}`);
	else if (truncated) shown.push("…");
	return shown;
}

/** @param {number} added @param {number} removed */
export function diffSummary(added, removed) {
	const parts = [];
	if (added) parts.push(`Added ${count(added, "line")}`);
	if (removed) parts.push(`${parts.length ? "removed" : "Removed"} ${count(removed, "line")}`);
	return parts.join(", ") || "No changes";
}

/** @param {string} text @param {boolean} beforeFirstPrompt @returns {"interrupted" | "hidden" | "plain"} */
export function markerKind(text, beforeFirstPrompt) {
	if (!text.trim()) return "hidden";
	if (/^(interrupted|aborted)\b/i.test(text.trim())) return "interrupted";
	if (beforeFirstPrompt && /^Model: /.test(text)) return "hidden";
	return "plain";
}

const GROUP_VERBS = /** @type {Record<string, [string, string]>} */ ({
	bash: ["ran", "command"],
	powershell: ["ran", "command"],
	read: ["read", "file"],
	edit: ["edited", "file"],
	write: ["wrote", "file"],
	grep: ["searched", "time"],
	find: ["searched", "time"],
	glob: ["searched", "time"],
	ls: ["listed", "folder"],
});

/** @param {string[]} tools */
export function groupSummary(tools) {
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const tool of tools) {
		const [verb, thing] = GROUP_VERBS[tool.toLowerCase()] ?? ["used", "tool"];
		const phrase = `${verb} ${thing}`;
		counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
	}
	const said = [...counts].map(([phrase, n]) => {
		const [verb, thing] = phrase.split(" ");
		if (thing === "time") return `${verb} ${n === 1 ? "once" : `${n} times`}`;
		return `${verb} ${n === 1 ? `a ${thing}` : `${n} ${thing}s`}`;
	});
	const line = said.join(", ");
	return line.charAt(0).toUpperCase() + line.slice(1);
}
