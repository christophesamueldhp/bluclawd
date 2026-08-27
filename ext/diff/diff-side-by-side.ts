/**
 * Side-by-side diff layout (audit C.6, second half).
 *
 * Takes the same display-diff text `renderDiff` consumes (`"+123 content"` /
 * `"-123 content"` / `" 123 content"` / `"     ..."`) and pairs it into old|new
 * rows: a run of removed lines is zipped with the run of added lines that
 * follows it, so a modified line sits opposite its replacement. Context lines
 * appear on both sides; elision markers span the row.
 *
 * Pure and layout-only — no colors here. The caller styles each side, which
 * keeps this testable on plain strings.
 */

export interface SideBySideRow {
	kind: "context" | "change" | "elision";
	old?: { lineNum: string; content: string };
	new?: { lineNum: string; content: string };
	/** True when this row's whole change-run was exactly one removed line paired with exactly one
	 *  added line — the same "single line modification" signal `renderDiff` uses to decide when
	 *  word-level (intra-line) highlighting applies (IMPROVEMENT-PLAN.md §5.6a). A multi-line run
	 *  can still produce a row where both `old` and `new` happen to be set (index `r` valid on
	 *  both sides), so this can't be inferred from their presence alone. */
	singleLineChange?: boolean;
}

const DIFF_LINE = /^([+-\s])(\s*\d*)\s(.*)$/;
/** The elision marker between hunks. It also matches DIFF_LINE as a numberless
 *  context line, so it has to be recognized before parsing. */
const ELISION = /^\s*\.\.\.\s*$/;

function parse(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(DIFF_LINE);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2].trim(), content: match[3] };
}

/** Pair a display diff into side-by-side rows. */
export function toSideBySideRows(diffText: string): SideBySideRow[] {
	const lines = diffText.split("\n");
	const rows: SideBySideRow[] = [];

	let i = 0;
	while (i < lines.length) {
		if (ELISION.test(lines[i])) {
			rows.push({ kind: "elision" });
			i++;
			continue;
		}
		const parsed = parse(lines[i]);

		// An unparseable line renders as a blank elision marker — its own text is dropped, not
		// spanned. Defensive only: parseUnifiedDiff (the sole producer of `file.diff`) never emits
		// anything but the four shapes DIFF_LINE/ELISION already cover, so this is unreachable
		// through /diff today — kept unreachable by the round-trip test below.
		if (!parsed) {
			rows.push({ kind: "elision" });
			i++;
			continue;
		}

		if (parsed.prefix === " ") {
			rows.push({
				kind: "context",
				old: { lineNum: parsed.lineNum, content: parsed.content },
				new: { lineNum: parsed.lineNum, content: parsed.content },
			});
			i++;
			continue;
		}

		// A change block: every consecutive removal, then every consecutive addition.
		const removed: Array<{ lineNum: string; content: string }> = [];
		while (i < lines.length) {
			const p = parse(lines[i]);
			if (!p || p.prefix !== "-") break;
			removed.push({ lineNum: p.lineNum, content: p.content });
			i++;
		}
		const added: Array<{ lineNum: string; content: string }> = [];
		while (i < lines.length) {
			const p = parse(lines[i]);
			if (!p || p.prefix !== "+") break;
			added.push({ lineNum: p.lineNum, content: p.content });
			i++;
		}

		const singleLineChange = removed.length === 1 && added.length === 1;
		for (let r = 0; r < Math.max(removed.length, added.length); r++) {
			rows.push({ kind: "change", old: removed[r], new: added[r], singleLineChange });
		}
	}

	return rows;
}

/** Minimum width worth splitting; below this the caller should stay unified. */
export const MIN_SIDE_BY_SIDE_WIDTH = 90;

export function fitsSideBySide(width: number): boolean {
	return width >= MIN_SIDE_BY_SIDE_WIDTH;
}
