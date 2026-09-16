import { describe, expect, it } from "vitest";
import {
	buildVibePrompt,
	cleanVibe,
	parseGenerateArgs,
	parseVibeBatch,
	pickVibe,
	vibeFileSlug,
} from "../ext/vibes/vibes.ts";

describe("cleanVibe", () => {
	it("keeps the first line, strips quotes, and ends with an ellipsis", () => {
		expect(cleanVibe('"Charting the codebase..."\nThis fits because…', "Working", 65)).toBe(
			"Charting the codebase...",
		);
		expect(cleanVibe("Hoisting the sails.", "Working", 65)).toBe("Hoisting the sails...");
		expect(cleanVibe("Engaging warp drive", "Working", 65)).toBe("Engaging warp drive...");
	});

	it("caps the length and falls back when there is nothing usable", () => {
		expect(cleanVibe("a".repeat(100), "Working", 20)).toBe(`${"a".repeat(17)}...`);
		expect(cleanVibe("", "Working", 65)).toBe("Working...");
		expect(cleanVibe("...", "Working", 65)).toBe("Working...");
	});
});

describe("buildVibePrompt", () => {
	it("names the theme and a clipped task, and lists recent vibes to avoid", () => {
		const prompt = buildVibePrompt("star trek", "x".repeat(300), ["Engaging warp drive..."]);
		expect(prompt).toContain('"star trek"');
		expect(prompt).toContain(`Task: ${"x".repeat(100)}\n`);
		expect(prompt).toContain("Don't use: Engaging warp drive...");
		expect(buildVibePrompt("zen", "fix", [])).not.toContain("Don't use");
	});
});

describe("parseVibeBatch", () => {
	it("cleans numbering, bullets and quotes, one vibe per line", () => {
		expect(parseVibeBatch('1. "Charting course..."\n- Hoisting sails\n\n  3) Swabbing decks...  \n...')).toEqual([
			"Charting course...",
			"Hoisting sails...",
			"Swabbing decks...",
		]);
	});
});

describe("parseGenerateArgs", () => {
	it("takes a trailing count, clamps it, and defaults to 100", () => {
		expect(parseGenerateArgs(["star", "trek", "50"])).toEqual({ theme: "star trek", count: 50 });
		expect(parseGenerateArgs(["mafia"])).toEqual({ theme: "mafia", count: 100 });
		expect(parseGenerateArgs(["mafia", "9999"])).toEqual({ theme: "mafia", count: 500 });
		expect(parseGenerateArgs(["42"])).toEqual({ theme: "42", count: 100 });
		expect(parseGenerateArgs([])).toBeUndefined();
	});
});

describe("pickVibe", () => {
	it("walks a seeded shuffle that uses every vibe once before repeating", () => {
		const vibes = ["a...", "b...", "c...", "d..."];
		const firstRound = [0, 1, 2, 3].map((index) => pickVibe(vibes, index, 42));
		expect([...firstRound].sort()).toEqual(vibes);
		expect(pickVibe(vibes, 4, 42)).toBe(firstRound[0]);
		expect([0, 1, 2, 3].map((index) => pickVibe(vibes, index, 42))).toEqual(firstRound);
	});
});

describe("vibeFileSlug", () => {
	it("makes a safe file name from any theme", () => {
		expect(vibeFileSlug("Star Trek!")).toBe("star-trek");
		expect(vibeFileSlug("../../etc")).toBe("etc");
		expect(vibeFileSlug("???")).toBe("theme");
	});
});
