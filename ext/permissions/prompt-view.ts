/**
 * The permission prompt as Claude Code draws it: numbered rows (a digit picks one),
 * one `No` row, and Tab on `No` to type what the model should do instead.
 *
 * Only the interactive TUI can show it. pi's RPC mode (FleetView's background
 * sessions) answers `ui.custom` with `undefined`, so the caller falls back to
 * `ui.select` there — the same rows, with the note as a row of its own.
 */

import { getKeybindings, Input, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

/** What the user picked: the row's index into `options`, or a No with an optional note. */
export type ProceedAnswer = { kind: "option"; index: number } | { kind: "no"; note?: string };

export interface ProceedTheme {
	fg(color: "accent" | "dim" | "muted" | "text", text: string): string;
	bold(text: string): string;
}

export class ProceedPrompt {
	private selected = 0;
	/** The note field, while the user is typing one on the No row. */
	private note: Input | undefined;
	private readonly title: string;
	private readonly options: string[];
	private readonly theme: ProceedTheme;
	private readonly done: (answer: ProceedAnswer) => void;

	/**
	 * `options` are the rows above `No` ("Yes", then an optional standing grant); `No`
	 * is always the last row.
	 */
	constructor(title: string, options: string[], theme: ProceedTheme, done: (answer: ProceedAnswer) => void) {
		this.title = title;
		this.options = options;
		this.theme = theme;
		this.done = done;
	}

	private get noIndex(): number {
		return this.options.length;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.note) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.note = undefined;
			} else if (kb.matches(data, "tui.input.submit") || data === "\r" || data === "\n") {
				this.done({ kind: "no", note: this.note.getValue().trim() || undefined });
			} else {
				this.note.handleInput(data);
			}
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.done({ kind: "no" });
		} else if (kb.matches(data, "tui.select.up") || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
		} else if (kb.matches(data, "tui.select.down") || data === "j") {
			this.selected = Math.min(this.noIndex, this.selected + 1);
		} else if (/^[1-9]$/.test(data) && Number(data) <= this.noIndex + 1) {
			this.pick(Number(data) - 1);
		} else if (matchesKey(data, "tab") && this.selected === this.noIndex) {
			this.note = new Input();
			this.note.focused = true;
		} else if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			this.pick(this.selected);
		}
	}

	private pick(index: number): void {
		this.done(index === this.noIndex ? { kind: "no" } : { kind: "option", index });
	}

	render(width: number): string[] {
		const theme = this.theme;
		// One column of margin, as pi's own dialogs have, under a rule that sets the
		// dialog off from the transcript.
		const inner = Math.max(1, width - 1);
		const lines: string[] = [];
		const [heading = "", ...rest] = this.title.split("\n");
		lines.push(...wrapTextWithAnsi(theme.bold(heading), inner));
		for (const line of rest) lines.push(...wrapTextWithAnsi(line, inner));
		lines.push("");
		const rows = [...this.options, "No"];
		rows.forEach((label, i) => {
			const active = i === this.selected;
			const prefix = `${active ? "❯" : " "} ${i + 1}. `;
			if (i === this.noIndex && this.note) {
				// Input draws its own "> " prompt; the row reads "No, <note>" instead.
				const field = (this.note.render(Math.max(3, inner - prefix.length - 2))[0] ?? "").replace(/^> /, "");
				lines.push(`${theme.fg("accent", `${prefix}No,`)} ${field}`);
				return;
			}
			const text = i === this.noIndex && active ? `${label} ${theme.fg("dim", "(tab to add a note)")}` : label;
			lines.push(active ? theme.fg("accent", `${prefix}${text}`) : `${prefix}${text}`);
		});
		lines.push("");
		lines.push(
			theme.fg(
				"dim",
				this.note ? "Enter to send · Esc to go back" : "Esc to cancel · Tab to add a note · ↑↓ or 1-9 to choose",
			),
		);
		return [
			theme.fg("dim", "─".repeat(Math.max(1, width))),
			...lines.map((line) => truncateToWidth(` ${line}`, width)),
		];
	}

	invalidate(): void {}
}
