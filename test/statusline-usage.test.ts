import { afterEach, describe, expect, it, vi } from "vitest";
import { formatTokens, isUsingSubscription, setSubscriptionProviders } from "../ext/_shared/session-usage.ts";
import { fetchClaudeUsage } from "../ext/statusline/usage-providers.ts";

describe("formatTokens", () => {
	it("uses pi's own footer thresholds", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1200)).toBe("1.2k");
		expect(formatTokens(80_000)).toBe("80k");
		expect(formatTokens(1_000_000)).toBe("1.0M");
		expect(formatTokens(12_000_000)).toBe("12M");
	});
});

describe("fetchClaudeUsage credential gate", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("does not call the usage API when there is no Anthropic OAuth credential", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		expect(await fetchClaudeUsage(() => undefined)).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("ignores a non-oauth (api_key) credential the same way", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		expect(await fetchClaudeUsage(() => ({ type: "api_key" }))).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("sends the resolved token when an OAuth credential exists", async () => {
		let sentAuth: string | undefined;
		vi.stubGlobal("fetch", async (_url: string, init: { headers: Record<string, string> }) => {
			sentAuth = init.headers.Authorization;
			return {
				ok: true,
				status: 200,
				json: async () => ({ five_hour: { utilization: 12, resets_at: "2026-08-01T10:00:00Z" } }),
			};
		});
		const data = await fetchClaudeUsage(async () => ({ type: "oauth", access: "tok-abc" }));
		expect(sentAuth).toBe("Bearer tok-abc");
		expect(data?.sessionUsage).toBe(12);
	});

	it("reports a rate limit as such", async () => {
		vi.stubGlobal("fetch", async () => ({ ok: false, status: 429 }));
		expect(await fetchClaudeUsage(() => ({ type: "oauth", access: "t" }))).toEqual({ error: "rate-limited" });
	});
});

describe("isUsingSubscription", () => {
	const ctxFor = (provider: string) =>
		({ model: { id: "m", provider }, modelRegistry: { isUsingOAuth: () => false } }) as never;

	afterEach(() => setSubscriptionProviders([]));

	it("treats the built-in subscription providers as such without OAuth", () => {
		expect(isUsingSubscription(ctxFor("opencode-go"))).toBe(true);
		expect(isUsingSubscription(ctxFor("kimi-coding"))).toBe(true);
		expect(isUsingSubscription(ctxFor("openrouter"))).toBe(false);
	});

	it("honours statusline.subscriptionProviders from settings", () => {
		setSubscriptionProviders(["acme"]);
		expect(isUsingSubscription(ctxFor("acme"))).toBe(true);
		expect(isUsingSubscription(ctxFor("openrouter"))).toBe(false);
	});
});
