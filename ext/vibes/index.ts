/**
 * Vibes extension: themed working messages. `/vibe star trek` turns "Working..."
 * into "Engaging warp drive..." while the agent runs.
 *
 * Off by default. In generate mode each prompt (and, at most every 30 seconds,
 * a tool call) asks a model for a 2-4 word message; the placeholder
 * "Channeling <theme>..." shows until the reply lands, and a slow or failed
 * reply just leaves it. The model is the session's own unless `/vibe model`
 * names another — provider-neutral, and nothing to configure. File mode cycles
 * vibes pre-generated with `/vibe generate`, with no calls at all.
 *
 * Settings live under `vibes` in the user's global settings.json.
 *
 * Adapted from pi-powerline-footer's working vibes (MIT, Nico Bailon).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { sessionHeaders } from "../_shared/session-headers.ts";
import * as forkSettings from "../_shared/settings.ts";
import { updateGlobalVibes } from "../_shared/settings-write.ts";
import {
	buildBatchPrompt,
	buildVibePrompt,
	cleanVibe,
	parseGenerateArgs,
	parseVibeBatch,
	pickVibe,
	VIBE_SYSTEM_PROMPT,
	vibeFileSlug,
} from "./vibes.ts";

const FALLBACK = "Working";
const MAX_LENGTH = 65;
const GENERATE_TIMEOUT_MS = 10_000;
const BATCH_TIMEOUT_MS = 30_000;
const REFRESH_INTERVAL_MS = 30_000;
const RECENT_LIMIT = 5;

const vibesDir = () => join(getAgentDir(), "bluclawd", "vibes");
const vibeFile = (theme: string) => join(vibesDir(), `${vibeFileSlug(theme)}.txt`);

function readVibeFile(theme: string): string[] {
	try {
		return readFileSync(vibeFile(theme), "utf8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.endsWith("...") && line !== "...");
	} catch {
		return [];
	}
}

/** `provider/model-id` → the registered model, if there is one. */
function findModel(ctx: ExtensionContext, spec: string): Model<Api> | undefined {
	const slash = spec.indexOf("/");
	return slash > 0 ? ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
}

/** The model vibes use: `vibes.model` when it resolves, else the session's. */
function vibeModel(ctx: ExtensionContext, spec: string | undefined): Model<Api> | undefined {
	return (spec ? findModel(ctx, spec) : undefined) ?? ctx.model;
}

/** One short completion; undefined on no model, no credentials, error, or abort. */
async function complete(
	ctx: ExtensionContext,
	model: Model<Api> | undefined,
	prompt: string,
	signal: AbortSignal,
	maxTokens: number,
): Promise<string | undefined> {
	if (!model) return undefined;
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return undefined;
		const response = await completeSimple(
			model,
			{
				systemPrompt: VIBE_SYSTEM_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: { ...sessionHeaders(model, ctx.sessionManager.getSessionId()), ...auth.headers },
				env: auth.env,
				signal,
				maxTokens,
			},
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") return undefined;
		return response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	} catch {
		return undefined;
	}
}

