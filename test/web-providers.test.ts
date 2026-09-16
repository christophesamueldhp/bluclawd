import { describe, expect, it } from "vitest";
import { EXTRA_PROVIDERS, type ProviderRequest, parseDuckDuckGoHtml } from "../ext/web/providers.ts";
import type { DomainFilter, Recency } from "../ext/web/search.ts";

type Call = { url: string; init: RequestInit };

function jsonFetch(reply: (call: Call) => unknown, calls: Call[] = []): { fetchImpl: typeof fetch; calls: Call[] } {
	const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
		const call = { url: String(input), init: init ?? {} };
		calls.push(call);
		const body = reply(call);
		if (body instanceof Response) return body;
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return { fetchImpl, calls };
}

function sentBody(call: Call): Record<string, unknown> {
	return JSON.parse(String(call.init.body ?? "{}")) as Record<string, unknown>;
}

function header(call: Call, name: string): string | undefined {
	return (call.init.headers as Record<string, string> | undefined)?.[name];
}

function request(
	fetchImpl: typeof fetch,
	opts: { apiKey?: string; baseUrl?: string; filter?: DomainFilter; recency?: Recency } = {},
): ProviderRequest {
	return {
		query: "rust async",
		apiKey: opts.apiKey,
		baseUrl: opts.baseUrl,
		filter: opts.filter ?? {},
		recency: opts.recency,
		signal: new AbortController().signal,
		fetchImpl,
	};
}

describe("searxng", () => {
	const reply = {
		results: [
			{
				title: "Async in Rust",
				url: "https://docs.rs/async",
				content: "Futures and executors",
				publishedDate: "2026-09-01T10:00:00Z",
			},
			{ title: "Other", url: "https://blog.example.org/x", content: "elsewhere", publishedDate: null },
		],
		answers: [],
	};

	it("queries the configured instance as JSON with time_range and site operators", async () => {
		const { fetchImpl, calls } = jsonFetch(() => reply);
		const results = await EXTRA_PROVIDERS.searxng.search(
			request(fetchImpl, {
				baseUrl: "https://searx.example.com/",
				filter: { allowedDomains: ["docs.rs"] },
				recency: "week",
			}),
		);
		const url = new URL(calls[0].url);
		expect(url.origin + url.pathname).toBe("https://searx.example.com/search");
		expect(url.searchParams.get("q")).toBe("rust async site:docs.rs");
		expect(url.searchParams.get("format")).toBe("json");
		expect(url.searchParams.get("time_range")).toBe("week");
		expect(calls[0].init.redirect).toBe("manual");
		expect(results).toEqual([
			{
				title: "Async in Rust",
				url: "https://docs.rs/async",
				snippet: "Futures and executors",
				published: "2026-09-01",
			},
		]);
	});

	it("requires a base URL and reports non-2xx", async () => {
		expect(EXTRA_PROVIDERS.searxng.needsBaseUrl).toBe(true);
		const { fetchImpl } = jsonFetch(() => new Response("", { status: 429, statusText: "Too Many Requests" }));
		await expect(EXTRA_PROVIDERS.searxng.search(request(fetchImpl))).rejects.toThrow(/base URL/);
		await expect(
			EXTRA_PROVIDERS.searxng.search(request(fetchImpl, { baseUrl: "https://searx.example.com" })),
		).rejects.toThrow("websearch: searxng returned 429 Too Many Requests");
	});
});

describe("duckduckgo", () => {
	const html = `<html><body>
<div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=ads.example.com">Sponsored</a><div class="result__snippet">Buy now</div></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.example.com%2Fa%3Fx%3D1&amp;rut=abc"> Example Docs </a><a class="result__snippet">First <b>snippet</b></a></div>
<div class="result"><a class="result__a" href="https://example.net/b">Example Net</a><div class="result__snippet">Second snippet</div></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=javascript%3Aalert(1)">Bad</a><div class="result__snippet">Bad</div></div>
</body></html>`;

	it("parses organic results, skipping ads, decoding uddg and rejecting non-http links", async () => {
		expect(await parseDuckDuckGoHtml(html)).toEqual([
			{ title: "Example Docs", url: "https://docs.example.com/a?x=1", snippet: "First snippet" },
			{ title: "Example Net", url: "https://example.net/b", snippet: "Second snippet" },
		]);
	});

	it("requests the HTML endpoint keylessly with df and site operators, then post-filters", async () => {
		expect(EXTRA_PROVIDERS.duckduckgo.envVar).toBeUndefined();
		const { fetchImpl, calls } = jsonFetch(() => new Response(html, { status: 200 }));
		const results = await EXTRA_PROVIDERS.duckduckgo.search(
			request(fetchImpl, { filter: { blockedDomains: ["example.net"] }, recency: "month" }),
		);
		const url = new URL(calls[0].url);
		expect(url.origin + url.pathname).toBe("https://html.duckduckgo.com/html/");
		expect(url.searchParams.get("q")).toBe("rust async -site:example.net");
		expect(url.searchParams.get("df")).toBe("m");
		expect(header(calls[0], "Accept")).toBe("text/html");
		expect(header(calls[0], "Authorization")).toBeUndefined();
		expect(calls[0].init.redirect).toBe("manual");
		expect(results.map((r) => r.url)).toEqual(["https://docs.example.com/a?x=1"]);
	});

	it("throws on a page with no parseable results (bot check)", async () => {
		const { fetchImpl } = jsonFetch(() => new Response("<html><form id='challenge-form'></form></html>"));
		await expect(EXTRA_PROVIDERS.duckduckgo.search(request(fetchImpl))).rejects.toThrow(
			"websearch: duckduckgo returned no parseable results (possibly a bot check)",
		);
	});
});

