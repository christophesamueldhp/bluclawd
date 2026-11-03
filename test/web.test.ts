import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exaApiKey, exaContents, exaSearch, type SearchRequest } from "../ext/web/exa.ts";
import type { HttpDeps } from "../ext/web/http.ts";
import { defaultCodexModel, parseOutput, responseOutput } from "../ext/web/openai.ts";
import { loadWebPrefs, saveWebPrefs } from "../ext/web/prefs.ts";
import { formatPages, formatSearch, search } from "../ext/web/search.ts";

interface Call {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/** A fetch that answers from `replies` in order and records every request; sleeps are recorded, not slept. */
function fakeDeps(replies: (() => Response)[]): HttpDeps & { calls: Call[]; slept: number[] } {
	const calls: Call[] = [];
	const slept: number[] = [];
	return {
		calls,
		slept,
		fetch: async (input, init) => {
			calls.push({
				url: String(input),
				headers: init?.headers as Record<string, string>,
				body: JSON.parse(String(init?.body)),
			});
			const reply = replies.shift();
			if (!reply) throw new Error("no reply queued");
			return reply();
		},
		sleep: async (ms) => {
			slept.push(ms);
		},
	};
}

const json =
	(body: unknown, status = 200, headers: Record<string, string> = {}) =>
	() =>
		new Response(JSON.stringify(body), { status, headers });
const sse =
	(...events: unknown[]) =>
	() =>
		new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200 });

