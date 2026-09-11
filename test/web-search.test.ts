import { afterEach, describe, expect, it, vi } from "vitest";
import { domainFilterError, factory, renderResults } from "../ext/web/index.ts";
import {
	exaMcpSearch,
	filterByDomain,
	parseExaMcpResults,
	resetExaMcpSession,
	type SearchResult,
	webSearch,
} from "../ext/web/search.ts";

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

afterEach(() => {
	resetExaMcpSession();
	vi.unstubAllGlobals();
});

describe("domain filters", () => {
	const results: SearchResult[] = [
		{ title: "a", url: "https://docs.example.com/x", snippet: "" },
		{ title: "b", url: "https://example.com/y", snippet: "" },
		{ title: "c", url: "https://other.org/z", snippet: "" },
		{ title: "d", url: "not a url", snippet: "" },
	];

	it("keeps only allowed domains, including their subdomains", () => {
		expect(filterByDomain(results, { allowed: ["Example.com"] }).map((r) => r.title)).toEqual(["a", "b"]);
	});

	it("drops blocked domains and keeps everything else, even unparsable urls", () => {
		expect(filterByDomain(results, { blocked: ["example.com"] }).map((r) => r.title)).toEqual(["c", "d"]);
	});

	it("accepts a leading wildcard or scheme in the domain spelling", () => {
		expect(filterByDomain(results, { allowed: ["*.example.com"] }).map((r) => r.title)).toEqual(["a", "b"]);
		expect(filterByDomain(results, { allowed: ["https://other.org/"] }).map((r) => r.title)).toEqual(["c"]);
	});

	it("refuses both filters at once, like Claude Code", () => {
		expect(domainFilterError({ allowed_domains: ["a.com"], blocked_domains: ["b.com"] })).toMatch(
			/Cannot specify both/,
		);
		expect(domainFilterError({ allowed_domains: ["a.com"] })).toBeUndefined();
		expect(domainFilterError({ allowed_domains: [], blocked_domains: [] })).toBeUndefined();
	});
});

describe("keyed providers pass domain filters natively", () => {
	it("exa", async () => {
		const { fetchImpl, calls } = jsonFetch(() => ({
			results: [{ title: "t", url: "https://docs.example.com/a", text: "s", publishedDate: "2026-01-02T00:00:00Z" }],
		}));
		const out = await webSearch({
			query: "q",
			provider: "exa",
			apiKey: "k",
			fetchImpl,
			allowedDomains: ["example.com"],
		});
		expect(sentBody(calls[0]).includeDomains).toEqual(["example.com"]);
		expect(out).toEqual([{ title: "t", url: "https://docs.example.com/a", snippet: "s", published: "2026-01-02" }]);
	});

	it("tavily", async () => {
		const { fetchImpl, calls } = jsonFetch(() => ({
			results: [{ title: "t", url: "https://x.org/", content: "s" }],
		}));
		await webSearch({ query: "q", provider: "tavily", apiKey: "k", fetchImpl, blockedDomains: ["bad.com"] });
		expect(sentBody(calls[0]).exclude_domains).toEqual(["bad.com"]);
	});

	it("brave has no native filter, so results are post-filtered and more are requested", async () => {
		const { fetchImpl, calls } = jsonFetch(() => ({
			web: {
				results: [
					{ title: "keep", url: "https://example.com/1", description: "s", page_age: "2026-03-04T10:00:00" },
					{ title: "drop", url: "https://other.org/2", description: "s" },
				],
			},
		}));
		const out = await webSearch({
			query: "q",
			provider: "brave",
			apiKey: "k",
			fetchImpl,
			allowedDomains: ["example.com"],
		});
		expect(new URL(calls[0].url).searchParams.get("count")).toBe("20");
		expect(out).toEqual([{ title: "keep", url: "https://example.com/1", snippet: "s", published: "2026-03-04" }]);
	});

	it("names the key variable on a 401 so the fix is obvious", async () => {
		const { fetchImpl } = jsonFetch(() => new Response("bad key", { status: 401, statusText: "Unauthorized" }));
		await expect(webSearch({ query: "q", provider: "exa", apiKey: "k", fetchImpl })).rejects.toThrow(
			/exa returned 401 Unauthorized.*EXA_API_KEY/,
		);
	});
});

