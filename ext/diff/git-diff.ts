/**
 * Unified-diff parsing for the `/diff` viewer (audit C.6).
 *
 * `git diff` is the source of truth — it already handles renames, binary
 * files, mode changes, staged vs unstaged, and submodules. This module only
 * translates its unified output into the display-diff shape `renderDiff()`
 * consumes (`"+123 content"` / `"-123 content"` / `" 123 content"`), which is
 * why nothing here reconstructs file contents.
 */

export interface ParsedFileDiff {
	/** Post-image path (pre-image path for a deletion). */
	path: string;
	/** Pre-image path when git reported a rename/copy, else undefined. */
	oldPath?: string;
	status: "modified" | "added" | "deleted" | "renamed" | "binary";
	/** Lines in renderDiff's display-diff format; empty for pure renames/binary. */
	diff: string;
	insertions: number;
	deletions: number;
	/** Set when git reported `old mode`/`new mode` (e.g. a bare `chmod +x`) — the only signal
	 *  that a file with no content diff still genuinely changed (IMPROVEMENT-PLAN.md §5.6d). */
	modeChange?: { old: string; new: string };
}

/** `a/src/x.ts` → `src/x.ts`; leaves paths that lack the prefix alone. */
function stripPrefix(path: string): string {
	if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
	return path;
}

/** Split `diff --git a/x b/y` honoring the (rare) quoted form git uses for odd paths. */
function pathsFromHeader(header: string): { oldPath: string; newPath: string } | undefined {
	const rest = header.slice("diff --git ".length);
	if (!rest) return undefined;

	// Quoted form: git quotes only when a path contains control chars or quotes.
	const quoted = rest.match(/^"(.+?)" "(.+?)"$/);
	if (quoted) return { oldPath: stripPrefix(quoted[1]), newPath: stripPrefix(quoted[2]) };

	// Unquoted paths may contain SPACES ("a/my file.txt b/my file.txt"), so a
	// whitespace split drops the file entirely. Split on the " b/" boundary,
	// preferring the split that makes both halves agree on their prefixes.
	for (let i = rest.indexOf(" b/"); i !== -1; i = rest.indexOf(" b/", i + 1)) {
		const oldPath = rest.slice(0, i);
		const newPath = rest.slice(i + 1);
		if (oldPath.startsWith("a/")) return { oldPath: stripPrefix(oldPath), newPath: stripPrefix(newPath) };
	}

	// No a/ b/ prefixes (--no-prefix, or --no-index against /dev/null): fall back
	// to halving on the midpoint space when both sides are identical.
	const half = rest.length >>> 1;
	if (rest[half] === " " && rest.slice(0, half) === rest.slice(half + 1)) {
		return { oldPath: rest.slice(0, half), newPath: rest.slice(half + 1) };
	}
	const space = rest.lastIndexOf(" ");
	if (space <= 0) return undefined;
	return { oldPath: stripPrefix(rest.slice(0, space)), newPath: stripPrefix(rest.slice(space + 1)) };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff` (unified format) into per-file display diffs.
 * Unknown or malformed sections are skipped rather than throwing — a viewer
 * must never crash on an exotic diff.
 */
export function parseUnifiedDiff(raw: string): ParsedFileDiff[] {
	const files: ParsedFileDiff[] = [];
	const lines = raw.split("\n");

	let current: ParsedFileDiff | undefined;
	let oldLineNo = 0;
	let newLineNo = 0;
	let inHunk = false;
	const out: string[] = [];

	const flush = () => {
		if (!current) return;
		current.diff = out.join("\n");
		files.push(current);
		out.length = 0;
	};

	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			flush();
			const paths = pathsFromHeader(line);
			current = paths
				? { path: paths.newPath, status: "modified", diff: "", insertions: 0, deletions: 0 }
				: undefined;
			inHunk = false;
			continue;
		}
		if (!current) continue;

		if (line.startsWith("new file mode")) {
			current.status = "added";
			continue;
		}
		if (line.startsWith("deleted file mode")) {
			current.status = "deleted";
			continue;
		}
		if (line.startsWith("rename from ")) {
			current.oldPath = line.slice("rename from ".length);
			current.status = "renamed";
			continue;
		}
		if (line.startsWith("rename to ")) {
			current.path = line.slice("rename to ".length);
			continue;
		}
		if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
			current.status = "binary";
			continue;
		}
		// A bare chmod (no content change) is otherwise indistinguishable from an untouched file —
		// current.diff stays "" since there's no hunk, and the viewer would say "no changes"
		// despite the file genuinely having changed (IMPROVEMENT-PLAN.md §5.6d).
		if (!inHunk && line.startsWith("old mode ")) {
			current.modeChange = { old: line.slice("old mode ".length), new: current.modeChange?.new ?? "" };
			continue;
		}
		if (!inHunk && line.startsWith("new mode ")) {
			current.modeChange = { old: current.modeChange?.old ?? "", new: line.slice("new mode ".length) };
			continue;
		}
		// Header noise that carries no content. Only recognized BEFORE the first
		// hunk: inside a hunk `--- x` is a REMOVED line whose content begins with
		// `-- ` (SQL/Lua/Haskell comments, markdown rules, YAML frontmatter), and
		// swallowing it drops the line, its count, and the old-side numbering.
		if (
			!inHunk &&
			(line.startsWith("index ") ||
				line.startsWith("--- ") ||
				line.startsWith("+++ ") ||
				line.startsWith("similarity index ") ||
				line.startsWith("copy from ") ||
				line.startsWith("copy to "))
		) {
			continue;
		}

		const hunk = line.match(HUNK_HEADER);
		if (hunk) {
			// Elision marker between hunks, matching the edit-tool preview style.
			if (out.length > 0) out.push("     ...");
			oldLineNo = Number.parseInt(hunk[1], 10);
			newLineNo = Number.parseInt(hunk[3], 10);
			inHunk = true;
			continue;
		}

		const marker = line[0];
		const content = line.slice(1);
		if (marker === "+") {
			out.push(`+${String(newLineNo).padStart(4)} ${content}`);
			newLineNo += 1;
			current.insertions += 1;
		} else if (marker === "-") {
			out.push(`-${String(oldLineNo).padStart(4)} ${content}`);
			oldLineNo += 1;
			current.deletions += 1;
		} else if (marker === " ") {
			out.push(` ${String(newLineNo).padStart(4)} ${content}`);
			oldLineNo += 1;
			newLineNo += 1;
		}
		// "\ No newline at end of file" and blank trailing lines fall through.
	}
	flush();
	return files;
}

/** One-line summary for a file, e.g. `src/x.ts  +12 -3`. */
export function summarizeFileDiff(file: ParsedFileDiff): string {
	const name = file.oldPath && file.status === "renamed" ? `${file.oldPath} → ${file.path}` : file.path;
	if (file.status === "binary") return `${name}  (binary)`;
	const parts: string[] = [];
	if (file.insertions > 0) parts.push(`+${file.insertions}`);
	if (file.deletions > 0) parts.push(`-${file.deletions}`);
	if (file.modeChange) parts.push(`${file.modeChange.old} → ${file.modeChange.new}`);
	return parts.length > 0 ? `${name}  ${parts.join(" ")}` : name;
}
