/**
 * What the phone's status sheet shows of a pane (its model, the models it can switch to,
 * thinking level, context, session usage and trust mode), and the phone's actions run in the pane.
 */
import { existsSync } from "node:fs";
import { getSupportedThinkingLevels, type ModelThinkingLevel, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PaneMessage, PaneReport } from "../../daemon/orchestrator-client.ts";
import type { ProjectTrust } from "../_shared/trust-badge.ts";
import { projectTrust, setProjectTrust, TRUST_CYCLE } from "../permissions/index.ts";

type ReportModel = PaneReport["models"][number];

function reportModel(model: { provider: string; id: string; name?: string }): ReportModel {
	return { provider: model.provider, id: model.id, ...(model.name ? { name: model.name } : {}) };
}

export function buildReport(
	ctx: ExtensionContext,
	pi: Pick<ExtensionAPI, "getThinkingLevel">,
	trustOf: (ctx: ExtensionContext) => ProjectTrust = projectTrust,
): PaneReport {
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
		...(current?.reasoning
			? { thinkingLevel: pi.getThinkingLevel(), thinkingLevels: getSupportedThinkingLevels(current) }
			: {}),
		...(context
			? { context: { tokens: context.tokens, contextWindow: context.contextWindow, percent: context.percent } }
			: {}),
		usage,
		trust: trustOf(ctx),
	};
}

/** The pane messages agent view hands to remote control; an unknown model is ignored, and so are
 *  compact, tree, fork and clone unless the session is idle, since they would cut a turn short.
 *  Tree, fork and clone need a command's context, so they run as `/remote-control`, which pi
 *  executes without writing anything to the session. The phone shows a compact until the pane
 *  reports again: `reportAgain` does when one is skipped or fails, which pi reports nothing for,
 *  and for a thinking level pi does not change to, so the phone's picker goes back. `dispatched`:
 *  the `/remote-control` arguments sent and not yet run, which the command runs only as these. */
export function applyPaneMessage(
	message: PaneMessage,
	ctx: ExtensionContext,
	pi: Pick<
		ExtensionAPI,
		"setModel" | "sendUserMessage" | "getCommands" | "getThinkingLevel" | "setThinkingLevel" | "events"
	>,
	reportAgain: () => void = () => {},
	dispatched: Set<string> = new Set(),
): void {
	if (message.type === "set_model") {
		const model = ctx.modelRegistry.find(message.provider, message.id);
		if (model) pi.setModel(model).catch(() => {});
	} else if (message.type === "set_thinking") {
		const level = message.level as ModelThinkingLevel;
		const offered = ctx.model?.reasoning === true && getSupportedThinkingLevels(ctx.model).includes(level);
		if (offered && level !== pi.getThinkingLevel()) pi.setThinkingLevel(level);
		else reportAgain();
	} else if (message.type === "set_trust") {
		// Reported again on TRUST_CHANGED, as Alt+M's is.
		if (TRUST_CYCLE.includes(message.trust)) setProjectTrust(pi, ctx, message.trust).catch(reportAgain);
	} else if (message.type === "compact") {
		if (ctx.isIdle()) ctx.compact({ onError: reportAgain });
		else reportAgain();
	} else if (!ctx.isIdle()) return;
	else if (message.type === "tree" || message.type === "fork" || message.type === "clone") {
		// Another extension's command of the same name renames both (remote-control:1, :2), and the
		// line would then reach the model as a prompt.
		if (!pi.getCommands().some((c) => c.name === "remote-control" && c.source === "extension")) return;
		const args = message.type === "clone" ? "clone" : `${message.type} ${message.entryId}`;
		dispatched.add(args);
		pi.sendUserMessage(`/remote-control ${args}`, { expandPromptTemplates: true });
	}
}

/** Why a fork or clone did not happen, for the phone to say. */
export const DRAFT_NOTICE = "Clear the unsent text in the session's prompt on the Mac and retry";

/**
 * `/remote-control tree <entryId>`, `fork <entryId>` and `clone`, as the phone dispatches them;
 * false for anything else. An entry pi would refuse is skipped here, since a fork that throws
 * ends the pane's pi; so is a fork or clone over a draft in the pane's editor, which pi replaces
 * with the forked message: `refuse` tells the phone why.
 */
export async function navigate(
	args: string,
	ctx: ExtensionCommandContext,
	refuse: (notice: string) => void = () => {},
): Promise<boolean> {
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
	if (ctx.ui.getEditorText().trim()) {
		refuse(DRAFT_NOTICE);
		return true;
	}
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
