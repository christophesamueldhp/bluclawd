import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, styleTextWithAnsi, truncateToWidth } from "@earendil-works/pi-tui";

export const AUTO_THEME = "bluclawd-light/bluclawd";

const BUILTIN_THEME_OPTIONS: ThemeOption[] = [
	{ label: "Auto (match terminal)", value: AUTO_THEME },
	{ label: "Dark mode", value: "bluclawd" },
	{ label: "Light mode", value: "bluclawd-light" },
	{ label: "Dark mode (colorblind-friendly)", value: "bluclawd-dark-daltonized" },
	{ label: "Light mode (colorblind-friendly)", value: "bluclawd-light-daltonized" },
	{ label: "Dark mode (ANSI colors only)", value: "bluclawd-dark-ansi" },
	{ label: "Light mode (ANSI colors only)", value: "bluclawd-light-ansi" },
];

const DEMO_DIFF = [
	" 1 function greet() {",
	'-2   console.log("Hello, World!");',
	'+2   console.log("Hello, bluclawd!");',
	" 3 }",
].join("\n");

const PAD = 2;
const POINTER = "❯";
const CHECK = "✔";
const PERMISSION_COLOR = "mdCode";
const ITALIC = (text: string) => styleTextWithAnsi(text, undefined, undefined, { italic: true });

export interface ThemeOption {
	label: string;
	value: string;
}

export function themeOptions(installed: string[]): ThemeOption[] {
	const own = new Set(BUILTIN_THEME_OPTIONS.map((option) => option.value));
	const others = installed.filter((name) => !own.has(name)).sort();
	return [...BUILTIN_THEME_OPTIONS, ...others.map((name) => ({ label: name, value: name }))];
}

export class ThemePicker implements Component {
	private index: number;
	private readonly theme: Theme;
	private readonly options: ThemeOption[];
	private readonly savedSetting: string | undefined;
	private readonly preview: (value: string) => void;
	private readonly done: (value: string | undefined) => void;

	constructor(
		theme: Theme,
		options: ThemeOption[],
		savedSetting: string | undefined,
		preview: (value: string) => void,
		done: (value: string | undefined) => void,
	) {
		this.theme = theme;
		this.options = options;
		this.savedSetting = savedSetting;
		this.preview = preview;
		this.done = done;
		this.index = Math.max(
			0,
			options.findIndex((option) => option.value === savedSetting),
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
		const rule = (char: string, color: typeof PERMISSION_COLOR | "dim") =>
			t.fg(color, char.repeat(Math.max(0, width)));

		const out = ["", rule("─", PERMISSION_COLOR)];
		out.push(line(t.bold(t.fg(PERMISSION_COLOR, "Theme"))), "");
		out.push(line(t.bold("Choose the text style that looks best with your terminal")), "");
		this.options.forEach((option, i) => {
			const focused = i === this.index;
			const pointer = focused ? t.fg(PERMISSION_COLOR, POINTER) : " ";
			const check = option.value === this.savedSetting ? t.fg("success", CHECK) : " ";
			const label = focused ? t.fg(PERMISSION_COLOR, option.label) : option.label;
			out.push(line(`${pointer} ${check} ${label}`));
		});
		out.push("", rule("╌", "dim"));
		for (const diffLine of renderDiff(DEMO_DIFF).split("\n")) out.push(line(diffLine));
		out.push(rule("╌", "dim"), "");
		out.push(`${pad}${truncateToWidth(t.fg("dim", ITALIC("Enter to select · Esc to cancel")), inner, "…")}`);
		return out;
	}
}
