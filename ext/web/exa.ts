/**
 * Exa's search and contents endpoints, in the shapes Exa recommends for agents: `auto` search
 * with highlights, and one content view per contents request.
 */
import { type HttpDeps, postJson, WebError } from "./http.ts";

const EXA_URL = "https://api.exa.ai";
export const FETCH_MAX_CHARACTERS = 10_000;

export interface SearchRequest {
	query: string;
	objective: string;
	numResults: number;
	includeDomains: string[];
	excludeDomains: string[];
}

export interface SearchHit {
	title: string;
	url: string;
	excerpt: string;
}

export interface SearchOutcome {
	answer?: string;
	hits: SearchHit[];
	/** Exa's notices, written for the model. */
	notices: string[];
	/** For the user, never the model: request id, cost, Exa's warnings. */
	details: Record<string, unknown>;
}

export interface FetchedPage {
	url: string;
	title?: string;
	content?: string;
	error?: string;
}

interface ExaMessage {
	code?: string;
	message?: string;
}

interface ExaResult {
	url?: string;
	id?: string;
	title?: string | null;
	text?: string;
	highlights?: string[];
}

interface ExaResponse {
	requestId?: string;
	costDollars?: unknown;
	results?: ExaResult[];
	notices?: ExaMessage[];
	warnings?: ExaMessage[];
	statuses?: { id?: string; status?: string; error?: { tag?: string; httpStatusCode?: number } }[];
}

function apiKey(): string {
	const key = process.env.EXA_API_KEY?.trim();
	if (!key) throw new WebError("EXA_API_KEY is not set", "unavailable");
	return key;
}

function describe(status: number, text: string): string {
	let detail = text.slice(0, 300);
	try {
		const body = JSON.parse(text) as { error?: unknown; tag?: unknown };
		detail = [body.tag, body.error].filter((part) => typeof part === "string").join(": ") || detail;
	} catch {}
	const cause =
		status === 401 ? "invalid API key" : status === 402 ? "out of credits or over budget" : `HTTP ${status}`;
	return `Exa ${cause}${detail ? ` (${detail})` : ""}`;
}

async function post(deps: HttpDeps, path: string, body: unknown, signal?: AbortSignal): Promise<ExaResponse> {
	const response = await postJson(deps, `${EXA_URL}${path}`, { "x-api-key": apiKey() }, body, describe, signal);
	return (await response.json()) as ExaResponse;
}

function details(data: ExaResponse): Record<string, unknown> {
	const warnings = (data.warnings ?? []).map((w) => w.message ?? w.code).filter(Boolean);
	return {
		requestId: data.requestId,
		costDollars: data.costDollars,
		...(warnings.length > 0 ? { warnings } : {}),
	};
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export async function exaSearch(deps: HttpDeps, request: SearchRequest, signal?: AbortSignal): Promise<SearchOutcome> {
	const data = await post(
		deps,
		"/search",
		{
			query: request.query,
			objective: request.objective,
			type: "auto",
			numResults: request.numResults,
			contents: { highlights: true },
			...(request.includeDomains.length > 0 ? { includeDomains: request.includeDomains } : {}),
			...(request.excludeDomains.length > 0 ? { excludeDomains: request.excludeDomains } : {}),
		},
		signal,
	);
	return {
		hits: (data.results ?? [])
			.filter((result) => typeof result.url === "string")
			.map((result) => ({
				title: result.title || (result.url as string),
				url: result.url as string,
				excerpt: oneLine((result.highlights ?? []).join(" … ")),
			})),
		notices: (data.notices ?? []).map((n) => n.message ?? n.code ?? "").filter(Boolean),
		details: details(data),
	};
}

export async function exaContents(
	deps: HttpDeps,
	urls: string[],
	query: string | undefined,
	signal?: AbortSignal,
): Promise<{ pages: FetchedPage[]; notices: string[]; details: Record<string, unknown> }> {
	const view = query ? { highlights: { query } } : { text: { maxCharacters: FETCH_MAX_CHARACTERS } };
	const data = await post(deps, "/contents", { urls, ...view }, signal);
	const results = data.results ?? [];
	const pages = urls.map((url): FetchedPage => {
		const result = results.find((r) => r.url === url || r.id === url);
		const status = data.statuses?.find((s) => s.id === url);
		if (status?.status === "error" || !result) {
			const tag = status?.error?.tag ?? "not returned";
			const code = status?.error?.httpStatusCode;
			return { url, error: code ? `${tag} (HTTP ${code})` : tag };
		}
		const content = query ? (result.highlights ?? []).join("\n\n…\n\n") : (result.text ?? "");
		return { url, title: result.title ?? undefined, content };
	});
	return {
		pages,
		notices: (data.notices ?? []).map((n) => n.message ?? n.code ?? "").filter(Boolean),
		details: details(data),
	};
}
