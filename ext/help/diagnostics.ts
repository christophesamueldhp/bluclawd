import { getCurrentTools } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { commandBlock } from "../_shared/command-block.ts";
import { readRunUsageLedger } from "../subagents/storage.ts";
import { isUsingSubscription, subagentUsageSummary } from "./session-usage.ts";

export interface StatusData {
	piVersion: string;
	model?: string;
	modelName?: string;
	thinkingLevel?: string;
	authSource?: string;
	subscription: boolean;
	defaultProjectTrust: string;
	projectTrusted: boolean;
	cwd: string;
	subagents?: string;
}

export function formatStatus(
	data: StatusData,
	theme: { bold(s: string): string; fg(color: "dim", s: string): string },
): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const lines: string[] = [theme.bold("Status")];
	lines.push(`${dim("pi:")} v${data.piVersion} ${dim("· bluclawd package")}`);
	lines.push("", theme.bold("Model"));
	lines.push(`${dim("Model:")} ${data.model ?? "none selected"}${data.modelName ? dim(` (${data.modelName})`) : ""}`);
	lines.push(`${dim("Effort:")} ${data.thinkingLevel ?? "off"} ${dim("(/thinking)")}`);
	const auth = data.authSource ?? "not configured";
	const billing = data.model ? dim(data.subscription ? " · subscription" : " · per token") : "";
	lines.push(`${dim("Auth:")} ${auth}${billing}`);
	lines.push("", theme.bold("Project"));
	lines.push(`${dim("Working directory:")} ${data.cwd}`);
	lines.push(`${dim("Project trust:")} ${data.projectTrusted ? "trusted" : "not trusted"} ${dim("(/trust)")}`);
	lines.push(`${dim("Trust default:")} ${data.defaultProjectTrust} ${dim("(alt+m)")}`);
	if (data.subagents) lines.push("", theme.bold("Subagents"), data.subagents);
	lines.push("", dim("Session file, messages, tokens and cost: /session · context window usage: /context"));
	return lines;
}

const BAR_WIDTH = 20;
const CHARS_PER_TOKEN_ESTIMATE = 4;

export interface ContextData {
	model?: string;
	contextWindow?: number;
	tokens?: number | null;
	percent?: number | null;
	systemPromptChars?: number;
	toolDefinitionChars?: number;
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

interface ToolDefinitionText {
	name: string;
	description: string;
	parameters: unknown;
}

export function toolChars(tool: ToolDefinitionText): number {
	return tool.name.length + tool.description.length + JSON.stringify(tool.parameters).length;
}

export function toolDefinitionChars(tools: readonly ToolDefinitionText[]): number {
	return tools.reduce((sum, tool) => sum + toolChars(tool), 0);
}

export function formatContext(
	data: ContextData | undefined,
	theme: { bold(s: string): string; fg(color: "dim", s: string): string },
): string[] {
	const lines: string[] = [theme.bold("Context")];

	if (!data?.model || data.contextWindow === undefined) {
		lines.push("Context usage is unknown (no model selected or the model has no context window).");
		return lines;
	}

	lines.push(`${theme.fg("dim", "Window:")} ${formatTokens(data.contextWindow)}`);

	if (data.tokens === null || data.tokens === undefined || data.percent === null || data.percent === undefined) {
		lines.push(`${theme.fg("dim", "In context:")} unknown until the next assistant response`);
		return lines;
	}

	const filled = Math.min(BAR_WIDTH, Math.max(0, Math.round((data.percent / 100) * BAR_WIDTH)));
	const bar = `[${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}]`;
	lines.push(`${theme.fg("dim", "In context:")} ${formatTokens(data.tokens)} (${data.percent.toFixed(1)}%) ${bar}`);

	const systemPromptEstimate = Math.round((data.systemPromptChars ?? 0) / CHARS_PER_TOKEN_ESTIMATE);
	const toolDefinitionsEstimate = Math.round((data.toolDefinitionChars ?? 0) / CHARS_PER_TOKEN_ESTIMATE);
	lines.push(
		`  ${theme.fg("dim", "System prompt incl. project context & skills (est.):")} ~${formatTokens(systemPromptEstimate)}`,
	);
	if (data.toolDefinitionChars !== undefined) {
		lines.push(`  ${theme.fg("dim", "Tool definitions (est.):")} ~${formatTokens(toolDefinitionsEstimate)}`);
	}
	lines.push(
		`  ${theme.fg("dim", "Messages & tool results (est.):")} ~${formatTokens(Math.max(data.tokens - systemPromptEstimate - toolDefinitionsEstimate, 0))}`,
	);
	lines.push(
		`${theme.fg("dim", "Free:")} ${formatTokens(Math.max(data.contextWindow - data.tokens, 0))} (${(100 - data.percent).toFixed(1)}%)`,
	);
	return lines;
}

export function registerDiagnostics(pi: ExtensionAPI): void {
	let lastRequestToolChars: number | undefined;
	pi.on("context_with_system", (event) => {
		lastRequestToolChars = toolDefinitionChars(getCurrentTools(event.messages));
	});

	pi.registerEntryRenderer<ContextData>("bluclawd:context", (entry, _options, theme) =>
		commandBlock(formatContext(entry.data, theme)),
	);

	pi.registerEntryRenderer<StatusData>("bluclawd:status", (entry, _options, theme) =>
		commandBlock(entry.data ? formatStatus(entry.data, theme) : []),
	);

	pi.registerCommand("status", {
		description: "Show model, auth, and project trust",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			let authSource: string | undefined;
			if (model) {
				try {
					const status = ctx.modelRegistry.getProviderAuthStatus(model.provider);
					authSource = status.configured ? (status.label ?? status.source ?? "configured") : undefined;
				} catch {
					authSource = undefined;
				}
			}
			pi.appendEntry<StatusData>("bluclawd:status", {
				piVersion: VERSION,
				model: model ? `${model.provider}/${model.id}` : undefined,
				modelName: model?.name,
				thinkingLevel: model?.reasoning ? ctx.thinkingLevel : undefined,
				authSource,
				subscription: isUsingSubscription(ctx),
				defaultProjectTrust: SettingsManager.create(ctx.cwd, undefined, {
					projectTrusted: ctx.isProjectTrusted(),
				}).getDefaultProjectTrust(),
				projectTrusted: ctx.isProjectTrusted(),
				cwd: ctx.cwd,
				subagents: subagentUsageSummary(readRunUsageLedger(getAgentDir(), ctx.sessionManager.getSessionId())),
			});
		},
	});

	pi.registerCommand("context", {
		description: "Show context window usage",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			const usage = ctx.getContextUsage();
			const active = new Set(pi.getActiveTools());
			const toolCharsBeforeFirstRequest = () =>
				toolDefinitionChars(pi.getAllTools().filter((tool) => active.has(tool.name)));
			pi.appendEntry<ContextData>("bluclawd:context", {
				model: model ? `${model.provider}/${model.id}` : undefined,
				contextWindow: usage?.contextWindow,
				tokens: usage?.tokens,
				percent: usage?.percent,
				systemPromptChars: ctx.getSystemPrompt().length,
				toolDefinitionChars: lastRequestToolChars ?? toolCharsBeforeFirstRequest(),
			});
		},
	});
}
