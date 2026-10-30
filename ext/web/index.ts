/**
 * Web access: `websearch` through Exa or OpenAI (the user's ChatGPT/Codex login), `webfetch`
 * through Exa, and `/web` to choose the search provider. See docs/adr/0004.
 */
import { Type } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { EXA_PROVIDER, exaApiKey, exaContents } from "./exa.ts";
import { defaultDeps, WebError } from "./http.ts";
import { codexModels, defaultCodexModel } from "./openai.ts";
import { pick } from "./picker.ts";
import { loadWebPrefs, SEARCH_PROVIDERS, type SearchProvider, saveWebPrefs, type WebPrefs } from "./prefs.ts";
import { formatPages, formatSearch, search } from "./search.ts";

const NAMES: Record<SearchProvider, string> = { exa: "Exa", openai: "OpenAI" };

const failed = (what: string, error: WebError) => ({
	content: [{ type: "text" as const, text: `${what} failed: ${error.message}` }],
	details: {},
	isError: true,
});

function splitDomains(domains: string[] | undefined): { includeDomains: string[]; excludeDomains: string[] } {
	const cleaned = (domains ?? []).map((domain) => domain.trim()).filter(Boolean);
	return {
		includeDomains: cleaned.filter((domain) => !domain.startsWith("-")),
		excludeDomains: cleaned.filter((domain) => domain.startsWith("-")).map((domain) => domain.slice(1)),
	};
}

/** The Codex model OpenAI searches run on: the saved choice while it is available, else the default. */
function openaiModel(ctx: ExtensionCommandContext, prefs: WebPrefs): string | undefined {
	const ids = codexModels(ctx.modelRegistry).map((model) => model.id);
	return prefs.openaiModel && ids.includes(prefs.openaiModel) ? prefs.openaiModel : defaultCodexModel(ids);
}

const exaReady = async (ctx: ExtensionCommandContext) => (await exaApiKey(ctx.modelRegistry)) !== undefined;

async function statusText(ctx: ExtensionCommandContext): Promise<string> {
	const prefs = loadWebPrefs(getAgentDir());
	const model = openaiModel(ctx, prefs);
	return [
		`Web search provider: ${NAMES[prefs.provider]}`,
		`Exa: ${(await exaReady(ctx)) ? "API key set" : "no API key (/login → Sign in with an API key → Exa)"} (webfetch always uses Exa)`,
		`OpenAI: ${model ? `ChatGPT/Codex login, model ${model}` : "not signed in to ChatGPT/Codex (/login)"}`,
	].join("\n");
}

function save(ctx: ExtensionCommandContext, update: Partial<WebPrefs>, applied: string): void {
	try {
		saveWebPrefs(getAgentDir(), update);
		ctx.ui.notify(`${applied}. Saved for future sessions.`, "info");
	} catch {
		ctx.ui.notify(`${applied}, but the preference could not be saved.`, "error");
	}
}

async function choose(ctx: ExtensionCommandContext): Promise<void> {
	const prefs = loadWebPrefs(getAgentDir());
	const model = openaiModel(ctx, prefs);
	const mark = (on: boolean) => (on ? "✓ " : "  ");
	const choice = await pick(
		ctx,
		"Web search provider",
		[
			{
				value: "exa",
				label: `${mark(prefs.provider === "exa")}Exa`,
				description: (await exaReady(ctx))
					? "API key · ranked pages with highlights"
					: "no API key (/login → API key → Exa)",
			},
			{
				value: "openai",
				label: `${mark(prefs.provider === "openai")}OpenAI`,
				description: model ? "ChatGPT/Codex login · cited answer · uses Codex quota" : "not signed in (/login)",
			},
			{ value: "model", label: "  OpenAI search model…", description: model ?? "no ChatGPT/Codex models" },
		],
		prefs.provider,
	);
	if (choice === "exa" || choice === "openai") {
		save(ctx, { provider: choice }, `Web search provider: ${NAMES[choice]}`);
	} else if (choice === "model") {
		const models = codexModels(ctx.modelRegistry);
		if (models.length === 0) {
			ctx.ui.notify("No ChatGPT/Codex models: sign in with /login first.", "warning");
			return;
		}
		const id = await pick(
			ctx,
			"OpenAI search model",
			models.map((m) => ({ value: m.id, label: `${mark(m.id === model)}${m.id}`, description: m.name })),
			model,
		);
		if (id) save(ctx, { openaiModel: id }, `OpenAI search model: ${id}`);
	}
}

