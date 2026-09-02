/**
 * `/context` — the one diagnostic that needs nothing from pi beyond its
 * public extension context.
 *
 * `/status` and `/usage` are NOT here. `/status` on the fork branch was pi's own
 * session summary plus a model-and-behaviour block, and pi keeps that summary
 * private behind `/session`; reproducing it in fork code would be drift to
 * re-sync forever, and shipping only half of it under the same name would be
 * worse than not shipping it. Use `/session` for the session half and `/context`
 * for the window. `/usage` needs a provider-usage poller that only pays off with
 * live credentials — deferred rather than half-ported.
 *
 * Output goes through `appendEntry` + `registerEntryRenderer`; see the commands
 * extension for why not `ctx.ui.notify`.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

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
