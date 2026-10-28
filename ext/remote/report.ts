/**
 * What the phone's status sheet shows of a pane (its model, the models it can switch to,
 * thinking level, context, session usage, trust mode, slash commands and background tasks), and
 * the phone's actions run in the pane.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { getSupportedThinkingLevels, type ModelThinkingLevel, type Usage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { phoneMayRun } from "../../daemon/ipc/protocol.ts";
import type { PaneCommand, PaneMessage, PaneReport, PaneTask } from "../../daemon/orchestrator-client.ts";
import { subscribeAgentTasks } from "../_shared/agent-tasks.ts";
import { BUILTIN_SLASH_COMMANDS } from "../_shared/builtin-commands.ts";
import type { ProjectTrust } from "../_shared/trust-badge.ts";
import { backgroundBashJobs } from "../background-bash/background-bash.ts";
import {
	FOREGROUND_TASK_AFTER_MS,
	runningForegroundShells,
	subscribeForegroundShells,
} from "../background-bash/foreground-shells.ts";
import { stopTask, visibleRows } from "../background-bash/tasks-dialog.ts";
import { projectTrust, setProjectTrust, TRUST_CYCLE } from "../permissions/index.ts";
import { readBackgroundUsageLedger } from "../subagents/storage.ts";

type ReportModel = PaneReport["models"][number];

/** Bounds on what every report carries for the phone's autocomplete and task list. */
const COMMANDS_MAX = 200;
const DESCRIPTION_MAX = 100;
const TASKS_MAX = 20;
const TASK_LABEL_MAX = 200;
/** Task changes this close together make one report. */
const TASKS_SETTLE_MS = 250;

const capped = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Where pistatusline is, when it draws this pi's footer: its render worker beside its extension
 * (the file its /pistatusline command comes from) and its settings, for the daemon to render its
 * lines for the phone. Undefined without it, or with it turned off.
 */
export function pistatuslinePaths(
	pi: Pick<ExtensionAPI, "getCommands">,
	agentDir: string = getAgentDir(),
): PaneReport["pistatusline"] {
	const extension = pi.getCommands().find((c) => c.name === "pistatusline" && c.source === "extension")
		?.sourceInfo?.path;
	if (!extension || !isAbsolute(extension)) return undefined;
	const worker = join(dirname(extension), "render-worker.js");
	const dir = join(agentDir, "pistatusline");
	let enabled = true;
	try {
		enabled = (JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { enabled?: unknown }).enabled !== false;
	} catch {
		// no state yet: on, as pistatusline starts
	}
	return enabled && existsSync(worker) ? { worker, config: join(dir, "settings.json") } : undefined;
}

/** The session's running background tasks, as /tasks lists them. */
export function paneTasks(owner: string | undefined): PaneTask[] {
	return visibleRows(owner)
		.slice(0, TASKS_MAX)
		.map((row) => {
			const outputFile = row.job?.outputFile ?? row.outputFile;
			return {
				id: row.id,
				kind: row.kind,
				label: capped(row.label, TASK_LABEL_MAX),
				startedAt: row.startedAt,
				...(row.foreground ? { foreground: true } : {}),
				...(outputFile ? { outputFile } : {}),
				...(row.kind === "agent" && row.statusText && row.statusText !== "running"
					? { status: row.statusText }
					: {}),
				...(row.kind === "agent" && row.model ? { model: row.model } : {}),
			};
		});
}

/**
 * Calls `check` once the task list may have changed: a shell, monitor or subagent run started or
 * ended, or the model's foreground bash crossed the 2s that make it a task. Events only, no polling.
 * Returns the unsubscribe.
 */