describe("jina", () => {
	const reply = {
		code: 200,
		status: 20000,
		data: [
			{
				title: "Tokio",
				url: "https://tokio.rs/tutorial",
				description: "An  async\nruntime",
				date: "2026-08-03T00:00:00Z",
			},
			{ title: "", url: "https://reddit.com/r/rust", description: "thread" },
		],
	};

	it("puts the query in the path, allowed hosts in site params, blocked hosts and recency in the query", async () => {
		const { fetchImpl, calls } = jsonFetch(() => reply);
		const results = await EXTRA_PROVIDERS.jina.search(
			request(fetchImpl, { apiKey: "jina-key", filter: { blockedDomains: ["reddit.com"] }, recency: "week" }),
		);
		const url = new URL(calls[0].url);
		expect(url.origin).toBe("https://s.jina.ai");
		expect(decodeURIComponent(url.pathname.slice(1))).toBe("rust async -site:reddit.com published in the past week");
		expect(url.searchParams.get("count")).toBe("20");
		expect(header(calls[0], "Authorization")).toBe("Bearer jina-key");
		expect(header(calls[0], "X-Respond-With")).toBe("no-content");
		expect(results).toEqual([
			{ title: "Tokio", url: "https://tokio.rs/tutorial", snippet: "An async runtime", published: "2026-08-03" },
		]);
	});

	it("sends allowed domains as repeated site params", async () => {
		const { fetchImpl, calls } = jsonFetch(() => reply);
		await EXTRA_PROVIDERS.jina.search(
			request(fetchImpl, { apiKey: "k", filter: { allowedDomains: ["tokio.rs", "https://docs.rs/"] } }),
		);
		expect(new URL(calls[0].url).searchParams.getAll("site")).toEqual(["tokio.rs", "docs.rs"]);
	});

	it("names the key variable on 401 and on a missing key", async () => {
		const { fetchImpl } = jsonFetch(() => new Response("", { status: 401, statusText: "Unauthorized" }));
		await expect(EXTRA_PROVIDERS.jina.search(request(fetchImpl, { apiKey: "bad" }))).rejects.toThrow(
			"websearch: jina returned 401 Unauthorized (check JINA_API_KEY)",
		);
		await expect(EXTRA_PROVIDERS.jina.search(request(fetchImpl))).rejects.toThrow(/JINA_API_KEY/);
	});
});

describe("perplexity", () => {
	it("posts a sonar chat with recency and a signed domain list, mapping search_results", async () => {
		const { fetchImpl, calls } = jsonFetch(() => ({
			choices: [{ message: { content: "Rust async uses futures [1]." } }],
			citations: ["https://rust-lang.github.io/async-book/"],
			search_results: [
				{
					title: "Async Book",
					url: "https://rust-lang.github.io/async-book/",
					date: "2026-07-01",
					snippet: "Intro",
				},
				{ title: "Spam", url: "https://spam.example.com/x", date: null },
			],
		}));
		const results = await EXTRA_PROVIDERS.perplexity.search(
			request(fetchImpl, { apiKey: "pplx-key", filter: { blockedDomains: ["spam.example.com"] }, recency: "day" }),
		);
		expect(calls[0].url).toBe("https://api.perplexity.ai/chat/completions");
		expect(calls[0].init.method).toBe("POST");
		expect(header(calls[0], "Authorization")).toBe("Bearer pplx-key");
		expect(sentBody(calls[0])).toMatchObject({
			model: "sonar",
			messages: [{ role: "user", content: "rust async" }],
			search_recency_filter: "day",
			search_domain_filter: ["-spam.example.com"],
		});
		expect(results).toEqual([
			{
				title: "Async Book",
				url: "https://rust-lang.github.io/async-book/",
				snippet: "Intro",
				published: "2026-07-01",
			},
		]);
	});

	it("falls back to citations (strings or objects)", async () => {
		const { fetchImpl, calls } = jsonFetch(() => ({
			choices: [{ message: { content: "answer" } }],
			citations: ["https://a.example.com/", { title: "B", url: "https://b.example.com/" }],
		}));
		const results = await EXTRA_PROVIDERS.perplexity.search(
			request(fetchImpl, { apiKey: "k", filter: { allowedDomains: ["a.example.com", "b.example.com"] } }),
		);
		expect(sentBody(calls[0]).search_domain_filter).toEqual(["a.example.com", "b.example.com"]);
		expect(sentBody(calls[0]).search_recency_filter).toBeUndefined();
		expect(results).toEqual([
			{ title: "Source 1", url: "https://a.example.com/", snippet: "" },
			{ title: "B", url: "https://b.example.com/", snippet: "" },
		]);
	});
});