const jwt = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } })).toString("base64url")}.y`;

/** Codex models `ids`, and `exaKey` as the key /login stored for Exa (null: none). */
function registry(ids: string[] = ["gpt-6.1-luna"], exaKey: string | null = "exa-test"): ModelRegistry {
	return {
		getAvailable: () => ids.map((id) => ({ provider: "openai-codex", id, name: id })),
		getApiKeyForProvider: async (provider: string) => (provider === "exa" ? (exaKey ?? undefined) : undefined),
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: jwt, headers: { "x-provider": "1", "x-dropped": null } }),
	} as unknown as ModelRegistry;
}

const request: SearchRequest = {
	query: "vitest fake timers docs",
	objective: "Find the official page on fake timers",
	numResults: 5,
	includeDomains: ["vitest.dev"],
	excludeDomains: ["pinterest.com"],
};

const exaHit = {
	url: "https://vitest.dev/guide/mocking",
	title: "Mocking",
	highlights: ["Use vi.useFakeTimers()", "then advance"],
};
const openaiReply = sse(
	{
		type: "response.output_item.done",
		item: { type: "web_search_call", action: { sources: [{ url: "https://b.dev", title: "B" }] } },
	},
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			content: [
				{
					text: "Use fake timers [A](https://a.dev/?utm_source=openai).",
					annotations: [
						{
							type: "url_citation",
							url: "https://a.dev/?utm_source=openai",
							title: "A",
							start_index: 16,
							end_index: 50,
						},
					],
				},
			],
		},
	},
	{ type: "response.completed", response: { output: [] } },
);

let savedKey: string | undefined;
beforeEach(() => {
	savedKey = process.env.EXA_API_KEY;
	delete process.env.EXA_API_KEY;
});
afterEach(() => {
	if (savedKey === undefined) delete process.env.EXA_API_KEY;
	else process.env.EXA_API_KEY = savedKey;
});

describe("Exa", () => {
	it("searches with auto, highlights and the objective, keeping warnings away from the model", async () => {
		const deps = fakeDeps([
			json({
				requestId: "req-1",
				costDollars: { total: 0.007 },
				results: [exaHit],
				notices: [{ code: "RESTRICTIONS_RELAXED", message: "Relaxed the date filter" }],
				warnings: [{ code: "IGNORED_FIELD", message: "ignored foo" }],
			}),
		]);
		const outcome = await exaSearch(deps, registry(), request);
		expect(deps.calls[0]).toMatchObject({
			url: "https://api.exa.ai/search",
			headers: { "x-api-key": "exa-test" },
			body: {
				query: request.query,
				objective: request.objective,
				type: "auto",
				numResults: 5,
				contents: { highlights: true },
				includeDomains: ["vitest.dev"],
				excludeDomains: ["pinterest.com"],
			},
		});
		expect(outcome.hits).toEqual([
			{ title: "Mocking", url: exaHit.url, excerpt: "Use vi.useFakeTimers() … then advance" },
		]);
		expect(outcome.notices).toEqual(["Relaxed the date filter"]);
		expect(outcome.details).toEqual({ requestId: "req-1", costDollars: { total: 0.007 }, warnings: ["ignored foo"] });
		const text = formatSearch({ ...outcome, provider: "exa" });
		expect(text).toContain("Note: Relaxed the date filter");
		expect(text).not.toContain("ignored foo");
		expect(text.endsWith("via exa")).toBe(true);
	});

	it("fetches one content view per request and reports a failed url on its own", async () => {
		const deps = fakeDeps([
			json({
				results: [{ url: "https://a.dev", title: "A", text: "Page A" }],
				statuses: [
					{ id: "https://a.dev", status: "success" },
					{ id: "https://b.dev", status: "error", error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 } },
				],
			}),
			json({ results: [{ url: "https://a.dev", highlights: ["relevant bit"] }] }),
		]);
		const full = await exaContents(deps, registry(), ["https://a.dev", "https://b.dev"], undefined);
		expect(deps.calls[0].body).toEqual({ urls: ["https://a.dev", "https://b.dev"], text: { maxCharacters: 10000 } });
		expect(full.pages).toEqual([
			{ url: "https://a.dev", title: "A", content: "Page A" },
			{ url: "https://b.dev", error: "CRAWL_NOT_FOUND (HTTP 404)" },
		]);
		expect(formatPages(full.pages, [])).toContain("## https://b.dev\nFailed: CRAWL_NOT_FOUND (HTTP 404)");

		const focused = await exaContents(deps, registry(), ["https://a.dev"], "timers");
		expect(deps.calls[1].body).toEqual({ urls: ["https://a.dev"], highlights: { query: "timers" } });
		expect(focused.pages[0].content).toBe("relevant bit");
	});

	it("takes the key /login stored over EXA_API_KEY, and EXA_API_KEY when /login has none", async () => {
		process.env.EXA_API_KEY = "exa-from-env";
		expect(await exaApiKey(registry())).toBe("exa-test");
		expect(await exaApiKey(registry([], null))).toBe("exa-from-env");
		delete process.env.EXA_API_KEY;
		expect(await exaApiKey(registry([], "  "))).toBeUndefined();
	});

	it("retries a rate limit once after Retry-After", async () => {
		const deps = fakeDeps([json({ error: "slow down" }, 429, { "retry-after": "2" }), json({ results: [exaHit] })]);
		const outcome = await exaSearch(deps, registry(), request);
		expect(deps.slept).toEqual([2000]);
		expect(outcome.hits).toHaveLength(1);
	});
});

describe("OpenAI through the Codex login", () => {
	it("sends the web_search tool with the login's headers and reads answer, citations and sources", async () => {
		const deps = fakeDeps([openaiReply]);
		const result = await search({ deps, registry: registry() }, "openai", request);
		const call = deps.calls[0];
		expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses");
		expect(call.headers).toMatchObject({
			authorization: `Bearer ${jwt}`,
			"chatgpt-account-id": "acct-1",
			originator: "pi",
			"x-provider": "1",
		});
		expect(call.headers).not.toHaveProperty("x-dropped");
		expect(call.body).toMatchObject({
			model: "gpt-6.1-luna",
			tools: [
				{ type: "web_search", filters: { allowed_domains: ["vitest.dev"], blocked_domains: ["pinterest.com"] } },
			],
			tool_choice: "required",
			include: ["web_search_call.action.sources"],
			store: false,
			stream: true,
		});
		expect(String(call.body.instructions)).toContain(request.objective);
		expect(result.answer).toBe("Use fake timers [A](https://a.dev/?utm_source=openai).");
		expect(result.hits.map((hit) => hit.url)).toEqual(["https://a.dev/", "https://b.dev/"]);
		expect(formatSearch(result).endsWith("via openai")).toBe(true);
	});

	it("turns a stream error delivered with HTTP 200 into a failure", () => {
		const body = `data: ${JSON.stringify({ type: "error", error: { message: "usage limit reached" } })}\n\n`;
		expect(() => responseOutput(body)).toThrow("usage limit reached");
	});

	it("reads a plain JSON reply too", () => {
		const output = responseOutput(JSON.stringify({ output: [{ type: "message", content: [{ text: "hi" }] }] }));
		expect(parseOutput(output, 5).answer).toBe("hi");
	});

	it("defaults to the newest luna, else the newest bare gpt, never pro or ultra", () => {
		expect(defaultCodexModel(["gpt-6-luna", "gpt-6.1-luna", "gpt-6.1-sol", "gpt-6.2-luna-pro"])).toBe("gpt-6.1-luna");
		expect(defaultCodexModel(["gpt-6", "gpt-6.1", "gpt-6.2-pro", "gpt-6.1-sol"])).toBe("gpt-6.1");
		expect(defaultCodexModel(["gpt-6-ultra"])).toBeUndefined();
	});
});

describe("search fallback", () => {
	it("answers from OpenAI when Exa is out of credits, saying why", async () => {
		const deps = fakeDeps([json({ error: "no credits", tag: "NO_MORE_CREDITS" }, 402), openaiReply]);
		const result = await search({ deps, registry: registry() }, "exa", request);
		expect(result.provider).toBe("openai");
		expect(deps.slept).toEqual([]);
		expect(formatSearch(result)).toContain(
			"via openai (fallback: Exa out of credits or over budget (NO_MORE_CREDITS: no credits))",
		);
	});

	it("answers from Exa when there is no Codex login, without calling OpenAI", async () => {
		const deps = fakeDeps([json({ results: [exaHit] })]);
		const result = await search({ deps, registry: registry([]) }, "openai", request);
		expect(result.provider).toBe("exa");
		expect(result.fallbackReason).toContain("not signed in");
		expect(deps.calls.map((c) => c.url)).toEqual(["https://api.exa.ai/search"]);
	});

	it("falls back after a retried outage", async () => {
		const deps = fakeDeps([json({}, 503), json({}, 503), openaiReply]);
		const result = await search({ deps, registry: registry() }, "exa", request);
		expect(deps.slept).toEqual([1000]);
		expect(result.provider).toBe("openai");
	});

	it("neither retries nor falls back on a bad request", async () => {
		const deps = fakeDeps([json({ error: "bad numResults", tag: "INVALID_REQUEST_BODY" }, 400)]);
		await expect(search({ deps, registry: registry() }, "exa", request)).rejects.toThrow("INVALID_REQUEST_BODY");
		expect(deps.calls).toHaveLength(1);
	});

	it("names both causes when neither provider can answer", async () => {
		const deps = fakeDeps([]);
		await expect(search({ deps, registry: registry([], null) }, "exa", request)).rejects.toThrow(
			"Exa: no Exa API key (add one with /login → Sign in with an API key → Exa); OpenAI: not signed in to ChatGPT/Codex (use /login)",
		);
	});
});

describe("web preferences", () => {
	it("defaults to Exa and keeps each choice when the other changes", () => {
		const dir = mkdtempSync(join(tmpdir(), "web-prefs-"));
		expect(loadWebPrefs(dir)).toEqual({ provider: "exa", openaiModel: undefined });
		saveWebPrefs(dir, { provider: "openai" });
		saveWebPrefs(dir, { openaiModel: "gpt-6.1-luna" });
		expect(loadWebPrefs(dir)).toEqual({ provider: "openai", openaiModel: "gpt-6.1-luna" });
	});
});
