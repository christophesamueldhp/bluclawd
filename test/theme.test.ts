import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The bluclawd theme is Claude Code's dark palette, extracted from the 2.1.259
 * binary (the theme object identified by `permission:"rgb(177,185,249)"` +
 * `bashBorder:"rgb(253,93,177)"`). These assertions pin the values that came
 * from there, so a future edit cannot quietly reintroduce the Catppuccin
 * palette the theme originally shipped with.
 *
 * The file is read and its `vars` indirection resolved here rather than through
 * pi's own loader: `loadThemeFromPath` is declared in pi's types but is not a
 * runtime export of the package root. That pi can actually LOAD this file is
 * covered by the live check in the README's verify recipe (`[Themes] bluclawd`
 * with no "Theme not found"), not by this test.
 */
const raw = readFileSync("./themes/bluclawd.json", "utf8");
const parsed = JSON.parse(raw) as {
	name: string;
	vars: Record<string, string>;
	colors: Record<string, string>;
	export: Record<string, string>;
};

/** Follow `vars` references until a literal `#rrggbb` falls out, as pi does. */
function resolve(value: string, seen = new Set<string>()): string {
	if (value.startsWith("#")) return value;
	if (seen.has(value)) throw new Error(`cyclic var reference: ${value}`);
	seen.add(value);
	const next = parsed.vars[value];
	if (next === undefined) throw new Error(`unresolved var: ${value}`);
	return resolve(next, seen);
}

const color = (token: string): string => resolve(parsed.colors[token] ?? `<missing ${token}>`);

describe("bluclawd theme", () => {
	it("declares the name pi resolves it by", () => {
		expect(parsed.name).toBe("bluclawd");
	});

	it("uses Claude Code's dark values for the shared semantic colours", () => {
		expect(color("text")).toBe("#ffffff");
		expect(color("muted")).toBe("#999999");
		expect(color("dim")).toBe("#505050");
		expect(color("border")).toBe("#888888");
		expect(color("success")).toBe("#4eba65");
		expect(color("error")).toBe("#ff6b80");
		expect(color("warning")).toBe("#ffc107");
		expect(color("bashMode")).toBe("#fd5db1");
		expect(color("mdLink")).toBe("#b1b9f9");
	});

	it("keeps the bluclawd mascot cyan as the accent", () => {
		expect(color("accent")).toBe("#00c0e8");
	});

	it("colours diff text with CC's word-level diff colours", () => {
		// pi's toolDiff* are FOREGROUND tokens, so CC's diffAddedWord/diffRemovedWord
		// are the right source — not diffAdded/diffRemoved, which are its backgrounds.
		expect(color("toolDiffAdded")).toBe("#38a660");
		expect(color("toolDiffRemoved")).toBe("#b3596b");
	});

	it("ramps thinking levels over CC's rainbow, ending on its ultra purple", () => {
		expect(color("thinkingOff")).toBe("#505050");
		expect(color("thinkingMinimal")).toBe("#82aadc");
		expect(color("thinkingLow")).toBe("#91c882");
		expect(color("thinkingMedium")).toBe("#fac35f");
		expect(color("thinkingHigh")).toBe("#f58b57");
		expect(color("thinkingXhigh")).toBe("#eb5f57");
		expect(color("thinkingMax")).toBe("#af87ff");
	});

	it("draws syntax highlighting from CC's own subagent palette", () => {
		expect(color("syntaxKeyword")).toBe("#827dbd");
		expect(color("syntaxFunction")).toBe("#6a9bcc");
		expect(color("syntaxType")).toBe("#ca8a04");
		expect(color("syntaxOperator")).toBe("#0891b2");
		expect(color("syntaxNumber")).toBe("#d77757");
		expect(color("syntaxString")).toBe("#4eba65");
	});

	it("uses CC's backgrounds", () => {
		expect(color("selectedBg")).toBe("#264f78");
		expect(color("userMessageBg")).toBe("#373737");
		expect(color("customMessageBg")).toBe("#374146");
		expect(color("toolPendingBg")).toBe("#262626");
		expect(color("toolSuccessBg")).toBe("#225c2b");
		expect(color("toolErrorBg")).toBe("#7a2936");
	});

	it("has no Catppuccin values left anywhere in the file", () => {
		for (const leftover of ["cba6f7", "a6e3a1", "fab387", "89b4fa", "cdd6f4", "1e1e2e", "11111b", "f5c2e7"]) {
			expect(raw).not.toContain(leftover);
		}
	});
});
