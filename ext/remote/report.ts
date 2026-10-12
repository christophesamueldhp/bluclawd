/**
 * What the phone's status sheet shows of a pane (its model, the models it can switch to,
 * thinking level, context and session usage), and the sheet's actions run in the pane.
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PaneMessage, PaneReport } from "../agent-view/orchestrator-client.ts";

type ReportModel = PaneReport["models"][number];

function reportModel(model: { provider: string; id: string; name?: string }): ReportModel {
	return { provider: model.provider, id: model.id, ...(model.name ? { name: model.name } : {}) };
}

export function buildReport(ctx: ExtensionContext, pi: Pick<ExtensionAPI, "getThinkingLevel">): PaneReport {
	const current = ctx.model;
	const models = new Map<string, ReportModel>();
	// The current model too, so the picker can show it selected.
	for (const model of [...(current ? [current] : []), ...ctx.modelRegistry.getAvailable()]) {
		models.set(`${model.provider}/${model.id}`, reportModel(model));
	}
	// As pi's footer totals them (its addUsageToTotals is not exported).
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const entry of ctx.sessionManager.getEntries()) {
		let counted: Usage | undefined;
		if (entry.type === "usage") counted = entry.usage;
		else if (
			entry.type === "message" &&
			(entry.message.role === "assistant" || entry.message.role === "toolResult")
		) {
			counted = entry.message.usage;
		} else if (entry.type === "branch_summary" || entry.type === "compaction") counted = entry.usage;
		if (!counted) continue;
		usage.input += counted.input;
		usage.output += counted.output;
		usage.cacheRead += counted.cacheRead;
		usage.cacheWrite += counted.cacheWrite;
		usage.cost += counted.cost.total;
	}
	const context = ctx.getContextUsage();
	return {
		...(current ? { model: reportModel(current) } : {}),
		models: [...models.values()].sort(
			(a, b) => a.provider.localeCompare(b.provider) || (a.name ?? a.id).localeCompare(b.name ?? b.id),
		),
		...(current?.reasoning ? { thinkingLevel: pi.getThinkingLevel() } : {}),
		...(context
			? { context: { tokens: context.tokens, contextWindow: context.contextWindow, percent: context.percent } }
			: {}),
		usage,
	};
}

/** The pane messages agent view hands to remote control; an unknown model is ignored, and so is
 *  compact unless the session is idle, since pi's compact aborts a turn in progress. */
export function applyPaneMessage(
	message: PaneMessage,
	ctx: ExtensionContext,
	pi: Pick<ExtensionAPI, "setModel">,
): void {
	if (message.type === "set_model") {
		const model = ctx.modelRegistry.find(message.provider, message.id);
		if (model) pi.setModel(model).catch(() => {});
	} else if (message.type === "compact" && ctx.isIdle()) ctx.compact();
}
