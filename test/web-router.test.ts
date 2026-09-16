import { afterEach, describe, expect, it } from "vitest";
import { classifyFailure, routedSearch } from "../ext/web/router.ts";
import { resetExaMcpSession } from "../ext/web/search.ts";

afterEach(() => resetExaMcpSession());

const filter = {};

function hostFetch(
	replies: Record<string, () => Response>,
	seen: string[] = [],
): { fetchImpl: typeof fetch; seen: string[] } {
	const fetchImpl = (async (input: URL | RequestInfo) => {
		const url = String(input);
		seen.push(new URL(url).host);
		for (const [host, reply] of Object.entries(replies)) if (url.includes(host)) return reply();
		return new Response("unexpected", { status: 599 });
	}) as typeof fetch;
	return { fetchImpl, seen };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("search routing", () => {
	it("classifies failures by status", () => {
		expect(classifyFailure(new Error("websearch: brave returned 429 Too Many Requests"))).toBe("quota");
		expect(classifyFailure(new Error("websearch: exa returned 503"))).toBe("transient");
		expect(classifyFailure(new Error("websearch: tavily returned 401 Unauthorized"))).toBe("auth");
		expect(classifyFailure(new TypeError("fetch failed"))).toBe("network");
		expect(classifyFailure(new Error("websearch: exa returned 400"))).toBe("other");
	});

	it("skips providers without a key and falls back on quota errors", async () => {
		const { fetchImpl, seen } = hostFetch({
			"api.search.brave.com": () => json({}, 429),
			"google.serper.dev": () => json({ organic: [{ title: "T", link: "https://t.example/", snippet: "s" }] }),
		});
		const out = await routedSearch({
			query: "q",
			filter,
			settings: { routing: ["tavily", "brave", "serper"] },
			env: { BRAVE_API_KEY: "b", SERPER_API_KEY: "s" },
			fetchImpl,
		});
		expect(out.provider).toBe("serper");
		expect(out.results.map((r) => r.url)).toEqual(["https://t.example/"]);
		expect(seen).toEqual(["api.search.brave.com", "google.serper.dev"]);
		expect(out.skipped.join("\n")).toMatch(/tavily: no key \(TAVILY_API_KEY\)[\s\S]*brave: .*429/);
	});

	it("does not fall back on a failure kind the user did not choose", async () => {
		const { fetchImpl, seen } = hostFetch({ "api.search.brave.com": () => json({}, 401) });
		await expect(
			routedSearch({
				query: "q",
				filter,
				settings: { routing: ["brave", "serper"] },
				env: { BRAVE_API_KEY: "b", SERPER_API_KEY: "s" },
				fetchImpl,
			}),
		).rejects.toThrow(/401/);
		expect(seen).toEqual(["api.search.brave.com"]);
	});

	it("keeps the single-provider message when nothing is configured", async () => {
		const out = await routedSearch({ query: "q", filter, settings: { provider: "brave" }, env: {} });
		expect(out.unconfigured).toMatch(/Set the BRAVE_API_KEY environment variable/);
		const off = await routedSearch({ query: "q", filter, settings: { keyless: false }, env: {} });
		expect(off.unconfigured).toMatch(/EXA_API_KEY/);
	});

	it("uses apiKeyEnvs, and searxng needs its url", async () => {
		const { fetchImpl, seen } = hostFetch({
			"searx.example": () => json({ results: [{ title: "S", url: "https://s.example/", content: "c" }] }),
		});
		const out = await routedSearch({
			query: "q",
			filter,
			settings: {
				routing: ["kagi", "searxng"],
				apiKeyEnvs: { kagi: "MY_KAGI" },
				searxngUrl: "https://searx.example",
			},
			env: {},
			fetchImpl,
		});
		expect(out.provider).toBe("searxng");
		expect(out.skipped).toEqual(["kagi: no key (MY_KAGI)"]);
		expect(seen).toEqual(["searx.example"]);
	});
});
