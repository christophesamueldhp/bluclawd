import { describe, expect, it } from "vitest";
import { isUsingSubscription } from "../ext/_shared/session-usage.ts";
import { STATUS_KEYS } from "../ext/_shared/status-keys.ts";

describe("isUsingSubscription", () => {
	const ctxFor = (provider: string) =>
		({ model: { id: "m", provider }, modelRegistry: { isUsingOAuth: () => false } }) as never;

	it("treats the built-in subscription providers as such without OAuth", () => {
		expect(isUsingSubscription(ctxFor("opencode-go"))).toBe(true);
		expect(isUsingSubscription(ctxFor("kimi-coding"))).toBe(true);
		expect(isUsingSubscription(ctxFor("openrouter"))).toBe(false);
	});
});

describe("status keys", () => {
	it("sort into Claude Code's order the way pi's footer sorts them", () => {
		const keys = Object.values(STATUS_KEYS);
		const sorted = [...keys].sort((a, b) => a.localeCompare(b));
		expect(sorted[0]).toBe(STATUS_KEYS.mode);
		expect(sorted[1]).toBe(STATUS_KEYS.tasks);
		expect(sorted.at(-1)).toBe(STATUS_KEYS.agents);
	});
});
