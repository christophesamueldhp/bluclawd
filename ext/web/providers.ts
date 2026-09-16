/**
 * Additional `websearch` provider adapters: SearXNG, DuckDuckGo, Jina, Perplexity,
 * Kagi and Serper.
 *
 * Request and response shapes follow pi-web-access (MIT). Like search.ts, every
 * adapter talks to one fixed host (or the user's configured SearXNG instance)
 * with an injected fetch and never follows redirects. Each one ends with the
 * client-side domain filter, so a provider that ignores a native filter cannot
 * leak an excluded host.
 */

import {
	type DomainFilter,
	filterByDomain,
	hasFilter,
	NUM_RESULTS,
	NUM_RESULTS_FILTERED,
	nativeDomains,
	providerError,
	type Recency,
	type SearchResult,
	str,
	USER_AGENT,
	withDate,
} from "./search.ts";

export interface ProviderRequest {
	query: string;
	/** Undefined for keyless providers. */
	apiKey?: string;
	/** Required for searxng. */
	baseUrl?: string;
	filter: DomainFilter;
	recency?: Recency;
	/** Already includes a timeout. */
	signal: AbortSignal;
	fetchImpl: typeof fetch;
}

export interface ProviderAdapter {
	/** Env var holding the key; undefined = keyless. */
	envVar?: string;
	/** Settings key naming a base URL the provider needs (searxng only). */
	needsBaseUrl?: boolean;
	search(req: ProviderRequest): Promise<SearchResult[]>;
}

export type ExtraProvider = "searxng" | "duckduckgo" | "jina" | "perplexity" | "kagi" | "serper";

type Item = Record<string, unknown>;

/** The query narrowed with Google-style `site:` operators, understood by all SERP-backed providers. */
function withSiteOperators(query: string, filter: DomainFilter): string {
	const allowed = nativeDomains(filter.allowedDomains ?? []);
	const blocked = nativeDomains(filter.blockedDomains ?? []);
	let q = query;
	if (allowed.length === 1) q += ` site:${allowed[0]}`;
	else if (allowed.length > 1) q += ` (${allowed.map((d) => `site:${d}`).join(" OR ")})`;
	for (const d of blocked) q += ` -site:${d}`;
	return q;
}

/** Post-filter, and cap unfiltered replies (providers may send more than asked). */
function finish(results: SearchResult[], filter: DomainFilter): SearchResult[] {
	const kept = filterByDomain(
		results.filter((r) => r.url),
		{ allowed: filter.allowedDomains, blocked: filter.blockedDomains },
	);
	return hasFilter(filter) ? kept : kept.slice(0, NUM_RESULTS);
}

function requireKey(provider: string, apiKey: string | undefined, envVar: string): string {
	if (!apiKey) throw new Error(`websearch: ${provider} needs an API key (set ${envVar})`);
	return apiKey;
}

const SEARXNG: ProviderAdapter = {
	needsBaseUrl: true,
	async search({ query, baseUrl, filter, recency, signal, fetchImpl }) {
		if (!baseUrl) throw new Error("websearch: searxng needs a base URL");
		const url = new URL(`${baseUrl.replace(/\/+$/, "")}/search`);
		url.searchParams.set("q", withSiteOperators(query, filter));
		url.searchParams.set("format", "json");
		if (recency) url.searchParams.set("time_range", recency);
		const res = await fetchImpl(url, {
			headers: { Accept: "application/json", "User-Agent": USER_AGENT },
			signal,
			redirect: "manual",
		});
		if (!res.ok) throw providerError("searxng", res);
		const data = (await res.json()) as { results?: Item[] };
		return finish(
			(data.results ?? []).map((r) =>
				withDate({ title: str(r.title) || str(r.url), url: str(r.url), snippet: str(r.content) }, r.publishedDate),
			),
			filter,
		);
	},
};

const DUCKDUCKGO_URL = "https://html.duckduckgo.com/html/";
/** DuckDuckGo's own date filter values. */
const DUCKDUCKGO_DF: Record<Recency, string> = { day: "d", week: "w", month: "m", year: "y" };