export function watchTasks(check: () => void): () => void {
	let soon: ReturnType<typeof setTimeout> | undefined;
	let due: ReturnType<typeof setTimeout> | undefined;
	const later = () => {
		clearTimeout(soon);
		soon = setTimeout(check, TASKS_SETTLE_MS);
		soon.unref?.();
	};
	const foreground = () => {
		later();
		clearTimeout(due);
		const now = Date.now();
		const young = runningForegroundShells().filter((shell) => now - shell.startedAt < FOREGROUND_TASK_AFTER_MS);
		if (young.length === 0) return;
		due = setTimeout(check, Math.min(...young.map((shell) => shell.startedAt)) + FOREGROUND_TASK_AFTER_MS - now);
		due.unref?.();
	};
	const offs = [
		backgroundBashJobs.subscribe(later),
		subscribeAgentTasks(later),
		subscribeForegroundShells(foreground),
	];
	return () => {
		for (const off of offs) off();
		clearTimeout(soon);
		clearTimeout(due);
	};
}

/** The slash commands the pane's prompt runs that a phone may run (phoneMayRun), in its autocomplete's order. */
export function paneCommands(pi: Pick<ExtensionAPI, "getCommands">): PaneCommand[] {
	const commands: PaneCommand[] = [
		...BUILTIN_SLASH_COMMANDS.map(({ name, description }) => ({ name, description, source: "builtin" as const })),
		...pi.getCommands().map(({ name, description, source }) => ({ name, description, source })),
	];
	return commands
		.filter(phoneMayRun)
		.slice(0, COMMANDS_MAX)
		.map(({ name, description, source }) => {
			const text = description?.trim();
			return text ? { name, description: capped(text, DESCRIPTION_MAX), source } : { name, source };
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
	const sessionId = ctx.sessionManager.getSessionId();
	const bgLedger = readBackgroundUsageLedger(getAgentDir(), sessionId);
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
		...(bgLedger.runCount > 0
			? {
					backgroundSubagentUsage: {
						runCount: bgLedger.runCount,
						input: bgLedger.usage.input,
						output: bgLedger.usage.output,
						cacheRead: bgLedger.usage.cacheRead,
						cacheWrite: bgLedger.usage.cacheWrite,
						cost: bgLedger.usage.hasUnknownCost ? null : bgLedger.usage.cost.total,
					},
				}
			: {}),
		trust: trustOf(ctx),
		commands: paneCommands(pi),
		tasks: paneTasks(sessionId),
	};
}

/** The pane messages agent view hands to remote control; an unknown model is ignored.
 *  `reportAgain` reports when pi reports nothing for what the phone asked, as for a thinking level
 *  pi does not change to or a task already gone, so the phone's picker or list goes back. */
export function applyPaneMessage(
	message: PaneMessage,
	ctx: ExtensionContext,
	pi: Pick<ExtensionAPI, "setModel" | "getThinkingLevel" | "setThinkingLevel" | "events">,
	reportAgain: () => void = () => {},
): void {
	if (message.type === "set_model") {
		const model = ctx.modelRegistry.find(message.provider, message.id);
		if (model) pi.setModel(model).catch(() => {});
	} else if (message.type === "set_thinking") {
		const level = message.level as ModelThinkingLevel;
		const offered = ctx.model?.reasoning === true && getSupportedThinkingLevels(ctx.model).includes(level);
		if (offered && level !== pi.getThinkingLevel()) pi.setThinkingLevel(level);
		else reportAgain();
	} else if (message.type === "stop_task") {
		// As /tasks' `x`, whether a turn runs or not; the task list's change reports it.
		const owner = ctx.sessionManager.getSessionId();
		const row = visibleRows(owner).find((r) => r.id === message.id);
		if (row) stopTask(row, owner, "remote");
		else reportAgain();
	} else if (message.type === "set_trust") {
		// Reported again on TRUST_CHANGED, as Alt+M's is.
		if (TRUST_CYCLE.includes(message.trust)) setProjectTrust(pi, ctx, message.trust).catch(reportAgain);
	}
}

/** Why a slash command did not happen, for the phone to say. */
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