describe("kagi", () => {
	it("posts query and limit with a Bearer key and maps data.search", async () => {
		const { fetchImpl, calls } = jsonFetch(() => ({
			meta: { id: "abc" },
			data: {
				search: [
					{
						title: "Kagi result",
						url: "https://example.com/kagi",
						snippet: "Kagi snippet",
						published: "2026-05-02",
					},
					{ title: "Off-site", url: "https://other.org/x", snippet: "no" },
				],
			},
		}));
		const results = await EXTRA_PROVIDERS.kagi.search(
			request(fetchImpl, { apiKey: "kagi-key", filter: { allowedDomains: ["example.com"] } }),
		);
		expect(calls[0].url).toBe("https://kagi.com/api/v1/search");
		expect(calls[0].init.method).toBe("POST");
		expect(header(calls[0], "Authorization")).toBe("Bearer kagi-key");
		expect(sentBody(calls[0])).toEqual({ query: "rust async site:example.com", limit: 20 });
		expect(results).toEqual([
			{ title: "Kagi result", url: "https://example.com/kagi", snippet: "Kagi snippet", published: "2026-05-02" },
		]);
	});

	it("accepts data as a list, caps unfiltered results, and surfaces envelope errors", async () => {
		const items = Array.from({ length: 8 }, (_, i) => ({ title: `r${i}`, url: `https://e.com/${i}`, snippet: "" }));
		const { fetchImpl, calls } = jsonFetch(() => ({ data: items }));
		const results = await EXTRA_PROVIDERS.kagi.search(request(fetchImpl, { apiKey: "k" }));
		expect(sentBody(calls[0])).toEqual({ query: "rust async", limit: 5 });
		expect(results).toHaveLength(5);

		const failing = jsonFetch(() => ({ data: null, errors: [{ code: 1, message: "Insufficient credit" }] }));
		await expect(EXTRA_PROVIDERS.kagi.search(request(failing.fetchImpl, { apiKey: "k" }))).rejects.toThrow(
			"websearch: kagi error: Insufficient credit",
		);
	});
});

describe("serper", () => {
	it("posts q/num/tbs with X-API-KEY and maps organic results", async () => {
		const { fetchImpl, calls } = jsonFetch(() => ({
			searchParameters: { q: "rust async", type: "search", engine: "google" },
			organic: [
				{
					title: "Serper result",
					link: "https://example.com/serper",
					snippet: "Google result",
					date: "2026-09-02",
					position: 1,
				},
				{ title: "Blocked", link: "https://pinterest.com/pin", snippet: "x", position: 2 },
			],
		}));
		const results = await EXTRA_PROVIDERS.serper.search(
			request(fetchImpl, {
				apiKey: "serper-key",
				filter: { blockedDomains: ["pinterest.com", "quora.com"] },
				recency: "year",
			}),
		);
		expect(calls[0].url).toBe("https://google.serper.dev/search");
		expect(calls[0].init.method).toBe("POST");
		expect(header(calls[0], "X-API-KEY")).toBe("serper-key");
		expect(header(calls[0], "Authorization")).toBeUndefined();
		expect(sentBody(calls[0])).toEqual({
			q: "rust async -site:pinterest.com -site:quora.com",
			num: 20,
			tbs: "qdr:y",
		});
		expect(calls[0].init.redirect).toBe("manual");
		expect(results).toEqual([
			{
				title: "Serper result",
				url: "https://example.com/serper",
				snippet: "Google result",
				published: "2026-09-02",
			},
		]);
	});

	it("groups several allowed domains with OR and names the key on 403", async () => {
		const { fetchImpl, calls } = jsonFetch(() => ({ organic: [] }));
		await EXTRA_PROVIDERS.serper.search(
			request(fetchImpl, { apiKey: "k", filter: { allowedDomains: ["a.com", "b.com"] } }),
		);
		expect(sentBody(calls[0]).q).toBe("rust async (site:a.com OR site:b.com)");

		const denied = jsonFetch(() => new Response("", { status: 403, statusText: "Forbidden" }));
		await expect(EXTRA_PROVIDERS.serper.search(request(denied.fetchImpl, { apiKey: "k" }))).rejects.toThrow(
			"websearch: serper returned 403 Forbidden (check SERPER_API_KEY)",
		);
	});
});

describe("provider registry", () => {
	it("names each key variable, and none for the keyless and self-hosted providers", () => {
		expect(Object.fromEntries(Object.entries(EXTRA_PROVIDERS).map(([name, p]) => [name, p.envVar]))).toEqual({
			searxng: undefined,
			duckduckgo: undefined,
			jina: "JINA_API_KEY",
			perplexity: "PERPLEXITY_API_KEY",
			kagi: "KAGI_API_KEY",
			serper: "SERPER_API_KEY",
		});
	});
});
