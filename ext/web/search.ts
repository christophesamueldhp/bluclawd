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

export type SearchProvider = "exa" | "brave" | "tavily";

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
	/** Publication date as YYYY-MM-DD, when the provider reports one. */
	published?: string;
}

/** How far back results may be published. */
export type Recency = "day" | "week" | "month" | "year";

const RECENCY_DAYS: Record<Recency, number> = { day: 1, week: 7, month: 31, year: 365 };

function recencyStart(recency: Recency): Date {
	return new Date(Date.now() - RECENCY_DAYS[recency] * 24 * 60 * 60 * 1000);
}

/**
 * Drop results published before the window. Undated results stay: the keyless
 * endpoint only sometimes reports a date, and "unknown" is not "old".
 */
function filterByRecency(results: SearchResult[], recency: Recency | undefined): SearchResult[] {
	if (!recency) return results;
	const start = recencyStart(recency).toISOString().slice(0, 10);
	return results.filter((r) => !r.published || r.published >= start);
}

/** Host allow/block lists (Claude Code's `allowed_domains` / `blocked_domains`). */
export interface DomainFilter {
	allowedDomains?: string[];
	blockedDomains?: string[];
}

const USER_AGENT = `pi/${VERSION}`;
const TIMEOUT_MS = 30_000;
const NUM_RESULTS = 5;
/** Asked for when the filtering happens on our side, so a few survive it. */
const NUM_RESULTS_FILTERED = 20;

function hasFilter(filter: DomainFilter | undefined): boolean {
	return Boolean(filter?.allowedDomains?.length || filter?.blockedDomains?.length);
}

/** `example.com` from any of `example.com`, `*.example.com`, `https://example.com/x`. */
function normalizeDomain(spec: string): string {
	let d = spec.trim().toLowerCase();
	const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/.exec(d);
	if (m) d = m[1];
	return d.replace(/^\*\./, "").replace(/^\./, "").replace(/\/.*$/, "");
}

/** Domains as native provider filters expect them: bare, lowercase hosts. */
function nativeDomains(specs: string[]): string[] {
	return specs.map(normalizeDomain).filter(Boolean);
}

function hostMatches(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Apply a domain filter client-side. Used for providers with no native filter
 * (Brave, the keyless MCP endpoint) and, cheaply, on top of the ones that have
 * one. A result whose url does not parse has no host: it fails an allow list
 * and survives a block list.
 */
export function filterByDomain(
	results: SearchResult[],
	filter: { allowed?: string[]; blocked?: string[] },
): SearchResult[] {
	const allowed = (filter.allowed ?? []).map(normalizeDomain).filter(Boolean);
	const blocked = (filter.blocked ?? []).map(normalizeDomain).filter(Boolean);
	if (allowed.length === 0 && blocked.length === 0) return results;
	return results.filter((r) => {
		let host: string | undefined;
		try {
			host = new URL(r.url).hostname.toLowerCase();
		} catch {
			host = undefined;
		}
		if (allowed.length > 0) return host !== undefined && allowed.some((d) => hostMatches(host, d));
		return host === undefined || !blocked.some((d) => hostMatches(host, d));
	});
}

/** YYYY-MM-DD from whatever date string a provider sends, or undefined. */
function isoDate(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	const t = Date.parse(value);
	return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

function withDate(result: SearchResult, raw: unknown): SearchResult {
	const published = isoDate(raw);
	return published ? { ...result, published } : result;
}

/** An error for a non-2xx provider reply, naming the key variable on 401/403. */
function providerError(provider: string, res: Response, envVar?: string): Error {
	const status = `${res.status} ${res.statusText}`.trim();
	const hint = envVar && (res.status === 401 || res.status === 403) ? ` (check ${envVar})` : "";
	return new Error(`websearch: ${provider} returned ${status}${hint}`);
}

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
	filter: DomainFilter,
	recency: Recency | undefined,
): Promise<SearchResult[]> {
	const res = await fetchImpl("https://api.exa.ai/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"User-Agent": USER_AGENT,
		},
		body: JSON.stringify({
			query,
			numResults: NUM_RESULTS,
			...(filter.allowedDomains?.length ? { includeDomains: nativeDomains(filter.allowedDomains) } : {}),
			...(filter.blockedDomains?.length ? { excludeDomains: nativeDomains(filter.blockedDomains) } : {}),
			...(recency ? { startPublishedDate: recencyStart(recency).toISOString() } : {}),
		}),
		signal,
	});
	if (!res.ok) throw providerError("exa", res, defaultEnvFor("exa"));
	const data = (await res.json()) as {
		results?: Array<Record<string, unknown>>;
	};
	return (data.results ?? []).map((r) =>
		withDate(
			{
				title: str(r.title) || str(r.url),
				url: str(r.url),
				snippet: str(r.text) || str(r.snippet),
			},
			r.publishedDate,
		),
	);
}

