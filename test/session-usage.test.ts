import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { STATUS_KEYS } from "../ext/_shared/status-keys.ts";
import { isUsingSubscription, subagentUsageSummary } from "../ext/help/session-usage.ts";
import { createEmptySubagentUsage, sessionUsage } from "../ext/subagents/usage.ts";

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
		expect(subagentUsageSummary({ runCount: 0, usage })).toBeUndefined();
		const unknown = subagentUsageSummary({ runCount: 2, usage });
		expect(unknown).toContain("400 tokens");
		expect(unknown).toContain("cost unknown");
		expect(unknown).toContain("excluded from /session totals");
		usage.hasUnknownCost = false;
		usage.cost.total = 0.03;
		expect(subagentUsageSummary({ runCount: 2, usage })).toContain("$0.030000");
	});
});

describe("a session's usage", () => {
	const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const priced = (totalTokens: number, cost: number) => ({
		...createEmptySubagentUsage(),
		input: totalTokens,
		totalTokens,
		cost: { ...ZERO_COST, total: cost },
	});
	const reply = (totalTokens: number, cost: number) =>
		({
			type: "message",
			message: { role: "assistant", usage: priced(totalTokens, cost) },
		}) as unknown as SessionEntry;

	it("counts every reply, compaction and helper call, priced ones at their cost", () => {
		const compaction = { type: "compaction", usage: priced(30, 0.003) } as unknown as SessionEntry;
		const helper = { type: "usage", kind: "cache_warm", usage: priced(20, 0.002) } as unknown as SessionEntry;
		const usage = sessionUsage([reply(100, 0.01), compaction, helper]);
		expect(usage).toMatchObject({ totalTokens: 150, hasUnknownCost: false });
		expect(usage.cost.total).toBeCloseTo(0.015);
	});

	it("leaves the cost unknown, not $0, once tokens came with no price", () => {
		expect(sessionUsage([reply(100, 0.01), reply(40, 0)])).toMatchObject({ totalTokens: 140, hasUnknownCost: true });
		// A reply that failed before any token was spent leaves it known.
		expect(sessionUsage([reply(100, 0.01), reply(0, 0)]).hasUnknownCost).toBe(false);
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
