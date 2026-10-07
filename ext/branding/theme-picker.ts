/**
 * The interactive `/theme` picker, laid out as Claude Code's ThemePicker: the
 * title, the prompt, one row per theme with a check on the current one, and a
 * `demo.js` diff below that shows the focused theme while the cursor moves.
 *
 * Claude Code's six themes come first, under its own labels; every other theme
 * pi knows follows by name, as Claude Code lists custom themes after its own.
 */

import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, truncateToWidth } from "@earendil-works/pi-tui";

/** pi's light/dark pair setting: the theme follows the terminal's appearance. */
export const AUTO_THEME = "bluclawd-light/bluclawd";

const CLAUDE_CODE_THEMES: ThemeOption[] = [
	{ label: "Auto (match terminal)", value: AUTO_THEME },
	{ label: "Dark mode", value: "bluclawd" },
	{ label: "Light mode", value: "bluclawd-light" },
	{ label: "Dark mode (colorblind-friendly)", value: "bluclawd-dark-daltonized" },
	{ label: "Light mode (colorblind-friendly)", value: "bluclawd-light-daltonized" },
	{ label: "Dark mode (ANSI colors only)", value: "bluclawd-dark-ansi" },
	{ label: "Light mode (ANSI colors only)", value: "bluclawd-light-ansi" },
];

/** Claude Code's sample: line 2 of `greet` changes from World to Claude. */
const DEMO_DIFF = [
	" 1 function greet() {",
	'-2   console.log("Hello, World!");',
	'+2   console.log("Hello, Claude!");',
	" 3 }",
].join("\n");

const PAD = 2;
const POINTER = "❯";
const CHECK = "✔";
const ITALIC = (text: string) => `\x1b[3m${text}\x1b[23m`;

export interface ThemeOption {
	label: string;
	value: string;
}

/** Claude Code's rows, then every other installed theme by name. */
export function themeOptions(installed: string[]): ThemeOption[] {
	const own = new Set(CLAUDE_CODE_THEMES.map((option) => option.value));
	const others = installed.filter((name) => !own.has(name)).sort();
	return [...CLAUDE_CODE_THEMES, ...others.map((name) => ({ label: name, value: name }))];
}

export class ThemePicker implements Component {
	private index: number;
	private readonly theme: Theme;
	private readonly options: ThemeOption[];
	/** The saved setting, which gets the check. */
	private readonly current: string | undefined;
	private readonly preview: (value: string) => void;
	private readonly done: (value: string | undefined) => void;

	constructor(
		theme: Theme,
		options: ThemeOption[],
		current: string | undefined,
		preview: (value: string) => void,
		done: (value: string | undefined) => void,
	) {
		this.theme = theme;
		this.options = options;
		this.current = current;
		this.preview = preview;
		this.done = done;
		this.index = Math.max(
			0,
			options.findIndex((option) => option.value === current),
		);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.done(this.options[this.index].value);
			return;
		}
		const step = kb.matches(data, "tui.select.up") ? -1 : kb.matches(data, "tui.select.down") ? 1 : 0;
		const next = Math.max(0, Math.min(this.options.length - 1, this.index + step));
		if (next === this.index) return;
		this.index = next;
		this.preview(this.options[next].value);
	}

	render(width: number): string[] {
		const t = this.theme;
		const pad = " ".repeat(PAD);
		const inner = Math.max(1, width - 2 * PAD);
		const line = (text: string) => (text === "" ? "" : truncateToWidth(`${pad}${text}`, width, "…"));
		const rule = (char: string, color: "mdLink" | "dim") => t.fg(color, char.repeat(Math.max(0, width)));

		const out = ["", rule("─", "mdLink")];
		out.push(line(t.bold(t.fg("mdLink", "Theme"))), "");
		out.push(line(t.bold("Choose the text style that looks best with your terminal")), "");
		this.options.forEach((option, i) => {
			const focused = i === this.index;
			const pointer = focused ? t.fg("mdLink", POINTER) : " ";
			const check = option.value === this.current ? t.fg("success", CHECK) : " ";
			const label = focused ? t.fg("mdLink", option.label) : option.label;
			out.push(line(`${pointer} ${check} ${label}`));
		});
		out.push("", rule("╌", "dim"));
		for (const diffLine of renderDiff(DEMO_DIFF).split("\n")) out.push(line(diffLine));
		out.push(rule("╌", "dim"), "");
		out.push(`${pad}${truncateToWidth(t.fg("dim", ITALIC("Enter to select · Esc to cancel")), inner, "…")}`);
		return out;
	}
}
