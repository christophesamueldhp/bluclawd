import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

export interface WelcomeSidebarSection {
	/** Section heading, e.g. "Tips for getting started" */
	heading: string;
	/** Pre-themed body lines, truncated (not wrapped) to the pane width */
	lines: string[];
}

export interface WelcomeBoxInfo {
	/** Plain text embedded in the top border, e.g. "bluclawd v0.80.6" */
	title: string;
	/** Pre-themed lines rendered centered inside the box (the left pane in two-pane mode) */
	rows: string[];
	/** Right-pane sections; with enough width they render beside `rows`, Claude Code-style */
	sidebar?: WelcomeSidebarSection[];
}

/** Minimum inner width for the two-pane layout; below this the sidebar is dropped. */
const MIN_TWO_PANE_INNER = 62;

/** Minimum inner width for the boxed title layout; below this, the single-line fallback (the
 *  plain title, truncated to the full terminal width instead of squeezed into the border) is
 *  used instead. The boxed title's own budget is `inner - 4` (2 dash columns + 2 padding spaces
 *  on each side of the title) — at the previous threshold of 8, that left only 4 columns for the
 *  title, of which the default "..." ellipsis (3 columns) ate all but one real character, so a
 *  narrow terminal showed something like "b..." instead of the app name (IMPROVEMENT-PLAN.md
 *  §5.7). 11 leaves 7 columns (4 real characters + the ellipsis) — enough to still read as the
 *  app name rather than as noise. */
const MIN_BOXED_INNER = 11;

/** Share of the inner width given to the left (welcome) pane in two-pane mode. */
const LEFT_PANE_RATIO = 0.55;

/**
 * Claude Code-style welcome banner: a rounded, accent-colored box with the app
 * title embedded left-aligned in the top border. When sidebar sections are
 * provided and the terminal is wide enough, the box splits into two panes —
 * welcome content on the left, tips/what's-new on the right — separated by a
 * vertical border, mirroring Claude Code's startup header.
 */
export class WelcomeBox implements Component {
	private readonly getInfo: () => WelcomeBoxInfo;

	constructor(getInfo: () => WelcomeBoxInfo) {
		this.getInfo = getInfo;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { title, rows, sidebar } = this.getInfo();
		// 1 column outer margin on each side, 2 border columns
		const boxWidth = width - 2;
		const inner = boxWidth - 2;
		if (inner < MIN_BOXED_INNER) {
			return [truncateToWidth(theme.bold(theme.fg("accent", title)), Math.max(1, width))];
		}

		const border = (text: string) => theme.fg("borderAccent", text);
		const margin = " ";
		const lines: string[] = [];

		// Top border with the title left-aligned inside it (Claude Code style)
		const dashLeft = 2;
		const titleText = ` ${truncateToWidth(title, inner - dashLeft - 2)} `;
		const dashRight = Math.max(0, inner - dashLeft - visibleWidth(titleText));
		lines.push(
			margin +
				border(`╭${"─".repeat(dashLeft)}`) +
				theme.bold(theme.fg("accent", titleText)) +
				border(`${"─".repeat(dashRight)}╮`),
		);

		const centerCell = (row: string, cellWidth: number): string => {
			const text = truncateToWidth(row, cellWidth);
			const textWidth = visibleWidth(text);
			const padLeft = Math.max(0, Math.floor((cellWidth - textWidth) / 2));
			const padRight = Math.max(0, cellWidth - textWidth - padLeft);
			return " ".repeat(padLeft) + text + " ".repeat(padRight);
		};

		const sections = sidebar ?? [];
		if (sections.length > 0 && inner >= MIN_TWO_PANE_INNER) {
			// Two panes split by a vertical border: left + right + 1 divider = inner
			const leftWidth = Math.floor(inner * LEFT_PANE_RATIO);
			const rightWidth = inner - leftWidth - 1;
			const rightInner = rightWidth - 2; // 1 column padding on each side

			const rightRows: string[] = [];
			for (const [index, section] of sections.entries()) {
				if (index > 0) {
					rightRows.push(` ${border("─".repeat(rightInner))} `);
				}
				const heading = truncateToWidth(theme.bold(theme.fg("accent", section.heading)), rightInner);
				rightRows.push(` ${heading}${" ".repeat(Math.max(0, rightInner - visibleWidth(heading)))} `);
				for (const line of section.lines) {
					const text = truncateToWidth(line, rightInner, "…");
					rightRows.push(` ${text}${" ".repeat(Math.max(0, rightInner - visibleWidth(text)))} `);
				}
			}

			const rowCount = Math.max(rows.length, rightRows.length);
			for (let i = 0; i < rowCount; i++) {
				const leftCell = centerCell(rows[i] ?? "", leftWidth);
				const rightCell = rightRows[i] ?? " ".repeat(rightWidth);
				lines.push(margin + border("│") + leftCell + border("│") + rightCell + border("│"));
			}
		} else {
			for (const row of rows) {
				lines.push(margin + border("│") + centerCell(row, inner) + border("│"));
			}
		}

		lines.push(margin + border(`╰${"─".repeat(inner)}╯`));
		return lines;
	}
}
