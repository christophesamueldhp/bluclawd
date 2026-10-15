// @ts-check
/**
 * An edit's diff as pi shows it: `+12 line` added, `-12 line` removed, ` 12 line` (or ` … ...`
 * between hunks) context. Pure, so the tests import it.
 */

/** @param {unknown} text */
function esc(text) {
	return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** @param {string} line @returns {"add" | "del" | "ctx"} */
export function lineKind(line) {
	return line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
}

/** How many lines it adds and removes, for the tool result's summary. @param {string} diff */
export function diffCounts(diff) {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		const kind = lineKind(line);
		if (kind === "add") added++;
		else if (kind === "del") removed++;
	}
	return { added, removed };
}

/**
 * Its lines, each coloured by its kind (classes: the CSP allows no inline style); one the Mac
 * cut short says so after them.
 * @param {string} diff @param {boolean} [truncated]
 */
export function diffHtml(diff, truncated = false) {
	const lines = diff.split("\n").map((line) => `<span class="${lineKind(line)}">${esc(line)}</span>`);
	const note = truncated ? `<p class="note">The diff is cut short here.</p>` : "";
	return `<pre class="diff">${lines.join("\n")}</pre>${note}`;
}
