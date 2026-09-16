/**
 * `websearch` provider routing: an ordered chain of providers, where a provider
 * with no key configured is skipped and a failing one hands over to the next
 * when its failure is of a kind the user chose to fall back on.
 *
 * Settings (`websearch`, trust-aware like the rest of the section):
 *   "provider": "exa",                     single provider (the default chain)
 *   "routing": ["brave", "searxng", "exa"], ordered chain; overrides provider
 *   "fallbackOn": ["transient", "quota", "network"],   the default
 *   "apiKeyEnv": "MY_EXA_KEY",             key variable for `provider`
 *   "apiKeyEnvs": { "serper": "SERPER_KEY" },  key variables for any provider
 *   "searxngUrl": "https://searx.example.org",
 *   "keyless": false                        never use Exa's keyless endpoint
 */

import { EXTRA_PROVIDERS, type ExtraProvider } from "./providers.ts";
import {
	type DomainFilter,
	defaultEnvFor,
	exaMcpSearch,
	type Recency,
	type SearchResult,
	timeoutSignal,
	webSearch,
} from "./search.ts";

export type ProviderName = "exa" | "brave" | "tavily" | ExtraProvider;
export type FailureKind = "transient" | "quota" | "network" | "auth" | "other";

export interface RouterSettings {
	provider?: string;
	routing?: string[];
	fallbackOn?: FailureKind[];
	apiKeyEnv?: string;
	apiKeyEnvs?: Record<string, string>;
	searxngUrl?: string;
	keyless?: boolean;
}

export const PROVIDER_NAMES: ProviderName[] = [
	"exa",
	"brave",
	"tavily",
	...(Object.keys(EXTRA_PROVIDERS) as ExtraProvider[]),
];

const DEFAULT_FALLBACK_ON: FailureKind[] = ["transient", "quota", "network"];

/** What kind of failure an adapter error is, from the status its message carries. */
export function classifyFailure(err: unknown): FailureKind {
	if (!(err instanceof Error)) return "other";
	if (err.name === "TimeoutError") return "transient";
	const status = /\b(?:returned|error) (\d{3})\b/.exec(err.message)?.[1];
	if (status) {
		const code = Number(status);
		if (code === 402 || code === 429) return "quota";
		if (code === 401 || code === 403) return "auth";
		if (code === 408 || code === 425 || code >= 500) return "transient";
		return "other";
	}
	if (/needs an API key/.test(err.message)) return "auth";
	if (err.name === "TypeError" || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(err.message)) {
		return "network";
	}
	return "other";
}

export interface RoutedSearch {
	results: SearchResult[];
	/** The provider that answered, or undefined when none could run. */
	provider?: ProviderName;
	/** Why earlier providers in the chain did not answer. */
	skipped: string[];
	/** Set when no provider could run at all (keys missing): the text to show instead. */
	unconfigured?: string;
}

export async function routedSearch(opts: {
	query: string;
	filter: DomainFilter;
	recency?: Recency;
	signal?: AbortSignal;
	settings: RouterSettings | undefined;
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}): Promise<RoutedSearch> {
	const ws = opts.settings ?? {};
	const env = opts.env ?? process.env;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const chain = (ws.routing?.length ? ws.routing : [ws.provider ?? "exa"]) as string[];
	const fallbackOn = new Set(ws.fallbackOn ?? DEFAULT_FALLBACK_ON);
	const skipped: string[] = [];
	const errors: string[] = [];
	let ran = false;

	const envFor = (name: string): string =>
		ws.apiKeyEnvs?.[name] ??
		(name === (ws.provider ?? "exa") && ws.apiKeyEnv ? ws.apiKeyEnv : undefined) ??
		(name === "exa" || name === "brave" || name === "tavily"
			? defaultEnvFor(name)
			: (EXTRA_PROVIDERS[name as ExtraProvider]?.envVar ?? ""));

	for (const [index, name] of chain.entries()) {
		if (!PROVIDER_NAMES.includes(name as ProviderName)) {
			skipped.push(`${name}: unknown provider`);
			continue;
		}
		const envVar = envFor(name);
		const apiKey = envVar ? env[envVar] : undefined;
		const signal = timeoutSignal(opts.signal);
		let run: (() => Promise<SearchResult[]>) | undefined;
		if (name === "exa" || name === "brave" || name === "tavily") {
			if (apiKey) {
				run = () =>
					webSearch({
						query: opts.query,
						provider: name,
						apiKey,
						signal,
						fetchImpl,
						recency: opts.recency,
						...opts.filter,
					});
			} else if (name === "exa" && ws.keyless !== false) {
				// Zero-config search (audit C.2): Exa's hosted MCP endpoint needs no key. It
				// sends queries to a third party unauthenticated, so `keyless: false` turns it off.
				run = () => exaMcpSearch(opts.query, fetchImpl, signal, opts.filter, opts.recency);
			}
		} else {
			const adapter = EXTRA_PROVIDERS[name as ExtraProvider];
			const baseUrl = adapter.needsBaseUrl ? ws.searxngUrl : undefined;
			if ((!adapter.envVar || apiKey) && (!adapter.needsBaseUrl || baseUrl)) {
				run = () =>
					adapter.search({
						query: opts.query,
						apiKey,
						baseUrl,
						filter: opts.filter,
						recency: opts.recency,
						signal,
						fetchImpl,
					});
			}
		}
		if (!run) {
			skipped.push(name === "searxng" && !ws.searxngUrl ? "searxng: no searxngUrl" : `${name}: no key (${envVar})`);
			continue;
		}
		ran = true;
		try {
			return { results: await run(), provider: name as ProviderName, skipped: [...skipped, ...errors] };
		} catch (err) {
			if (opts.signal?.aborted) throw err;
			const kind = classifyFailure(err);
			const message = err instanceof Error ? err.message : String(err);
			const last = index === chain.length - 1;
			if (last || !fallbackOn.has(kind)) {
				if (errors.length === 0) throw err;
				throw new Error(`${message}\n(earlier in the chain: ${errors.join("; ")})`);
			}
			errors.push(`${name}: ${message}`);
		}
	}
	if (ran) throw new Error(`websearch: every provider failed: ${errors.join("; ")}`);
	const first = chain[0] ?? "exa";
	return {
		results: [],
		skipped,
		unconfigured:
			chain.length === 1
				? `Web search needs an API key. Set the ${envFor(first)} environment variable, or configure settings.websearch (provider is "${first}").`
				: `Web search could not run any provider in settings.websearch.routing: ${skipped.join("; ")}.`,
	};
}