describe("keyless Exa MCP", () => {
	const searchReply = (text: string) => ({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } });
	const initReply = () =>
		new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
			status: 200,
			headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
		});

	function mcpFetch(text = "Title: A\nURL: https://a.example.com/\nHighlights:\nhi") {
		return jsonFetch((call) => {
			const method = sentBody(call).method;
			if (method === "initialize") return initReply();
			if (method === "notifications/initialized") return new Response("", { status: 202 });
			return searchReply(text);
		});
	}

	it("initializes once and reuses the session on later searches", async () => {
		const { fetchImpl, calls } = mcpFetch();
		await exaMcpSearch("one", fetchImpl);
		expect(calls.map((c) => sentBody(c).method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
		await exaMcpSearch("two", fetchImpl);
		expect(calls.length).toBe(4);
		expect((calls[3].init.headers as Record<string, string>)["mcp-session-id"]).toBe("sess-1");
	});

	it("re-initializes once when the cached session is rejected", async () => {
		const { fetchImpl, calls } = mcpFetch();
		await exaMcpSearch("one", fetchImpl);
		let rejected = false;
		const flaky = (async (input: URL | RequestInfo, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string>;
			if (
				!rejected &&
				sentBody({ url: "", init: init ?? {} }).method === "tools/call" &&
				headers["mcp-session-id"] === "sess-1"
			) {
				rejected = true;
				return new Response("gone", { status: 404 });
			}
			return fetchImpl(input, init);
		}) as typeof fetch;
		const out = await exaMcpSearch("two", flaky);
		expect(out[0].url).toBe("https://a.example.com/");
		// 3 (first search) + 1 rejected + 3 (fresh session)
		expect(calls.length).toBe(6);
	});

	it("post-filters by domain and asks for more results when filtering", async () => {
		const { fetchImpl, calls } = mcpFetch(
			"Title: A\nURL: https://a.example.com/\nHighlights:\nx\n---\nTitle: B\nURL: https://b.org/\nHighlights:\ny",
		);
		const out = await exaMcpSearch("q", fetchImpl, undefined, { allowedDomains: ["example.com"] });
		expect(out.map((r) => r.url)).toEqual(["https://a.example.com/"]);
		const args = (sentBody(calls[2]).params as { arguments: { numResults: number } }).arguments;
		expect(args.numResults).toBe(20);
	});

	it("parses Exa's text blocks and degrades to a bounded snippet", () => {
		expect(parseExaMcpResults("Title: T\nURL: https://t/\nHighlights:\nh1\nh2")).toEqual([
			{ title: "T", url: "https://t/", snippet: "h1\nh2" },
		]);
		expect(parseExaMcpResults("free text")).toEqual([{ title: "", url: "", snippet: "free text" }]);
	});
});

describe("tool surface", () => {
	function captureTools() {
		const tools = new Map<
			string,
			{ execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }
		>();
		const pi = { registerTool: (def: { name: string; execute: unknown }) => tools.set(def.name, def as never) };
		factory(pi as never);
		return tools;
	}

	it("renders results with dates, inside an untrusted block, followed by a sources reminder", () => {
		const text = renderResults("q", [
			{ title: "T", url: "https://t/", snippet: "s", published: "2026-01-02" },
			{ title: "U", url: "https://u/", snippet: "" },
		]);
		expect(text).toContain('<untrusted-search-results query="q">');
		expect(text).toContain("1. T (2026-01-02)\n   https://t/\n   s");
		expect(text).toContain("2. U\n   https://u/");
		expect(text.indexOf("</untrusted-search-results>")).toBeLessThan(text.indexOf("Cite"));
		expect(text).toMatch(/Cite .*markdown links/);
	});

	it("rejects allowed_domains together with blocked_domains before touching the network", async () => {
		const tools = captureTools();
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const ctx = { cwd: process.cwd(), isProjectTrusted: () => false };
		const out = await tools
			.get("websearch")!
			.execute(
				"id",
				{ query: "q", allowed_domains: ["a.com"], blocked_domains: ["b.com"] },
				undefined,
				undefined,
				ctx,
			);
		expect(out.content[0].text).toMatch(/Cannot specify both/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
