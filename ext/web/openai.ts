/**
 * OpenAI's hosted web search through the ChatGPT/Codex login pi already holds: the Responses
 * endpoint pi's own `openai-codex` transport uses, with the `web_search` tool required.
 */
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SearchHit, SearchOutcome, SearchRequest } from "./exa.ts";
import { type HttpDeps, postJson, WebError } from "./http.ts";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_PROVIDER = "openai-codex";

export interface CodexAuth {
	model: string;
	apiKey: string;
	headers: Record<string, string>;
}

export function codexModels(registry: ModelRegistry): Model<Api>[] {
	return registry.getAvailable().filter((model) => model.provider === CODEX_PROVIDER);
}

const version = (id: string) => (/(\d+(?:\.\d+)*)/.exec(id)?.[1] ?? "0").split(".").map(Number);

function newer(a: string, b: string): number {
	const [va, vb] = [version(a), version(b)];
	for (let i = 0; i < Math.max(va.length, vb.length); i++) {
		const diff = (vb[i] ?? 0) - (va[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** The newest `luna`, else the newest bare `gpt-N`; never a `pro` or `ultra` model. */
export function defaultCodexModel(ids: string[]): string | undefined {
	const usable = ids.filter((id) => !/(^|-)(pro|ultra)(-|$)/i.test(id));
	const luna = usable.filter((id) => /(^|-)luna(-|$)/i.test(id)).sort(newer);
	const bare = usable.filter((id) => /^gpt-\d+(\.\d+)*$/i.test(id)).sort(newer);
	return luna[0] ?? bare[0];
}

function accountId(token: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
		const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" && id !== "" ? id : undefined;
	} catch {
		return undefined;
	}
}

function plainHeaders(headers: ProviderHeaders | undefined): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
	);
}

/** The chosen (or default) Codex model and a fresh token for it; pi refreshes the token. */
export async function resolveCodexAuth(registry: ModelRegistry, preferred?: string): Promise<CodexAuth> {
	const models = codexModels(registry);
	const id =
		preferred && models.some((m) => m.id === preferred) ? preferred : defaultCodexModel(models.map((m) => m.id));
	const model = models.find((m) => m.id === id);
	if (!model) throw new WebError("not signed in to ChatGPT/Codex (use /login)", "unavailable");
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		throw new WebError(`ChatGPT/Codex login unavailable${auth.ok ? "" : ` (${auth.error})`}`, "unavailable");
	}
	const headers = plainHeaders(auth.headers);
	const account = accountId(auth.apiKey);
	if (account) headers["chatgpt-account-id"] = account;
	return { model: model.id, apiKey: auth.apiKey, headers };
}

function instructions(request: SearchRequest): string {
	return [
		"Search the web and answer concisely, grounded only in the web results, citing your sources.",
		`Goal of this search: ${request.objective}`,
		`Prefer around ${request.numResults} distinct sources.`,
		request.includeDomains.length > 0 ? `Only use sources from: ${request.includeDomains.join(", ")}.` : "",
		request.excludeDomains.length > 0 ? `Do not use sources from: ${request.excludeDomains.join(", ")}.` : "",
	]
		.filter(Boolean)
		.join(" ");
}

type Item = Record<string, unknown>;

/** The output items of a streamed (SSE) or plain JSON Responses reply; a stream error throws. */
export function responseOutput(body: string): Item[] {
	const trimmed = body.trim();
	if (trimmed.startsWith("{")) {
		const output = (JSON.parse(trimmed) as { output?: unknown }).output;
		return Array.isArray(output) ? output : [];
	}
	const items: Item[] = [];
	let completed: Item[] | undefined;
	for (const line of body.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		let event: Item;
		try {
			event = JSON.parse(line.slice(6));
		} catch {
			continue;
		}
		// The stream can fail with HTTP 200: an `error` event or a failed response carries why.
		const response = event.response as Item | undefined;
		const failure =
			event.type === "error"
				? (event.error ?? event)
				: event.type === "response.failed"
					? response?.error
					: undefined;
		if (failure !== undefined) {
			const message = (failure as Item | null)?.message;
			throw new WebError(
				`OpenAI search failed: ${typeof message === "string" ? message : "stream error"}`,
				"transient",
			);
		}
		if (event.type === "response.output_item.done" && event.item) items.push(event.item as Item);
		if (event.type === "response.completed" && Array.isArray(response?.output) && response.output.length > 0) {
			completed = response.output as Item[];
		}
	}
	return completed ?? items;
}

function cleanUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.searchParams.get("utm_source") === "openai") parsed.searchParams.delete("utm_source");
		return parsed.toString();
	} catch {
		return url;
	}
}

/**
 * The answer text and the cited pages, then the other sources the search consulted. Hits carry
 * no excerpt: the answer already quotes what each citation supports.
 */
export function parseOutput(output: Item[], numResults: number): SearchOutcome {
	const answer: string[] = [];
	const hits: SearchHit[] = [];
	const seen = new Set<string>();
	const add = (url: unknown, title: unknown) => {
		if (typeof url !== "string" || url === "") return;
		const clean = cleanUrl(url);
		if (seen.has(clean)) return;
		seen.add(clean);
		hits.push({ title: typeof title === "string" && title !== "" ? title : clean, url: clean, excerpt: "" });
	};
	for (const item of output.filter((i) => i.type === "message")) {
		for (const part of Array.isArray(item.content) ? (item.content as Item[]) : []) {
			const text = typeof part.text === "string" ? part.text : "";
			if (text.trim()) answer.push(text.trim());
			for (const note of Array.isArray(part.annotations) ? (part.annotations as Item[]) : []) {
				if (note.type === "url_citation") add(note.url, note.title);
			}
		}
	}
	for (const item of output.filter((i) => i.type === "web_search_call")) {
		const sources = (item.action as Item | undefined)?.sources;
		for (const source of Array.isArray(sources) ? (sources as Item[]) : []) add(source.url, source.title);
	}
	return { answer: answer.join("\n\n") || undefined, hits: hits.slice(0, numResults), notices: [], details: {} };
}

export async function openaiSearch(
	deps: HttpDeps,
	auth: CodexAuth,
	request: SearchRequest,
	signal?: AbortSignal,
): Promise<SearchOutcome> {
	const filters = {
		...(request.includeDomains.length > 0 ? { allowed_domains: request.includeDomains.slice(0, 100) } : {}),
		...(request.excludeDomains.length > 0 ? { blocked_domains: request.excludeDomains.slice(0, 100) } : {}),
	};
	const response = await postJson(
		deps,
		CODEX_RESPONSES_URL,
		{
			...auth.headers,
			authorization: `Bearer ${auth.apiKey}`,
			originator: "pi",
			"OpenAI-Beta": "responses=experimental",
			accept: "text/event-stream",
		},
		{
			model: auth.model,
			instructions: instructions(request),
			input: [{ role: "user", content: [{ type: "input_text", text: request.query }] }],
			tools: [{ type: "web_search", ...(Object.keys(filters).length > 0 ? { filters } : {}) }],
			tool_choice: "required",
			include: ["web_search_call.action.sources"],
			store: false,
			stream: true,
		},
		(status, text) =>
			`OpenAI ${status === 401 || status === 403 ? "rejected the ChatGPT/Codex login" : status === 429 ? "rate limit or Codex quota reached" : `HTTP ${status}`}${text ? ` (${text.slice(0, 300)})` : ""}`,
		signal,
	);
	const outcome = parseOutput(responseOutput(await response.text()), request.numResults);
	if (!outcome.answer && outcome.hits.length === 0) throw new WebError("OpenAI search returned nothing", "transient");
	return { ...outcome, details: { model: auth.model } };
}
