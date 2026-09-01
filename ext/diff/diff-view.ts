/**
 * Full-screen `/diff` viewer (audit C.6, CC parity): review the working-tree
 * diff before committing. Scrolls freely, jumps between files, and reuses the
 * same colored word-level renderer as the edit-tool preview so a change looks
 * identical wherever you see it.
 */

import { keyText, renderDiff } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	getKeybindings,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../_shared/theme.ts";
import { fitsSideBySide, type SideBySideRow, toSideBySideRows } from "./diff-side-by-side.ts";
import type { ParsedFileDiff } from "./git-diff.ts";
import { summarizeFileDiff } from "./git-diff.ts";
import { renderIntraLineDiff } from "./intra-line.ts";

export interface DiffViewOptions {
	ui: TUI;
	files: ParsedFileDiff[];
	/** What is being diffed, shown in the header (e.g. "working tree" or "HEAD~1"). */
	label: string;
	onClose: () => void;
}

interface DiffLayout {
	width: number;
	sideBySide: boolean;
	lines: string[];
	/** Line index where each file's section starts. */
	fileStarts: number[];
}

/** Gutter between the two panes in side-by-side mode. */
const PANE_GAP = " │ ";

/** Render one side of a row: line number + content, padded/truncated to `width`. */
function pane(cell: { lineNum: string; content: string } | undefined, width: number): string {
	if (!cell) return " ".repeat(width);
	const num = cell.lineNum.padStart(4);
	const text = cell.content.replace(/\t/g, "   ");
	const body = `${num} ${text}`;
	const bodyWidth = visibleWidth(body);
	// pad=true: a double-width char straddling the cut can otherwise leave the truncated result
	// 1+ columns short, shifting the │ gutter left of where every other row puts it.
	return bodyWidth > width ? truncateToWidth(body, width, "...", true) : body + " ".repeat(width - bodyWidth);
}

export class DiffView implements Component, Focusable {
	focused = false;

	private readonly opts: DiffViewOptions;
	private scrollOffset = 0;
	private sideBySide = false;
	private layoutCache: DiffLayout | undefined;

	constructor(opts: DiffViewOptions) {
		this.opts = opts;
	}

	invalidate(): void {
		this.layoutCache = undefined;
	}

	/** Side-by-side only applies when the user asked for it AND the terminal is wide enough. */
	private sideBySideActive(width: number): boolean {
		return this.sideBySide && fitsSideBySide(width);
	}

	private layout(width: number): DiffLayout {
		const sideBySide = this.sideBySideActive(width);
		if (this.layoutCache?.width === width && this.layoutCache.sideBySide === sideBySide) return this.layoutCache;

		const lines: string[] = [];
		const fileStarts: number[] = [];
		for (const file of this.opts.files) {
			if (lines.length > 0) lines.push("");
			fileStarts.push(lines.length);
			lines.push(theme.bold(truncateToWidth(summarizeFileDiff(file), width)));
			if (file.status === "binary") {
				lines.push(theme.fg("muted", "  binary file not shown"));
				continue;
			}
			if (!file.diff) {
				const label = file.modeChange
					? `  mode changed: ${file.modeChange.old} → ${file.modeChange.new}, no content change`
					: file.status === "renamed"
						? "  renamed, no content change"
						: "  no changes";
				lines.push(theme.fg("muted", label));
				continue;
			}
			if (sideBySide) {
				lines.push(...this.renderSideBySide(toSideBySideRows(file.diff), width));
			} else {
				for (const rendered of renderDiff(file.diff).split("\n")) {
					lines.push(truncateToWidth(rendered, width));
				}
			}
		}

		this.layoutCache = { width, sideBySide, lines, fileStarts };
		return this.layoutCache;
	}

	/** Two panes with a gutter; removals left, additions right, context on both. */
	private renderSideBySide(rows: SideBySideRow[], width: number): string[] {
		const paneWidth = Math.max(10, Math.floor((width - PANE_GAP.length) / 2));
		const gap = theme.fg("dim", PANE_GAP);
		return rows.map((row) => {
			if (row.kind === "elision") {
				return theme.fg("muted", "     ...");
			}
			if (row.kind === "change" && row.singleLineChange && row.old && row.new) {
				// Word-level highlighting for a genuine single-line modification, matching
				// renderDiff's unified-mode behavior for the same case (IMPROVEMENT-PLAN.md §5.6a —
				// side-by-side used to color whole panes and never call this, so a one-character
				// typo fix lost precisely what side-by-side exists to show). pane() measures/pads by
				// visible width and already strips ANSI for that, so feeding it pre-highlighted
				// content (embedded theme.inverse spans) is safe; the outer theme.fg wrap below
				// matches renderDiff's own nesting exactly, so it doesn't double-wrap a color.
				const { removedLine, addedLine } = renderIntraLineDiff(
					row.old.content.replace(/\t/g, "   "),
					row.new.content.replace(/\t/g, "   "),
				);
				const left = pane({ lineNum: row.old.lineNum, content: removedLine }, paneWidth);
				const right = pane({ lineNum: row.new.lineNum, content: addedLine }, paneWidth);
				return theme.fg("toolDiffRemoved", left) + gap + theme.fg("toolDiffAdded", right);
			}
			const left = pane(row.old, paneWidth);
			const right = pane(row.new, paneWidth);
			if (row.kind === "context") {
				return theme.fg("toolDiffContext", left) + gap + theme.fg("toolDiffContext", right);
			}
			return (
				(row.old ? theme.fg("toolDiffRemoved", left) : left) +
				gap +
				(row.new ? theme.fg("toolDiffAdded", right) : right)
			);
		});
	}

