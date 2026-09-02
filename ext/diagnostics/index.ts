/**
 * `/context` and `/status` — diagnostics built from the public extension
 * context alone.
 *
 * `/status` is bluclawd's half of Claude Code's status screen: model, effort,
 * auth, permission mode, sandbox, trust, session file. It deliberately does NOT
 * reproduce pi's own session summary (entry counts, tree, cost history) — pi
 * keeps that private behind `/session`, and re-implementing it here would be
 * drift to re-sync forever — so the report ends by pointing at `/session`.
 * Permission mode and sandbox state come from the other extensions' `sharedRef`
 * stores, which are safe to read across the `pi.extensions` module-graph
 * boundary (see `_shared/global-state.ts`).
 *
 * `/usage` is NOT here: it lives in `statusline`, next to the plan-usage
 * pollers it reports on.
 *
 * Output goes through `appendEntry` + `registerEntryRenderer` rather than
 * `ctx.ui.notify` (which dims everything and does not persist in the session).
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { getActivePermissionMode } from "../permissions/active-mode.ts";
import { isSandboxActive } from "../sandbox/state.ts";

/** Snapshot rendered by `/status`. Plain data so it survives in the session file. */
export interface StatusData {
	piVersion: string;
	model?: string;
	modelName?: string;
	thinkingLevel?: string;
	authSource?: string;
	subscription: boolean;
	permissionMode: string;
	sandbox: boolean;
	projectTrusted: boolean;
	cwd: string;
	sessionFile?: string;
	sessionName?: string;
	contextWindow?: number;
}

/** Exported pure for tests; `theme` is the only styling dependency. */
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
	lines.push(`${dim("Auth:")} ${auth}${data.subscription ? dim(" · subscription") : ""}`);
	if (data.contextWindow)
		lines.push(`${dim("Context window:")} ${formatTokens(data.contextWindow)} ${dim("(/context)")}`);
	lines.push("", theme.bold("Safety"));
	lines.push(`${dim("Permission mode:")} ${data.permissionMode} ${dim("(/mode)")}`);
	lines.push(`${dim("Sandbox:")} ${data.sandbox ? "on" : "off"} ${dim("(/sandbox)")}`);
	lines.push(`${dim("Project trust:")} ${data.projectTrusted ? "trusted" : "not trusted"} ${dim("(/trust)")}`);
	lines.push("", theme.bold("Session"));
	lines.push(`${dim("Working directory:")} ${data.cwd}`);
	if (data.sessionName) lines.push(`${dim("Name:")} ${data.sessionName}`);
	lines.push(`${dim("File:")} ${data.sessionFile ?? "not saved (ephemeral)"}`);
	lines.push(dim("Entry counts, tree, and history: /session"));
	return lines;
}

const BAR_WIDTH = 20;

interface ContextData {
	model?: string;
	contextWindow?: number;
	tokens?: number | null;
	percent?: number | null;
	systemPromptChars?: number;
}

function block(lines: string[]): Container {
	const container = new Container();
	container.addChild(new Spacer(1));
	container.addChild(new Text(lines.join("\n"), 1, 0));
	return container;
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return String(value);
}

const diagnostics: InlineExtension = {
	name: "diagnostics",
	factory: (pi) => {
		pi.registerEntryRenderer<ContextData>("bluclawd:context", (entry, _options, theme) => {
			const data = entry.data;
			const lines: string[] = [theme.bold("Context")];

			if (!data?.model || data.contextWindow === undefined) {
				lines.push("Context usage is unknown (no model selected or the model has no context window).");
				return block(lines);
			}

			lines.push(
				`${theme.fg("dim", "Model:")} ${data.model} ${theme.fg("dim", `(window ${formatTokens(data.contextWindow)})`)}`,
			);

			if (data.tokens === null || data.tokens === undefined || data.percent === null || data.percent === undefined) {
				lines.push(`${theme.fg("dim", "In context:")} unknown until the next assistant response`);
				return block(lines);
			}

			const filled = Math.min(BAR_WIDTH, Math.max(0, Math.round((data.percent / 100) * BAR_WIDTH)));
			const bar = `[${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}]`;
			lines.push(
				`${theme.fg("dim", "In context:")} ${formatTokens(data.tokens)} (${data.percent.toFixed(1)}%) ${bar}`,
			);

			// Four characters per token is the same rough estimate pi uses for its own
			// pre-response display; it is a breakdown hint, not an accounting figure.
			const systemPromptEstimate = Math.round((data.systemPromptChars ?? 0) / 4);
			lines.push(
				`  ${theme.fg("dim", "System prompt incl. project context & skills (est.):")} ~${formatTokens(systemPromptEstimate)}`,
			);
			lines.push(
				`  ${theme.fg("dim", "Messages & tool results (est.):")} ~${formatTokens(Math.max(data.tokens - systemPromptEstimate, 0))}`,
			);
			lines.push(
				`${theme.fg("dim", "Free:")} ${formatTokens(Math.max(data.contextWindow - data.tokens, 0))} (${(100 - data.percent).toFixed(1)}%)`,
			);
			return block(lines);
		});

		pi.registerEntryRenderer<StatusData>("bluclawd:status", (entry, _options, theme) =>
			block(entry.data ? formatStatus(entry.data, theme) : []),
		);

		pi.registerCommand("status", {
			description: "Show model, auth, permission mode, sandbox, and session info",
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
				let sessionFile: string | undefined;
				try {
					sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
				} catch {
					sessionFile = undefined;
				}
				pi.appendEntry<StatusData>("bluclawd:status", {
					piVersion: VERSION,
					model: model ? `${model.provider}/${model.id}` : undefined,
					modelName: model?.name,
					thinkingLevel: model?.reasoning ? ctx.thinkingLevel : undefined,
					authSource,
					subscription: model ? model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(model) : false,
					permissionMode: getActivePermissionMode(),
					sandbox: isSandboxActive(),
					projectTrusted: ctx.isProjectTrusted(),
					cwd: ctx.cwd,
					sessionFile,
					sessionName: ctx.sessionManager.getSessionName(),
					contextWindow: model?.contextWindow,
				});
			},
		});

		pi.registerCommand("context", {
			description: "Show context window usage",
			handler: async (_args, ctx) => {
				const model = ctx.model;
				const usage = ctx.getContextUsage();
				pi.appendEntry<ContextData>("bluclawd:context", {
					model: model ? `${model.provider}/${model.id}` : undefined,
					contextWindow: usage?.contextWindow,
					tokens: usage?.tokens,
					percent: usage?.percent,
					systemPromptChars: ctx.getSystemPrompt().length,
				});
			},
		});
	},
};

export default diagnostics.factory;
