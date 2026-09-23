import { describe, expect, it } from "vitest";
import { pickVibe, SPINNER_VERBS } from "../ext/vibes/vibes.ts";

describe("SPINNER_VERBS", () => {
	it("holds Claude Code's single-word verbs except Clauding (186), capitalised, without duplicates or ellipses", () => {
		expect(SPINNER_VERBS).toHaveLength(186);
		expect(new Set(SPINNER_VERBS).size).toBe(186);
		for (const verb of SPINNER_VERBS) expect(verb).toMatch(/^[A-Z][\p{L}'-]+$/u);
		expect(SPINNER_VERBS).toContain("Flambéing");
		expect(SPINNER_VERBS).toContain("Working");
		expect(SPINNER_VERBS).not.toContain("Clauding");
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
