/**
 * `websearch` provider adapters (PLAN.md F4.2).
 *
 * Each provider maps its response to a uniform `{ title, url, snippet }[]`. The
 * API key is read by the caller (index.ts) from the trust-aware settings; this
 * module only performs the request. `webSearch` uses global `fetch` by default
 * (so tests can `vi.stubGlobal("fetch", ...)`) and hits only the fixed provider
 * host, so it needs no SSRF guard.
 */

import { VERSION } from "@earendil-works/pi-coding-agent";
import { APP_NAME } from "../../../packages/coding-agent/src/config.ts";

export type SearchProvider = "exa" | "brave" | "tavily";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

const USER_AGENT = `${APP_NAME}/${VERSION}`;
const TIMEOUT_MS = 30_000;
const NUM_RESULTS = 5;

/** Cap on the unrecognized-response fallback snippet (chars). */
const MAX_FALLBACK_SNIPPET = 4000;

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated ${text.length - max} chars)`;
}

/** The default environment variable holding the API key for a provider. */
export function defaultEnvFor(provider: SearchProvider): string {
	switch (provider) {
		case "brave":
			return "BRAVE_API_KEY";
		case "tavily":
			return "TAVILY_API_KEY";
		default:
			return "EXA_API_KEY";
	}
}

function timeoutSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

async function exaSearch(
	query: string,
	apiKey: string,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
): Promise<SearchResult[]> {
	const res = await fetchImpl("https://api.exa.ai/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"User-Agent": USER_AGENT,
		},
		body: JSON.stringify({ query, numResults: NUM_RESULTS }),
		signal,
	});
	if (!res.ok) throw new Error(`websearch: exa returned ${res.status} ${res.statusText}`.trim());
	const data = (await res.json()) as {
		results?: Array<Record<string, unknown>>;
	};
	return (data.results ?? []).map((r) => ({
		title: str(r.title) || str(r.url),
		url: str(r.url),
		snippet: str(r.text) || str(r.snippet),
	}));
}

async function braveSearch(
	query: string,
	apiKey: string,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
): Promise<SearchResult[]> {
	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${NUM_RESULTS}`;
	const res = await fetchImpl(url, {
		headers: {
			Accept: "application/json",
			"X-Subscription-Token": apiKey,
			"User-Agent": USER_AGENT,
		},
		signal,
	});
	if (!res.ok) throw new Error(`websearch: brave returned ${res.status} ${res.statusText}`.trim());
	const data = (await res.json()) as {
		web?: { results?: Array<Record<string, unknown>> };
	};
	return (data.web?.results ?? []).map((r) => ({
		title: str(r.title) || str(r.url),
		url: str(r.url),
		snippet: str(r.description),
	}));
}

async function tavilySearch(
	query: string,
	apiKey: string,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
): Promise<SearchResult[]> {
	const res = await fetchImpl("https://api.tavily.com/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
		body: JSON.stringify({ api_key: apiKey, query, max_results: NUM_RESULTS }),
		signal,
	});
	if (!res.ok) throw new Error(`websearch: tavily returned ${res.status} ${res.statusText}`.trim());
	const data = (await res.json()) as {
		results?: Array<Record<string, unknown>>;
	};
	return (data.results ?? []).map((r) => ({
		title: str(r.title) || str(r.url),
		url: str(r.url),
		snippet: str(r.content),
	}));
}

/**
 * Exa's hosted MCP endpoint, which answers `web_search_exa` with NO credentials.
 * This is what makes websearch work out of the box (audit C.2).
 *
 * Spoken over plain fetch rather than the MCP SDK: this is one fixed endpoint and
 * two calls, and keeping it here preserves the module's injectable-fetch shape (so
 * it is testable) and keeps the SDK's heavy tree off this path. The trade-off is
 * that we track the wire format ourselves — hence decodeRpc tolerating both SSE
 * and plain JSON, and parseExaMcpResults falling back rather than throwing.
 */
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const MCP_PROTOCOL_VERSION = "2025-03-26";

