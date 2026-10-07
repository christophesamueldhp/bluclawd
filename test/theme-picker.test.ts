import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { stripAnsi } from "../ext/_shared/ansi.ts";
import { AUTO_THEME, ThemePicker, themeOptions } from "../ext/branding/theme-picker.ts";

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as any;
const UP = "\x1b[A";
const DOWN = "\x1b[B";

beforeAll(() => {
	// The demo diff is drawn by pi's renderDiff, which reads pi's global theme.
	initTheme("dark");
});

function open(current: string | undefined, installed = ["bluclawd", "bluclawd-light", "dark", "system"]) {
	const state = { previews: [] as string[], result: "open" as string | undefined };
	const picker = new ThemePicker(
		theme,
		themeOptions(installed),
		current,
		(value) => state.previews.push(value),
		(value) => {
			state.result = value;
		},
	);
	const screen = () => stripAnsi(picker.render(80).join("\n"));
	return { picker, state, screen };
}

describe("/theme picker (Claude Code's ThemePicker)", () => {
	it("lists Claude Code's themes in its words, then the other installed themes", () => {
		const out = open("bluclawd").screen();
		expect(
			out.startsWith(
				`\n${"─".repeat(80)}\n  Theme\n\n  Choose the text style that looks best with your terminal\n\n`,
			),
		).toBe(true);
		expect(out).toContain(
			[
				"      Auto (match terminal)",
				"  ❯ ✔ Dark mode",
				"      Light mode",
				"      Dark mode (colorblind-friendly)",
				"      Light mode (colorblind-friendly)",
				"      Dark mode (ANSI colors only)",
				"      Light mode (ANSI colors only)",
				"      dark",
				"      system",
			].join("\n"),
		);
		expect(out.endsWith("\n\n  Enter to select · Esc to cancel")).toBe(true);
	});

	it("shows Claude Code's demo.js diff", () => {
		const out = open("bluclawd").screen();
		expect(out).toContain(" 1 function greet() {");
		expect(out).toContain('-2   console.log("Hello, World!");');
		expect(out).toContain('+2   console.log("Hello, Claude!");');
		expect(out).toContain(" 3 }");
	});

	it("checks the Auto row when the saved setting is the pair", () => {
		expect(open(AUTO_THEME).screen()).toContain("  ❯ ✔ Auto (match terminal)");
	});

	it("starts on the first row when the saved theme is not listed", () => {
		const out = open("gone").screen();
		expect(out).toContain("  ❯   Auto (match terminal)");
		expect(out).not.toContain("✔");
	});

	it("previews each theme the cursor lands on, and stops at the ends", () => {
		const { picker, state } = open(AUTO_THEME);
		picker.handleInput(UP);
		picker.handleInput(DOWN);
		picker.handleInput(DOWN);
		expect(state.previews).toEqual(["bluclawd", "bluclawd-light"]);
		for (let i = 0; i < 20; i++) picker.handleInput(DOWN);
		expect(state.previews.at(-1)).toBe("system");
	});

	it("enter selects the focused theme; esc cancels", () => {
		const selected = open("bluclawd");
		selected.picker.handleInput(DOWN);
		selected.picker.handleInput("\r");
		expect(selected.state.result).toBe("bluclawd-light");

		const cancelled = open("bluclawd");
		cancelled.picker.handleInput(DOWN);
		cancelled.picker.handleInput("\x1b");
		expect(cancelled.state.result).toBeUndefined();
	});
});