/** The destination of a DuckDuckGo result link, unwrapping its `uddg` redirect; http(s) only. */
function decodeDuckDuckGoHref(href: string): string | undefined {
	try {
		const link = new URL(href, DUCKDUCKGO_URL);
		const url = new URL(link.searchParams.get("uddg") ?? link.href);
		return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

/** Organic results from DuckDuckGo's HTML page; ads are skipped. */
export async function parseDuckDuckGoHtml(html: string): Promise<SearchResult[]> {
	const { parseHTML } = await import("linkedom");
	const { document } = parseHTML(html);
	const results: SearchResult[] = [];
	for (const container of document.querySelectorAll(".result")) {
		if (container.classList.contains("result--ad")) continue;
		const anchor = container.querySelector(".result__a");
		const title = anchor?.textContent?.trim() ?? "";
		const url = decodeDuckDuckGoHref(anchor?.getAttribute("href")?.trim() ?? "");
		if (!title || !url) continue;
		results.push({ title, url, snippet: container.querySelector(".result__snippet")?.textContent?.trim() ?? "" });
	}
	return results;
}

const DUCKDUCKGO: ProviderAdapter = {
	async search({ query, filter, recency, signal, fetchImpl }) {
		// No result count on this page (about ten a page): operators narrow the query instead.
		const url = new URL(DUCKDUCKGO_URL);
		url.searchParams.set("q", withSiteOperators(query, filter));
		if (recency) url.searchParams.set("df", DUCKDUCKGO_DF[recency]);
		const res = await fetchImpl(url, {
			headers: {
				Accept: "text/html",
				// The HTML endpoint serves a bot check to non-browser agents more readily.
				"User-Agent": `Mozilla/5.0 (compatible; ${USER_AGENT})`,
			},
			signal,
			redirect: "manual",
		});
		if (!res.ok) throw providerError("duckduckgo", res);
		const results = await parseDuckDuckGoHtml(await res.text());
		if (results.length === 0) {
			throw new Error("websearch: duckduckgo returned no parseable results (possibly a bot check)");
		}
		return finish(results, filter);
	},
};

const JINA_ENV = "JINA_API_KEY";

const JINA: ProviderAdapter = {
	envVar: JINA_ENV,
	async search({ query, apiKey, filter, recency, signal, fetchImpl }) {
		const key = requireKey("jina", apiKey, JINA_ENV);
		// Allowed hosts go in `site` params; blocked hosts and recency only exist as query text.
		let q = query.trim();
		for (const d of nativeDomains(filter.blockedDomains ?? [])) q += ` -site:${d}`;
		if (recency) q += ` published in the past ${recency}`;
		const url = new URL(encodeURIComponent(q), "https://s.jina.ai/");
		url.searchParams.set("count", String(hasFilter(filter) ? NUM_RESULTS_FILTERED : NUM_RESULTS));
		for (const d of nativeDomains(filter.allowedDomains ?? [])) url.searchParams.append("site", d);
		const res = await fetchImpl(url, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${key}`,
				"User-Agent": USER_AGENT,
				"X-Respond-With": "no-content",
				"X-Retain-Images": "none",
			},
			signal,
			redirect: "manual",
		});
		if (!res.ok) throw providerError("jina", res, JINA_ENV);
		const data = (await res.json()) as { code?: unknown; data?: unknown } | Item[];
		const items = Array.isArray(data) ? data : data.data;
		if (!Array.isArray(data) && typeof data.code === "number" && data.code !== 200) {
			throw new Error(`websearch: jina returned code ${data.code}`);
		}
		return finish(
			(Array.isArray(items) ? (items as Item[]) : []).map((r) =>
				withDate(
					{
						title: str(r.title) || str(r.url),
						url: str(r.url),
						snippet: str(r.description).replace(/\s+/g, " ").trim(),
					},
					r.date,
				),
			),
			filter,
		);
	},
};

const PERPLEXITY_ENV = "PERPLEXITY_API_KEY";

const PERPLEXITY: ProviderAdapter = {
	envVar: PERPLEXITY_ENV,
	async search({ query, apiKey, filter, recency, signal, fetchImpl }) {
		const key = requireKey("perplexity", apiKey, PERPLEXITY_ENV);
		// One list for both: a `-` prefix excludes a domain.
		const domains = [
			...nativeDomains(filter.allowedDomains ?? []),
			...nativeDomains(filter.blockedDomains ?? []).map((d) => `-${d}`),
		];
		const res = await fetchImpl("https://api.perplexity.ai/chat/completions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
				"User-Agent": USER_AGENT,
			},
			body: JSON.stringify({
				model: "sonar",
				messages: [{ role: "user", content: query }],
				max_tokens: 1024,
				return_related_questions: false,
				...(recency ? { search_recency_filter: recency } : {}),
				...(domains.length ? { search_domain_filter: domains } : {}),
			}),
			signal,
			redirect: "manual",
		});
		if (!res.ok) throw providerError("perplexity", res, PERPLEXITY_ENV);
		const data = (await res.json()) as { search_results?: unknown; citations?: unknown };
		// Newer replies carry titled, dated `search_results`; older ones only `citations`.
		let results: SearchResult[];
		if (Array.isArray(data.search_results) && data.search_results.length > 0) {
			results = (data.search_results as Item[]).map((r, i) =>
				withDate({ title: str(r.title) || `Source ${i + 1}`, url: str(r.url), snippet: str(r.snippet) }, r.date),
			);
		} else {
			results = (Array.isArray(data.citations) ? data.citations : []).map((c, i) =>
				typeof c === "string"
					? { title: `Source ${i + 1}`, url: c, snippet: "" }
					: { title: str((c as Item)?.title) || `Source ${i + 1}`, url: str((c as Item)?.url), snippet: "" },
			);
		}
		return finish(results, filter);
	},
};

const KAGI_ENV = "KAGI_API_KEY";

const KAGI: ProviderAdapter = {
	envVar: KAGI_ENV,
	async search({ query, apiKey, filter, signal, fetchImpl }) {
		const key = requireKey("kagi", apiKey, KAGI_ENV);
		// No recency or domain parameters: operators in the query, over-request, post-filter.
		const res = await fetchImpl("https://kagi.com/api/v1/search", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
				Accept: "application/json",
				"User-Agent": USER_AGENT,
			},
			body: JSON.stringify({
				query: withSiteOperators(query, filter),
				limit: hasFilter(filter) ? NUM_RESULTS_FILTERED : NUM_RESULTS,
			}),
			signal,
			redirect: "manual",
		});
		if (!res.ok) throw providerError("kagi", res, KAGI_ENV);
		const data = (await res.json()) as { data?: unknown; errors?: unknown };
		if (Array.isArray(data.errors) && data.errors.length > 0) {
			const messages = (data.errors as unknown[]).map((e) => str((e as Item)?.message) || JSON.stringify(e));
			throw new Error(`websearch: kagi error: ${messages.join("; ")}`);
		}
		// `data` is either the result list or an object holding it under `search`.
		const items =
			data.data && typeof data.data === "object" && !Array.isArray(data.data)
				? (data.data as Item).search
				: data.data;
		return finish(
			(Array.isArray(items) ? (items as Item[]) : []).map((r) =>
				withDate(
					{
						title: str(r.title) || str(r.url),
						url: str(r.url),
						snippet: str(r.snippet) || str(r.description),
					},
					r.published,
				),
			),
			filter,
		);
	},
};

const SERPER_ENV = "SERPER_API_KEY";
const SERPER_TBS: Record<Recency, string> = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };

const SERPER: ProviderAdapter = {
	envVar: SERPER_ENV,
	async search({ query, apiKey, filter, recency, signal, fetchImpl }) {
		const key = requireKey("serper", apiKey, SERPER_ENV);
		const res = await fetchImpl("https://google.serper.dev/search", {
			method: "POST",
			headers: {
				"X-API-KEY": key,
				"Content-Type": "application/json",
				Accept: "application/json",
				"User-Agent": USER_AGENT,
			},
			body: JSON.stringify({
				q: withSiteOperators(query, filter),
				num: hasFilter(filter) ? NUM_RESULTS_FILTERED : NUM_RESULTS,
				...(recency ? { tbs: SERPER_TBS[recency] } : {}),
			}),
			signal,
			redirect: "manual",
		});
		if (!res.ok) throw providerError("serper", res, SERPER_ENV);
		const data = (await res.json()) as { organic?: Item[] };
		return finish(
			(data.organic ?? []).map((r) =>
				withDate({ title: str(r.title) || str(r.link), url: str(r.link), snippet: str(r.snippet) }, r.date),
			),
			filter,
		);
	},
};

export const EXTRA_PROVIDERS: Record<ExtraProvider, ProviderAdapter> = {
	searxng: SEARXNG,
	duckduckgo: DUCKDUCKGO,
	jina: JINA,
	perplexity: PERPLEXITY,
	kagi: KAGI,
	serper: SERPER,
};