interface RpcEnvelope {
	result?: { content?: Array<{ type?: string; text?: string }> };
	error?: { message?: string };
}

/** A Streamable-HTTP MCP reply is either a JSON body or SSE frames carrying one. */
function decodeRpc(body: string): RpcEnvelope | undefined {
	try {
		return JSON.parse(body) as RpcEnvelope;
	} catch {
		// Not plain JSON — read the `data:` payload of each SSE frame instead.
	}
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue;
		try {
			return JSON.parse(line.slice(5).trim()) as RpcEnvelope;
		} catch {
			// Keep-alive or partial frame; keep looking.
		}
	}
	return undefined;
}

/**
 * Turn Exa's `Title:/URL:/Highlights:` text blocks into results.
 *
 * The shape is Exa's own, not a spec, so anything unrecognised is passed through
 * as a single snippet: a format change should degrade to "here is what we got",
 * never to a silent "no results".
 */
export function parseExaMcpResults(text: string): SearchResult[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	const results: SearchResult[] = [];
	for (const block of trimmed.split(/\n\s*---\s*\n/)) {
		if (!block.trim()) continue;
		const title = /^Title:[ \t]*(.*)$/m.exec(block)?.[1].trim() ?? "";
		const url = /^URL:[ \t]*(.*)$/m.exec(block)?.[1].trim() ?? "";
		const highlights = block.split(/^Highlights:[ \t]*$/m)[1]?.trim() ?? "";
		if (!title && !url) continue;
		results.push({ title: title || url, url, snippet: highlights });
	}
	// Degrade to "here is what we got" rather than a silent "no results" — but
	// bounded: this is an entire third-party response body headed for the context.
	return results.length > 0
		? results
		: [
				{
					title: "",
					url: "",
					snippet: truncate(trimmed, MAX_FALLBACK_SNIPPET),
				},
			];
}

/** Search via Exa's hosted MCP endpoint. Sends no credentials — there are none. */
export async function exaMcpSearch(
	query: string,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	// Same bound the keyed providers get. This path used to run with whatever the
	// caller passed — including a signal that never aborts.
	const effectiveSignal = timeoutSignal(signal);
	let sessionId: string | undefined;
	const rpc = async (body: Record<string, unknown>): Promise<string> => {
		const res = await fetchImpl(EXA_MCP_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"User-Agent": USER_AGENT,
				...(sessionId ? { "mcp-session-id": sessionId } : {}),
			},
			body: JSON.stringify(body),
			signal: effectiveSignal,
			// Do not chase redirects: this speaks to one fixed host, and the guarded
			// dispatcher that screens for internal addresses lives in fetch.ts, not here.
			redirect: "manual",
		});
		if (!res.ok) throw new Error(`websearch: exa mcp returned ${res.status} ${res.statusText}`.trim());
		sessionId = res.headers.get("mcp-session-id") ?? sessionId;
		return res.text();
	};

	await rpc({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: APP_NAME, version: VERSION },
		},
	});
	await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
	const body = await rpc({
		jsonrpc: "2.0",
		id: 2,
		method: "tools/call",
		params: {
			name: "web_search_exa",
			arguments: { query, numResults: NUM_RESULTS },
		},
	});

	const envelope = decodeRpc(body);
	if (envelope?.error) throw new Error(`websearch: exa mcp error: ${envelope.error.message ?? "unknown"}`);
	const text = (envelope?.result?.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
	return parseExaMcpResults(text);
}

/**
 * Run a web search against the configured provider. Throws on a network / non-2xx
 * error (the tool surfaces missing-key BEFORE calling this, as a normal result).
 */
export async function webSearch(opts: {
	query: string;
	provider: SearchProvider;
	apiKey: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}): Promise<SearchResult[]> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const signal = timeoutSignal(opts.signal);
	switch (opts.provider) {
		case "brave":
			return braveSearch(opts.query, opts.apiKey, fetchImpl, signal);
		case "tavily":
			return tavilySearch(opts.query, opts.apiKey, fetchImpl, signal);
		default:
			return exaSearch(opts.query, opts.apiKey, fetchImpl, signal);
	}
}