export default function web(pi: ExtensionAPI) {
	// No models: registering the provider lists Exa under /login's API keys and lets pi resolve the key it stores.
	pi.registerProvider(EXA_PROVIDER, { name: "Exa" });

	pi.registerTool({
		name: "websearch",
		label: "Web search",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		description:
			"Search the web. Returns ranked pages with excerpts, and with OpenAI also a short cited answer. Exa suits finding docs, code and specific pages; OpenAI suits a question that wants a synthesized answer with citations. Omit provider to use the user's choice. Read a result in full with webfetch.",
		parameters: Type.Object(
			{
				query: Type.String({
					description: "A natural-language description of the pages you want, not a bag of keywords.",
				}),
				objective: Type.String({
					maxLength: 4096,
					description:
						"Goal for this search turn; say which documents should rank first, which should be excluded, and what specific facts or figures to pull from them.",
				}),
				provider: Type.Optional(Type.Union([Type.Literal("exa"), Type.Literal("openai")])),
				numResults: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 10, description: "How many pages to return (default 5)." }),
				),
				domains: Type.Optional(
					Type.Array(Type.String(), {
						description: 'Only search these domains; prefix one with "-" to exclude it instead.',
					}),
				),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			const prefs = loadWebPrefs(getAgentDir());
			try {
				const result = await search(
					{ deps: defaultDeps, registry: ctx.modelRegistry, openaiModel: prefs.openaiModel },
					params.provider ?? prefs.provider,
					{
						query: params.query,
						objective: params.objective,
						numResults: params.numResults ?? 5,
						...splitDomains(params.domains),
					},
					signal,
				);
				return {
					content: [{ type: "text", text: formatSearch(result) }],
					details: { provider: result.provider, fallbackReason: result.fallbackReason, ...result.details },
				};
			} catch (error) {
				if (error instanceof WebError) return failed("Web search", error);
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "webfetch",
		label: "Web fetch",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		description:
			"Read known web pages through Exa. Pass a query to get only the passages relevant to it; omit it for each page's text, up to 10,000 characters. A URL that fails is reported on its own.",
		parameters: Type.Object(
			{
				urls: Type.Array(Type.String(), { minItems: 1, maxItems: 10, description: "The pages to read." }),
				query: Type.Optional(Type.String({ description: "Return only the passages relevant to this." })),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
			try {
				const { pages, notices, details } = await exaContents(
					defaultDeps,
					ctx.modelRegistry,
					params.urls,
					params.query?.trim() || undefined,
					signal,
				);
				return {
					content: [{ type: "text", text: formatPages(pages, notices) }],
					details,
					isError: pages.every((page) => page.error !== undefined),
				};
			} catch (error) {
				if (error instanceof WebError) return failed("Web fetch", error);
				throw error;
			}
		},
	});

	pi.registerCommand("web", {
		description: "Choose the web search provider (exa, openai) and OpenAI's search model, or show status",
		getArgumentCompletions: (prefix) =>
			[...SEARCH_PROVIDERS, "status"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "exa" || arg === "openai") {
				save(ctx, { provider: arg }, `Web search provider: ${NAMES[arg]}`);
			} else if (arg === "status" || (arg === "" && !ctx.hasUI)) {
				ctx.ui.notify(await statusText(ctx), "info");
			} else if (arg === "") {
				await choose(ctx);
			} else {
				ctx.ui.notify("Usage: /web [exa|openai|status]", "warning");
			}
		},
	});
}
