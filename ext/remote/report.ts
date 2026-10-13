/**
 * What the phone's status sheet shows of a pane (its model, the models it can switch to,
 * thinking level, context and session usage), and the phone's actions run in the pane.
 */
import { existsSync } from "node:fs";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

/** The pane messages agent view hands to remote control; an unknown model is ignored, and so are
 *  compact, tree, fork and clone unless the session is idle, since they would cut a turn short.
 *  Tree, fork and clone need a command's context, so they run as `/remote-control`, which pi
 *  executes without writing anything to the session. */
export function applyPaneMessage(
	message: PaneMessage,
	ctx: ExtensionContext,
	pi: Pick<ExtensionAPI, "setModel" | "sendUserMessage" | "getCommands">,
): void {
	if (message.type === "set_model") {
		const model = ctx.modelRegistry.find(message.provider, message.id);
		if (model) pi.setModel(model).catch(() => {});
	} else if (!ctx.isIdle()) return;
	else if (message.type === "compact") ctx.compact();
	else if (message.type === "tree" || message.type === "fork" || message.type === "clone") {
		// Another extension's command of the same name renames both (remote-control:1, :2), and the
		// line would then reach the model as a prompt.
		if (!pi.getCommands().some((c) => c.name === "remote-control" && c.source === "extension")) return;
		const args = message.type === "clone" ? "clone" : `${message.type} ${message.entryId}`;
		pi.sendUserMessage(`/remote-control ${args}`, { expandPromptTemplates: true });
	}
}

/**
 * `/remote-control tree <entryId>`, `fork <entryId>` and `clone`, as the phone dispatches them;
 * false for anything else. An entry pi would refuse is skipped here, since a fork that throws
 * ends the pane's pi.
 */
export async function navigate(args: string, ctx: ExtensionCommandContext): Promise<boolean> {
	const words = args.trim().split(/\s+/);
	const [sub, entryId = ""] = words;
	if (words.length !== (sub === "clone" ? 1 : sub === "tree" || sub === "fork" ? 2 : 0)) return false;
	const sessions = ctx.sessionManager;
	if (sub === "tree") {
		if (sessions.getEntry(entryId)) await ctx.navigateTree(entryId);
		return true;
	}
	const file = sessions.getSessionFile();
	if (file && !existsSync(file)) return true;
	if (sub === "clone") {
		const leaf = sessions.getLeafId();
		if (leaf) await ctx.fork(leaf, { position: "at" });
		return true;
	}
	const entry = sessions.getEntry(entryId);
	if (entry?.type === "message" && entry.message.role === "user") {
		await ctx.fork(entryId, { position: "before" });
	}
	return true;
}