async function braveSearch(
	query: string,
	apiKey: string,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
	filter: DomainFilter,
	recency: Recency | undefined,
): Promise<SearchResult[]> {
	// Brave has no domain parameters: narrow the query with site: operators, and
	// still over-request so the caller's post-filter has results to keep.
	const count = hasFilter(filter) ? NUM_RESULTS_FILTERED : NUM_RESULTS;
	const allowed = nativeDomains(filter.allowedDomains ?? []);
	const blocked = nativeDomains(filter.blockedDomains ?? []);
	let q = query;
	if (allowed.length) q += ` (${allowed.map((d) => `site:${d}`).join(" OR ")})`;
	for (const d of blocked) q += ` -site:${d}`;
	const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}${recency ? `&freshness=p${recency[0]}` : ""}`;
	const res = await fetchImpl(url, {
		headers: {
			Accept: "application/json",
			"X-Subscription-Token": apiKey,
			"User-Agent": USER_AGENT,
		},
		signal,
	});
	if (!res.ok) throw providerError("brave", res, defaultEnvFor("brave"));
	const data = (await res.json()) as {
		web?: { results?: Array<Record<string, unknown>> };
	};
	return (data.web?.results ?? []).map((r) =>
		withDate(
			{
				title: str(r.title) || str(r.url),
				url: str(r.url),
				snippet: str(r.description),
			},
			r.page_age,
		),
	);
}

async function tavilySearch(
	query: string,
	apiKey: string,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
	filter: DomainFilter,
	recency: Recency | undefined,
): Promise<SearchResult[]> {
	const res = await fetchImpl("https://api.tavily.com/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
		body: JSON.stringify({
			api_key: apiKey,
			query,
			max_results: NUM_RESULTS,
			...(filter.allowedDomains?.length ? { include_domains: nativeDomains(filter.allowedDomains) } : {}),
			...(filter.blockedDomains?.length ? { exclude_domains: nativeDomains(filter.blockedDomains) } : {}),
			...(recency ? { time_range: recency } : {}),
		}),
		signal,
	});
	if (!res.ok) throw providerError("tavily", res, defaultEnvFor("tavily"));
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
		results.push(
			withDate({ title: title || url, url, snippet: highlights }, /^Published:[ \t]*(.*)$/m.exec(block)?.[1]),
		);
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

// The MCP session survives across searches: the handshake is two round-trips,
// and a search is one, so reusing it makes repeat searches three times cheaper.
// Module state is fine here — search.ts is only ever imported within ext/web.
let exaMcpSession: string | undefined;

/** Forget the cached keyless session (tests). */
export function resetExaMcpSession(): void {
	exaMcpSession = undefined;
}

/** A keyless reply error; a 429 means the shared anonymous quota ran out, which a key fixes. */
function exaMcpError(res: Response): Error {
	if (res.status !== 429) return providerError("exa mcp", res);
	return new Error(`websearch: exa mcp returned 429 (keyless search is rate-limited; set EXA_API_KEY)`);
}

function mcpText(envelope: RpcEnvelope | undefined): string {
	if (envelope?.error) throw new Error(`websearch: exa mcp error: ${envelope.error.message ?? "unknown"}`);
	return (envelope?.result?.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

/**
 * Search via Exa's hosted MCP endpoint. Sends no credentials — there are none.
 *
 * With a domain filter or recency it first asks the endpoint's advanced tool,
 * which filters natively and dates every result; if that fails it falls back to
 * the basic tool and filters here. The post-filters run on both paths.
 */
export async function exaMcpSearch(
	query: string,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
	filter: DomainFilter = {},
	recency?: Recency,
): Promise<SearchResult[]> {
	// Same bound the keyed providers get. This path used to run with whatever the
	// caller passed — including a signal that never aborts.
	const effectiveSignal = timeoutSignal(signal);
	let results: SearchResult[] | undefined;
	if (hasFilter(filter) || recency) {
		try {
			results = await exaMcpAdvancedSearch(query, fetchImpl, effectiveSignal, filter, recency);
		} catch (err) {
			if (effectiveSignal.aborted) throw err;
		}
	}
	results ??= await exaMcpBasicSearch(query, fetchImpl, effectiveSignal, filter, recency);
	return filterByRecency(
		filterByDomain(results, { allowed: filter.allowedDomains, blocked: filter.blockedDomains }),
		recency,
	);
}

/**
 * The advanced tool is not in the endpoint's default tool set: `?tools=` enables
 * it. It answers without a session, so this is one stateless call, and it
 * replies with Exa's search JSON rather than text blocks.
 */
async function exaMcpAdvancedSearch(
	query: string,
	fetchImpl: typeof fetch,
	signal: AbortSignal,
	filter: DomainFilter,
	recency: Recency | undefined,
): Promise<SearchResult[]> {
	const res = await fetchImpl(`${EXA_MCP_URL}?tools=web_search_advanced_exa`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"User-Agent": USER_AGENT,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "web_search_advanced_exa",
				arguments: {
					query,
					type: "auto",
					numResults: NUM_RESULTS,
					...(filter.allowedDomains?.length ? { includeDomains: nativeDomains(filter.allowedDomains) } : {}),
					...(filter.blockedDomains?.length ? { excludeDomains: nativeDomains(filter.blockedDomains) } : {}),
					...(recency ? { startPublishedDate: recencyStart(recency).toISOString() } : {}),
					enableHighlights: true,
					textMaxCharacters: 1000,
				},
			},
		}),
		signal,
		redirect: "manual",
	});
	if (!res.ok) throw exaMcpError(res);
	const data = JSON.parse(mcpText(decodeRpc(await res.text()))) as { results?: Array<Record<string, unknown>> };
	if (!Array.isArray(data.results)) throw new Error("websearch: exa mcp advanced search returned no results list");
	return data.results.map((r) =>
		withDate(
			{
				title: str(r.title) || str(r.url),
				url: str(r.url),
				snippet: Array.isArray(r.highlights) ? r.highlights.map(str).join("\n") : str(r.text),
			},
			r.publishedDate,
		),
	);
}

async function exaMcpBasicSearch(
	query: string,
	fetchImpl: typeof fetch,
	effectiveSignal: AbortSignal,
	filter: DomainFilter,
	recency: Recency | undefined,
): Promise<SearchResult[]> {
	const rpc = async (body: Record<string, unknown>): Promise<Response> => {
		const res = await fetchImpl(EXA_MCP_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"User-Agent": USER_AGENT,
				...(exaMcpSession ? { "mcp-session-id": exaMcpSession } : {}),
			},
			body: JSON.stringify(body),
			signal: effectiveSignal,
			// Do not chase redirects: this speaks to one fixed host, and the guarded
			// dispatcher that screens for internal addresses lives in fetch.ts, not here.
			redirect: "manual",
		});
		if (res.ok) exaMcpSession = res.headers.get("mcp-session-id") ?? exaMcpSession;
		return res;
	};
	const handshake = async (): Promise<void> => {
		const init = await rpc({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "pi", version: VERSION },
			},
		});
		if (!init.ok) throw exaMcpError(init);
		await init.body?.cancel().catch(() => {});
		const ack = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
		await ack.body?.cancel().catch(() => {});
	};
	const search = () =>
		rpc({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: {
				name: "web_search_exa",
				// No domain or date parameter on this endpoint: over-request and post-filter.
				// `objective` is required by its schema; the recency wish rides along in it.
				arguments: {
					query,
					numResults: hasFilter(filter) || recency ? NUM_RESULTS_FILTERED : NUM_RESULTS,
					objective: recency ? `${query} (prefer pages published in the past ${recency})` : query,
				},
			},
		});

	const hadCachedSession = Boolean(exaMcpSession);
	if (!hadCachedSession) await handshake();
	let res = await search();
	if (!res.ok && hadCachedSession) {
		// The server forgot our session (restart, expiry): start a fresh one, once.
		await res.body?.cancel().catch(() => {});
		exaMcpSession = undefined;
		await handshake();
		res = await search();
	}
	if (!res.ok) throw exaMcpError(res);
	return parseExaMcpResults(mcpText(decodeRpc(await res.text())));
}

/**
 * Run a web search against the configured provider. Throws on a network / non-2xx
 * error (the tool surfaces missing-key BEFORE calling this, as a normal result).
 */
export async function webSearch(
	opts: {
		query: string;
		provider: SearchProvider;
		apiKey: string;
		signal?: AbortSignal;
		fetchImpl?: typeof fetch;
		recency?: Recency;
	} & DomainFilter,
): Promise<SearchResult[]> {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const signal = timeoutSignal(opts.signal);
	const filter: DomainFilter = { allowedDomains: opts.allowedDomains, blockedDomains: opts.blockedDomains };
	let results: SearchResult[];
	switch (opts.provider) {
		case "brave":
			results = await braveSearch(opts.query, opts.apiKey, fetchImpl, signal, filter, opts.recency);
			break;
		case "tavily":
			results = await tavilySearch(opts.query, opts.apiKey, fetchImpl, signal, filter, opts.recency);
			break;
		default:
			results = await exaSearch(opts.query, opts.apiKey, fetchImpl, signal, filter, opts.recency);
	}
	// Applied after the native filter too: cheap, and it holds even if a provider is lax.
	return filterByDomain(results, { allowed: filter.allowedDomains, blocked: filter.blockedDomains });
}
