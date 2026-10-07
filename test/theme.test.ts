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
interface ThemeFile {
	name: string;
	appearance?: string;
	vars: Record<string, string | number>;
	colors: Record<string, string | number>;
	export: Record<string, string | number>;
}

function load(name: string) {
	const raw = readFileSync(`./themes/${name}.json`, "utf8");
	const parsed = JSON.parse(raw) as ThemeFile;
	/** Follow `vars` references until a literal `#rrggbb` or palette index falls out, as pi does. */
	const resolve = (value: string | number, seen = new Set<string>()): string | number => {
		if (typeof value === "number" || value.startsWith("#")) return value;
		if (seen.has(value)) throw new Error(`cyclic var reference: ${value}`);
		seen.add(value);
		const next = parsed.vars[value];
		if (next === undefined) throw new Error(`unresolved var: ${value}`);
		return resolve(next, seen);
	};
	const color = (token: string) => resolve(parsed.colors[token] ?? `<missing ${token}>`);
	return { raw, parsed, color, resolve };
}

const { raw, parsed, color } = load("bluclawd");

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

/**
 * Claude Code's other five themes, from the same palette table in the binary, mapped
 * onto pi's tokens as bluclawd.json maps the dark one. These pin the values that set
 * each one apart.
 */
describe("bluclawd theme variants", () => {
	const variants = [
		"bluclawd-light",
		"bluclawd-dark-daltonized",
		"bluclawd-light-daltonized",
		"bluclawd-dark-ansi",
		"bluclawd-light-ansi",
	];
	const tokens = Object.keys(parsed.colors).sort();
	const exportKeys = Object.keys(parsed.export).sort();

	it.each(variants)("%s defines every token the dark theme defines, all resolvable", (name) => {
		const variant = load(name);
		expect(variant.parsed.name).toBe(name);
		expect(Object.keys(variant.parsed.colors).sort()).toEqual(tokens);
		expect(Object.keys(variant.parsed.export).sort()).toEqual(exportKeys);
		for (const token of tokens) expect(() => variant.color(token)).not.toThrow();
		for (const key of exportKeys) expect(() => variant.resolve(variant.parsed.export[key])).not.toThrow();
	});

	it("declares each theme's appearance, so the Auto pair resolves", () => {
		expect(parsed.appearance).toBe("dark");
		expect(load("bluclawd-light").parsed.appearance).toBe("light");
		expect(load("bluclawd-dark-daltonized").parsed.appearance).toBe("dark");
		expect(load("bluclawd-light-daltonized").parsed.appearance).toBe("light");
		expect(load("bluclawd-dark-ansi").parsed.appearance).toBe("dark");
		expect(load("bluclawd-light-ansi").parsed.appearance).toBe("light");
	});

	it("light mode uses CC's light values", () => {
		const { color } = load("bluclawd-light");
		expect(color("text")).toBe("#000000");
		expect(color("muted")).toBe("#666666");
		expect(color("success")).toBe("#2c7a39");
		expect(color("error")).toBe("#ab2b3f");
		expect(color("mdLink")).toBe("#5769f7");
		expect(color("userMessageBg")).toBe("#f0f0f0");
		expect(color("toolDiffAdded")).toBe("#2f9d44");
		expect(color("thinkingMax")).toBe("#8700ff");
	});

	it("colorblind-friendly modes trade green for blue", () => {
		const dark = load("bluclawd-dark-daltonized").color;
		expect(dark("success")).toBe("#3399ff");
		expect(dark("error")).toBe("#ff6666");
		expect(dark("toolDiffAdded")).toBe("#0077b3");
		expect(dark("toolSuccessBg")).toBe("#004466");
		const light = load("bluclawd-light-daltonized").color;
		expect(light("success")).toBe("#006699");
		expect(light("error")).toBe("#cc0000");
		expect(light("toolDiffAdded")).toBe("#3366cc");
	});

	it("ANSI modes use only the terminal's 16 palette colours", () => {
		for (const name of ["bluclawd-dark-ansi", "bluclawd-light-ansi"]) {
			const variant = load(name);
			for (const token of tokens) {
				const value = variant.color(token);
				expect(typeof value, `${name} ${token}`).toBe("number");
				expect(value as number).toBeLessThan(16);
			}
		}
		expect(load("bluclawd-dark-ansi").color("text")).toBe(15);
		expect(load("bluclawd-dark-ansi").color("success")).toBe(10);
		expect(load("bluclawd-light-ansi").color("text")).toBe(0);
		expect(load("bluclawd-light-ansi").color("success")).toBe(2);
	});

	it.each(variants)("%s has no Catppuccin values", (name) => {
		const { raw } = load(name);
		for (const leftover of ["cba6f7", "a6e3a1", "fab387", "89b4fa", "cdd6f4", "1e1e2e", "11111b", "f5c2e7"]) {
			expect(raw).not.toContain(leftover);
		}
	});
});
