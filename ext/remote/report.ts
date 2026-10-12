/**
 * What the phone's status sheet shows of a pane (its model, the models it can switch to,
 * thinking level, context and session usage), and the sheet's actions run in the pane.
 */
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
	const usage = { input: 0, output: 0, cost: 0 };
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		usage.input += entry.message.usage.input;
		usage.output += entry.message.usage.output;
		usage.cost += entry.message.usage.cost.total;
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

/** The pane messages agent view hands to remote control; an unknown model is ignored. */
export function applyPaneMessage(
	message: PaneMessage,
	ctx: ExtensionContext,
	pi: Pick<ExtensionAPI, "setModel">,
): void {
	if (message.type === "set_model") {
		const model = ctx.modelRegistry.find(message.provider, message.id);
		if (model) pi.setModel(model).catch(() => {});
	} else if (message.type === "compact") ctx.compact();
}
