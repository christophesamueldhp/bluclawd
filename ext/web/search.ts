import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { exaSearch, type FetchedPage, type SearchOutcome, type SearchRequest } from "./exa.ts";
import { type HttpDeps, WebError } from "./http.ts";
import { openaiSearch, resolveCodexAuth } from "./openai.ts";
import type { SearchProvider } from "./prefs.ts";

export interface SearchEnv {
	deps: HttpDeps;
	registry: ModelRegistry;
	openaiModel?: string;
}

export interface Answered extends SearchOutcome {
	provider: SearchProvider;
	/** Why the first provider did not answer, when the other one did. */
	fallbackReason?: string;
}

const NAMES: Record<SearchProvider, string> = { exa: "Exa", openai: "OpenAI" };

async function searchWith(
	env: SearchEnv,
	provider: SearchProvider,
	request: SearchRequest,
	signal?: AbortSignal,
): Promise<SearchOutcome> {
	if (provider === "exa") return exaSearch(env.deps, request, signal);
	return openaiSearch(env.deps, await resolveCodexAuth(env.registry, env.openaiModel), request, signal);
}

/** Search `first`, and the other provider when `first` cannot answer; a bad request is not retried elsewhere. */
export async function search(
	env: SearchEnv,
	first: SearchProvider,
	request: SearchRequest,
	signal?: AbortSignal,
): Promise<Answered> {
	try {
		return { ...(await searchWith(env, first, request, signal)), provider: first };
	} catch (error) {
		if (!(error instanceof WebError) || error.kind === "invalid" || signal?.aborted) throw error;
		const other: SearchProvider = first === "exa" ? "openai" : "exa";
		try {
			return { ...(await searchWith(env, other, request, signal)), provider: other, fallbackReason: error.message };
		} catch (second) {
			if (!(second instanceof WebError)) throw second;
			throw new WebError(`${NAMES[first]}: ${error.message}; ${NAMES[other]}: ${second.message}`, second.kind);
		}
	}
}

export function formatSearch(result: Answered): string {
	const lines: string[] = [];
	if (result.answer) lines.push(result.answer, "");
	result.hits.forEach((hit, i) => {
		lines.push(`${i + 1}. ${hit.title}`, `   ${hit.url}`);
		if (hit.excerpt) lines.push(`   ${hit.excerpt}`);
	});
	if (result.hits.length === 0 && !result.answer) lines.push("No results.");
	for (const notice of result.notices) lines.push("", `Note: ${notice}`);
	lines.push("", `via ${result.provider}${result.fallbackReason ? ` (fallback: ${result.fallbackReason})` : ""}`);
	return lines.join("\n");
}

export function formatPages(pages: FetchedPage[], notices: string[]): string {
	const blocks = pages.map((page) =>
		page.error
			? `## ${page.url}\nFailed: ${page.error}`
			: `## ${page.title ? `${page.title} — ` : ""}${page.url}\n\n${page.content || "(no content)"}`,
	);
	return [...blocks, ...notices.map((notice) => `Note: ${notice}`)].join("\n\n");
}
