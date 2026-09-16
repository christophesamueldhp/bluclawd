import { describe, expect, it } from "vitest";
import { formatAge, welcomeSections } from "../ext/branding/welcome-info.ts";

const theme = { fg: (_color: string, text: string) => text };
const now = new Date("2026-09-17T12:00:00Z").getTime();

describe("formatAge", () => {
	it("spells out the age at a useful precision", () => {
		expect(formatAge(new Date(now - 20_000), now)).toBe("just now");
		expect(formatAge(new Date(now - 5 * 60_000), now)).toBe("5 minutes ago");
		expect(formatAge(new Date(now - 60 * 60_000), now)).toBe("1 hour ago");
		expect(formatAge(new Date(now - 30 * 60 * 60_000), now)).toBe("1 day ago");
		expect(formatAge(new Date(now - 9 * 24 * 60 * 60_000), now)).toBe("9 days ago");
	});
});

describe("welcomeSections", () => {
	it("lists the model, what is loaded, the system prompt size, recent sessions, then tips", () => {
		const sections = welcomeSections(
			{
				model: { name: "Kimi K2.6", provider: "opencode-go" },
				loaded: { contextFiles: 2, skills: 22, tools: 31, promptTemplates: 1 },
				systemPromptTokens: 6100,
				recentSessions: [
					{ title: "fix the footer", modified: new Date(now - 2 * 60 * 60_000) },
					{ title: "x".repeat(200), modified: new Date(now - 60_000) },
				],
				tips: ["Ask a question to start."],
			},
			theme,
			now,
		);
		expect(sections.map((s) => s.heading)).toEqual([
			"Model",
			"Loaded",
			"Recent sessions",
			"Tips for getting started",
		]);
		expect(sections[0].lines).toEqual(["Kimi K2.6 · opencode-go"]);
		expect(sections[1].lines).toEqual([
			"2 context files · 22 skills · 31 tools · 1 prompt template",
			"~6.1k tokens of system prompt",
		]);
		expect(sections[2].lines[0]).toBe("2 hours ago · fix the footer");
		expect(sections[2].lines[1]).toMatch(/^1 minute ago · x+…$/);
		expect(sections[3].lines).toEqual(["Ask a question to start."]);
	});

	it("leaves out what is unknown or empty instead of printing zeros", () => {
		const sections = welcomeSections(
			{
				model: undefined,
				loaded: { contextFiles: 0, skills: 0, tools: 4, promptTemplates: 0 },
				systemPromptTokens: undefined,
				recentSessions: [],
				tips: ["tip"],
			},
			theme,
			now,
		);
		expect(sections.map((s) => s.heading)).toEqual(["Model", "Loaded", "Tips for getting started"]);
		expect(sections[0].lines).toEqual(["none selected — /model picks one"]);
		expect(sections[1].lines).toEqual(["4 tools"]);
	});
});