export function factory(pi: ExtensionAPI): void {
	let settings: forkSettings.VibesSettings = {};
	let streaming = false;
	let lastVibeAt = 0;
	let inFlight: AbortController | undefined;
	let recent: string[] = [];
	let fileVibes: { theme: string; list: string[]; seed: number; index: number } | undefined;

	const load = (ctx: ExtensionContext) => {
		settings = forkSettings.vibes(
			SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() }),
		);
	};

	function nextFileVibe(theme: string): string {
		if (fileVibes?.theme !== theme) fileVibes = { theme, list: readVibeFile(theme), seed: Date.now(), index: 0 };
		if (fileVibes.list.length === 0) return `${FALLBACK}...`;
		return pickVibe(fileVibes.list, fileVibes.index++, fileVibes.seed);
	}

	function refresh(ctx: ExtensionContext, task: string): void {
		const theme = settings.theme;
		if (!theme || !ctx.hasUI) return;
		lastVibeAt = Date.now();
		if (settings.mode === "file") {
			ctx.ui.setWorkingMessage(nextFileVibe(theme));
			return;
		}
		inFlight?.abort();
		const controller = new AbortController();
		inFlight = controller;
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(GENERATE_TIMEOUT_MS)]);
		// The token budget is room for a reasoning model to think before its four words
		// (40 tokens came back empty); the timeout covers that thinking too.
		void complete(ctx, vibeModel(ctx, settings.model), buildVibePrompt(theme, task, recent), signal, 1024).then(
			(reply) => {
				if (!reply || !streaming || controller.signal.aborted) return;
				const vibe = cleanVibe(reply, FALLBACK, MAX_LENGTH);
				if (vibe === `${FALLBACK}...`) return;
				recent = [vibe, ...recent.filter((entry) => entry !== vibe)].slice(0, RECENT_LIMIT);
				ctx.ui.setWorkingMessage(vibe);
			},
		);
	}

	pi.on("session_start", (_event, ctx) => {
		load(ctx);
		recent = [];
		fileVibes = undefined;
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!settings.theme || !ctx.hasUI) return;
		ctx.ui.setWorkingMessage(`Channeling ${settings.theme}...`);
		streaming = true;
		refresh(ctx, event.prompt);
	});

	pi.on("tool_call", (event, ctx) => {
		if (!settings.theme || !streaming || Date.now() - lastVibeAt < REFRESH_INTERVAL_MS) return;
		const input = event.input as { path?: unknown; command?: unknown };
		const hint =
			typeof input.path === "string"
				? `${event.toolName} ${input.path}`
				: typeof input.command === "string"
					? `running ${input.command.slice(0, 40)}`
					: `using the ${event.toolName} tool`;
		refresh(ctx, hint);
	});

	pi.on("agent_end", (_event, ctx) => {
		streaming = false;
		inFlight?.abort();
		inFlight = undefined;
		if (settings.theme && ctx.hasUI) ctx.ui.setWorkingMessage();
	});

	const save = async (ctx: ExtensionContext, changes: Partial<forkSettings.VibesSettings>, done: string) => {
		if (!(await updateGlobalVibes(changes))) {
			ctx.ui.notify("Could not save the vibe settings (settings.json is locked or unwritable).", "error");
			return;
		}
		load(ctx);
		ctx.ui.notify(done, "info");
	};

	pi.registerCommand("vibe", {
		description:
			"Themed working messages: /vibe <theme> | off | model [provider/id] | mode [generate|file] | generate <theme> [count]",
		handler: async (args, ctx) => {
			load(ctx);
			const words = args.trim().split(/\s+/).filter(Boolean);
			const [sub, ...rest] = words;

			if (!sub) {
				const model = vibeModel(ctx, settings.model);
				ctx.ui.notify(
					settings.theme
						? `Vibe: ${settings.theme} · mode ${settings.mode ?? "generate"} · model ${model ? `${model.provider}/${model.id}` : "none"}${settings.model ? "" : " (the session's)"}`
						: "Vibes are off. /vibe <theme> turns them on, e.g. /vibe star trek.",
					"info",
				);
				return;
			}

			switch (sub.toLowerCase()) {
				case "off":
					await save(ctx, { theme: undefined }, "Vibes off.");
					return;
				case "model": {
					const spec = rest.join(" ");
					if (!spec) {
						const model = vibeModel(ctx, settings.model);
						ctx.ui.notify(
							`Vibe model: ${model ? `${model.provider}/${model.id}` : "none"}${settings.model ? "" : " (the session's)"}`,
							"info",
						);
						return;
					}
					if (spec === "session") {
						await save(ctx, { model: undefined }, "Vibes use the session's model.");
						return;
					}
					if (!findModel(ctx, spec)) {
						ctx.ui.notify(`Unknown model "${spec}" — use provider/model-id, or "session".`, "error");
						return;
					}
					await save(ctx, { model: spec }, `Vibes use ${spec}.`);
					return;
				}
				case "mode": {
					const mode = rest[0]?.toLowerCase();
					if (mode !== "generate" && mode !== "file") {
						ctx.ui.notify(`Vibe mode: ${settings.mode ?? "generate"}. /vibe mode generate|file`, "info");
						return;
					}
					await save(ctx, { mode: mode === "generate" ? undefined : mode }, `Vibe mode: ${mode}.`);
					return;
				}
				case "generate": {
					const parsed = parseGenerateArgs(rest);
					if (!parsed) {
						ctx.ui.notify("Usage: /vibe generate <theme> [count]", "warning");
						return;
					}
					const model = vibeModel(ctx, settings.model);
					ctx.ui.notify(`Generating ${parsed.count} "${parsed.theme}" vibes…`, "info");
					const reply = await complete(
						ctx,
						model,
						buildBatchPrompt(parsed.theme, parsed.count),
						AbortSignal.timeout(BATCH_TIMEOUT_MS),
						8000,
					);
					const vibes = reply ? parseVibeBatch(reply) : [];
					if (vibes.length === 0) {
						ctx.ui.notify("No vibes came back — check the model with /vibe model.", "error");
						return;
					}
					mkdirSync(vibesDir(), { recursive: true });
					writeFileSync(vibeFile(parsed.theme), `${vibes.join("\n")}\n`);
					fileVibes = undefined;
					ctx.ui.notify(
						`Saved ${vibes.length} vibes to ${vibeFile(parsed.theme)}. /vibe mode file uses them.`,
						"info",
					);
					return;
				}
				default:
					await save(ctx, { theme: words.join(" ") }, `Vibe: ${words.join(" ")}.`);
			}
		},
	});
}

const vibesExtension: InlineExtension = { name: "vibes", factory };
export default vibesExtension.factory;
