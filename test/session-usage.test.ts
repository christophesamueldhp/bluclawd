import { describe, expect, it } from "vitest";
import { STATUS_KEYS } from "../ext/_shared/status-keys.ts";
import { backgroundSubagentUsageSummary, isUsingSubscription } from "../ext/help/session-usage.ts";
import { createEmptySubagentUsage } from "../ext/subagents/runs.ts";

describe("isUsingSubscription", () => {
	const ctxFor = (provider: string) =>
		({ model: { id: "m", provider }, modelRegistry: { isUsingOAuth: () => false } }) as never;

	it("treats the built-in subscription providers as such without OAuth", () => {
		expect(isUsingSubscription(ctxFor("opencode-go"))).toBe(true);
		expect(isUsingSubscription(ctxFor("kimi-coding"))).toBe(true);
		expect(isUsingSubscription(ctxFor("openrouter"))).toBe(false);
	});
});

describe("background subagent usage disclosure", () => {
	it("distinguishes additional child tokens and unknown pricing from native session totals", () => {
		const usage = { ...createEmptySubagentUsage(), totalTokens: 400, hasUnknownCost: true };
		expect(backgroundSubagentUsageSummary({ runCount: 0, usage })).toBeUndefined();
		const unknown = backgroundSubagentUsageSummary({ runCount: 2, usage });
		expect(unknown).toContain("400 tokens");
		expect(unknown).toContain("cost unknown");
		expect(unknown).toContain("excluded from /session totals");
		usage.hasUnknownCost = false;
		usage.cost.total = 0.03;
		expect(backgroundSubagentUsageSummary({ runCount: 2, usage })).toContain("$0.030000");
	});
});

describe("status keys", () => {
	it("sort into bluclawd's order the way pi's footer sorts them", () => {
		const keys = Object.values(STATUS_KEYS);
		const sorted = [...keys].sort((a, b) => a.localeCompare(b));
		expect(sorted[0]).toBe(STATUS_KEYS.mode);
		expect(sorted[1]).toBe(STATUS_KEYS.tasks);
		expect(sorted.at(-1)).toBe(STATUS_KEYS.agents);
	});
});