	/** Visible content rows for the current terminal height. */
	private budget(): number {
		// header (2) + footer (2) — kept in sync with render()
		return Math.max(1, this.opts.ui.terminal.rows - 4);
	}

	private maxScroll(width: number): number {
		return Math.max(0, this.layout(width).lines.length - this.budget());
	}

	private scrollTo(offset: number, width: number): void {
		const next = Math.max(0, Math.min(offset, this.maxScroll(width)));
		if (next === this.scrollOffset) return;
		this.scrollOffset = next;
		this.opts.ui.requestRender();
	}

	/** Jump to the next/previous file heading relative to the current viewport. */
	private jumpFile(direction: 1 | -1, width: number): void {
		const { fileStarts } = this.layout(width);
		if (fileStarts.length === 0) return;
		const target =
			direction === 1
				? fileStarts.find((start) => start > this.scrollOffset)
				: [...fileStarts].reverse().find((start) => start < this.scrollOffset);
		if (target === undefined) return;
		this.scrollTo(target, width);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const width = this.layoutCache?.width ?? this.opts.ui.terminal.columns ?? 80;

		if (kb.matches(data, "tui.select.cancel") || data === "q") {
			this.opts.onClose();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.scrollTo(this.scrollOffset - 1, width);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.scrollTo(this.scrollOffset + 1, width);
			return;
		}
		// The fork branch had named `app.scroll.*` bindings in pi's table; an extension
		// cannot add those, so the two paging keys are matched directly here.
		if (matchesKey(data, Key.pageUp)) {
			this.scrollTo(this.scrollOffset - this.budget(), width);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollTo(this.scrollOffset + this.budget(), width);
			return;
		}
		if (data === "n") {
			this.jumpFile(1, width);
			return;
		}
		if (data === "p") {
			this.jumpFile(-1, width);
			return;
		}
		if (data === "s") {
			if (!fitsSideBySide(width)) {
				// Too narrow to actually split either way: sideBySideActive(width) is false both
				// before and after the flip, so layout() returns the identical cached layout and
				// re-anchoring to the file start would throw away the scroll position for a toggle
				// that visibly changed nothing (IMPROVEMENT-PLAN.md §5.6c follow-up — the file-anchor
				// fix below still lost position in exactly this case). Flip the flag so a later
				// resize honors the request, but leave scrollOffset untouched.
				this.sideBySide = !this.sideBySide;
				this.opts.ui.requestRender();
				return;
			}
			// Unified and side-by-side have different line counts for the same diff (a change-run
			// compresses into paired rows in side-by-side), so the raw scrollOffset can't carry over
			// as-is — it would land on unrelated content. Anchor on the FILE instead: find which
			// file the viewport is currently inside via the old layout's fileStarts, then jump to
			// that same file's start in the new layout (IMPROVEMENT-PLAN.md §5.6c — toggling used to
			// throw the position away entirely, always resetting to the top of the first file).
			const oldFileStarts = this.layout(width).fileStarts;
			const fileIndex = Math.max(0, oldFileStarts.filter((start) => start <= this.scrollOffset).length - 1);
			this.sideBySide = !this.sideBySide;
			this.layoutCache = undefined;
			const newFileStarts = this.layout(width).fileStarts;
			this.scrollOffset = newFileStarts[Math.min(fileIndex, newFileStarts.length - 1)] ?? 0;
			this.opts.ui.requestRender();
			return;
		}
		if (data === "g") {
			this.scrollTo(0, width);
			return;
		}
		if (data === "G") {
			this.scrollTo(this.maxScroll(width), width);
		}
	}

	render(width: number): string[] {
		const rows = this.opts.ui.terminal.rows;
		const layout = this.layout(width);
		const fileCount = this.opts.files.length;
		const insertions = this.opts.files.reduce((sum, f) => sum + f.insertions, 0);
		const deletions = this.opts.files.reduce((sum, f) => sum + f.deletions, 0);

		const stats =
			fileCount === 0
				? "no changes"
				: `${fileCount} file${fileCount === 1 ? "" : "s"}, +${insertions} -${deletions}`;
		const header = [
			truncateToWidth(`${theme.bold(`Diff — ${this.opts.label}`)}  ${theme.fg("muted", stats)}`, width),
			"",
		];
		const hints = [
			// The conditional hint goes first: it's the one that changes with mode/width, and on a
			// narrow terminal it's the most important thing to survive truncation — "too narrow to
			// split" is the direct answer to "why didn't `s` do anything", asked exactly on the
			// terminal size that triggers it (IMPROVEMENT-PLAN.md §5.5 regression, fixed here).
			this.sideBySide ? (fitsSideBySide(width) ? "s unified" : "s unified (too narrow to split)") : "s side-by-side",
			`${keyText("tui.select.up")}/${keyText("tui.select.down")} scroll`,
			"n/p file",
			"g/G top/bottom",
			`${keyText("tui.select.cancel")} close`,
		];
		const footer = [
			theme.fg("dim", "─".repeat(Math.max(0, width))),
			truncateToWidth(theme.fg("dim", hints.join(" · ")), width),
		];

		const budget = Math.max(1, rows - header.length - footer.length);
		if (layout.lines.length === 0) {
			const body = [theme.fg("dim", "(working tree is clean)")];
			return [...header, ...body, ...Array(Math.max(0, budget - body.length)).fill(""), ...footer];
		}

		// Clamp here too: the terminal may have grown since the last scroll.
		const maxStart = Math.max(0, layout.lines.length - budget);
		if (this.scrollOffset > maxStart) this.scrollOffset = maxStart;

		const body = layout.lines.slice(this.scrollOffset, this.scrollOffset + budget);
		const pad = Math.max(0, budget - body.length);
		return [...header, ...body, ...Array(pad).fill(""), ...footer];
	}
}
