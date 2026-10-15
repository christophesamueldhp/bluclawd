/**
 * What the phone's status sheet shows of a pane (its model, the models it can switch to,
 * thinking level, context, session usage and trust mode), and the phone's actions run in the pane.
 */
import { existsSync } from "node:fs";
import { getSupportedThinkingLevels, type ModelThinkingLevel, type Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { PHONE_REFUSED_COMMANDS } from "../../daemon/ipc/protocol.ts";
import type { PaneCommand, PaneMessage, PaneReport } from "../../daemon/orchestrator-client.ts";
import { BUILTIN_SLASH_COMMANDS } from "../_shared/builtin-commands.ts";
import type { ProjectTrust } from "../_shared/trust-badge.ts";
import { projectTrust, setProjectTrust, TRUST_CYCLE } from "../permissions/index.ts";

type ReportModel = PaneReport["models"][number];

/** Bounds on what every report carries for the phone's autocomplete. */
const COMMANDS_MAX = 200;
const DESCRIPTION_MAX = 100;

/** The slash commands the pane's prompt runs, as its autocomplete lists them, but for the Mac-only ones. */
export function paneCommands(pi: Pick<ExtensionAPI, "getCommands">): PaneCommand[] {
	const commands: PaneCommand[] = [
		...BUILTIN_SLASH_COMMANDS.map(({ name, description }) => ({ name, description, source: "builtin" as const })),
		...pi.getCommands().map(({ name, description, source }) => ({ name, description, source })),
	];
	return commands
		.filter((command) => !PHONE_REFUSED_COMMANDS.has(command.name))
		.slice(0, COMMANDS_MAX)
		.map(({ name, description, source }) => {
			const text = description?.trim();
			if (!text) return { name, source };
			return {
				name,
				description: text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1)}…` : text,
				source,
			};
		});
}

function reportModel(model: { provider: string; id: string; name?: string }): ReportModel {
	return { provider: model.provider, id: model.id, ...(model.name ? { name: model.name } : {}) };
}

export function buildReport(
	ctx: ExtensionContext,
	pi: Pick<ExtensionAPI, "getThinkingLevel" | "getCommands">,
	trustOf: (ctx: ExtensionContext) => ProjectTrust = projectTrust,
): PaneReport {
	const current = ctx.model;
	const models = new Map<string, ReportModel>();
	// What pi's /model offers: the scoped models (`enabledModels`, `--models`) when there are any,
	// else every available one. The current model too, so the picker can show it selected.
	const scoped = (ctx.scopedModels ?? []).map((scopedModel) => scopedModel.model);
	const offered = scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
	for (const model of [...(current ? [current] : []), ...offered]) {
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
		commands: paneCommands(pi),
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

/** Why a fork, clone or slash command did not happen, for the phone to say. */
export const DRAFT_NOTICE = "Clear the unsent text in the session's prompt on the Mac and retry";
export const BUSY_NOTICE = "The session is busy: send the command once it is idle";
export const DIALOG_NOTICE = "A dialog is open in the session on the Mac: answer or close it, then retry";

/**
 * A phone's slash command, run as if typed in the pane's prompt on the Mac: the text goes into the
 * prompt and `enter` presses Enter there, so pi's own handling runs it, its built-in commands too
 * (/compact, /model, …; one that opens a selector waits there for the phone's Answer). Setting the
 * text, unlike typing it, opens no autocomplete that Enter would pick from. Only into an idle,
 * empty prompt that has the keyboard: anything else would send or lose what is there, or press
 * Enter in a dialog. `refuse` tells the phone why it did not run.
 */
export function submitCommand(
	text: string,
	ctx: ExtensionContext,
	tui: TUI | undefined,
	enter: () => void,
	refuse: (notice: string) => void,
): void {
	// getFocusedComponent is on pi-tui's TUI class, not its TUI interface; only the prompt has getText.
	const focused = (tui as { getFocusedComponent?: () => unknown } | undefined)?.getFocusedComponent?.();
	const prompt = typeof (focused as { getText?: unknown } | null)?.getText === "function";
	if (!ctx.isIdle()) refuse(BUSY_NOTICE);
	else if (!tui || tui.hasOverlay() || !prompt) refuse(DIALOG_NOTICE);
	else if (ctx.ui.getEditorText().trim()) refuse(DRAFT_NOTICE);
	else {
		ctx.ui.setEditorText(text);
		try {
			enter();
		} catch {
			// tmux is gone or hung: nothing was sent.
			ctx.ui.setEditorText("");
			refuse("The session's prompt on the Mac could not be reached: retry");
		}
	}
}

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
