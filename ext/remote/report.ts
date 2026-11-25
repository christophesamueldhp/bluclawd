import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { getSupportedThinkingLevels, type ModelThinkingLevel, type Usage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
	type PaneCommand,
	type PaneMessage,
	type PaneReport,
	type PaneTask,
	phoneMayRun,
	type RefusedReason,
} from "../../daemon/ipc/protocol.ts";
import { subscribeAgentTasks } from "../_shared/agent-tasks.ts";
import { BUILTIN_SLASH_COMMANDS } from "../_shared/builtin-commands.ts";
import { focusedComponent, isPromptEditor } from "../_shared/focus.ts";
import { pistatuslineEnabled } from "../_shared/pistatusline.ts";
import type { ProjectTrust } from "../_shared/trust-badge.ts";
import { backgroundBashJobs } from "../background-bash/background-bash.ts";
import {
	FOREGROUND_TASK_AFTER_MS,
	runningForegroundShells,
	subscribeForegroundShells,
} from "../background-bash/foreground-shells.ts";
import { stopTask, type TaskRow, visibleRows } from "../background-bash/tasks-dialog.ts";
import { projectTrust, setProjectTrust, TRUST_CYCLE } from "../permissions/index.ts";
import { skillId } from "../skills/prompt.ts";
import { readRunUsageLedger } from "../subagents/storage.ts";

type ReportModel = PaneReport["models"][number];

const COMMANDS_MAX = 200;
const DESCRIPTION_MAX = 100;
const TASKS_MAX = 20;
const TASK_LABEL_MAX = 200;
const TASKS_SETTLE_MS = 250;

const capped = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function pistatuslinePaths(
	pi: Pick<ExtensionAPI, "getCommands">,
	agentDir: string = getAgentDir(),
): PaneReport["pistatusline"] {
	const extension = pi.getCommands().find((c) => c.name === "pistatusline" && c.source === "extension")
		?.sourceInfo?.path;
	if (!extension || !isAbsolute(extension)) return undefined;
	const worker = join(dirname(extension), "render-worker.js");
	const dir = join(agentDir, "pistatusline");
	return pistatuslineEnabled(agentDir) && existsSync(worker)
		? { worker, config: join(dir, "settings.json") }
		: undefined;
}

const isPhoneTaskRow = (row: TaskRow): row is TaskRow & { kind: PaneTask["kind"] } => row.kind !== "wakeup";

export function paneTasks(owner: string | undefined): PaneTask[] {
	return visibleRows(owner)
		.filter(isPhoneTaskRow)
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

export function paneCommands(pi: Pick<ExtensionAPI, "getCommands">): PaneCommand[] {
	const commands: PaneCommand[] = [
		...BUILTIN_SLASH_COMMANDS.map(({ name, description }) => ({ name, description, source: "builtin" as const })),
		...pi.getCommands().map((command) => ({
			name: command.name,
			description: command.description,
			source: command.source,
			...(command.source === "skill" && command.sourceInfo
				? { skill: { id: skillId(command), ...command.sourceInfo } }
				: {}),
		})),
	];
	return commands
		.filter(phoneMayRun)
		.slice(0, COMMANDS_MAX)
		.map(({ name, description, source, skill }) => {
			const text = description?.trim();
			return {
				name,
				source,
				...(text ? { description: capped(text, DESCRIPTION_MAX) } : {}),
				...(skill ? { skill } : {}),
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
	// else every available one.
	const scoped = (ctx.scopedModels ?? []).map((scopedModel) => scopedModel.model);
	const offered = scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable();
	for (const model of [...(current ? [current] : []), ...offered]) {
		models.set(`${model.provider}/${model.id}`, reportModel(model));
	}
	// As pi's footer totals them, since its addUsageToTotals is not exported.
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
	const runLedger = readRunUsageLedger(getAgentDir(), sessionId);
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
		...(runLedger.runCount > 0
			? {
					subagentUsage: {
						runCount: runLedger.runCount,
						input: runLedger.usage.input,
						output: runLedger.usage.output,
						cacheRead: runLedger.usage.cacheRead,
						cacheWrite: runLedger.usage.cacheWrite,
						cost: runLedger.usage.hasUnknownCost ? null : runLedger.usage.cost.total,
					},
				}
			: {}),
		trust: trustOf(ctx),
		commands: paneCommands(pi),
		tasks: paneTasks(sessionId),
	};
}

export function applyPaneMessage(
	message: PaneMessage,
	ctx: ExtensionContext,
	pi: Pick<ExtensionAPI, "setModel" | "getThinkingLevel" | "setThinkingLevel" | "events">,
	reportBecausePiWillNot: () => void = () => {},
): void {
	if (message.type === "set_model") {
		const model = ctx.modelRegistry.find(message.provider, message.id);
		if (model) pi.setModel(model).catch(() => {});
	} else if (message.type === "set_thinking") {
		const level = message.level as ModelThinkingLevel;
		const offered = ctx.model?.reasoning === true && getSupportedThinkingLevels(ctx.model).includes(level);
		if (offered && level !== pi.getThinkingLevel()) pi.setThinkingLevel(level);
		else reportBecausePiWillNot();
	} else if (message.type === "stop_task") {
		const owner = ctx.sessionManager.getSessionId();
		const row = visibleRows(owner).find((r) => r.id === message.id);
		if (row) stopTask(row, owner, "remote");
		else reportBecausePiWillNot();
	} else if (message.type === "set_trust") {
		if (TRUST_CYCLE.includes(message.trust)) setProjectTrust(pi, ctx, message.trust).catch(reportBecausePiWillNot);
	}
}

export const DRAFT_NOTICE = "Clear the unsent text in the session's prompt on the Mac and retry";
export const BUSY_NOTICE = "The session is busy: send the command once it is idle";
export const DIALOG_NOTICE = "A dialog is open in the session on the Mac: answer or close it, then retry";
export const UNREACHABLE_NOTICE = "The session's prompt on the Mac could not be reached: retry";
const COMMAND_NOTICES: Record<CommandRefusal, string> = {
	busy: BUSY_NOTICE,
	dialog: DIALOG_NOTICE,
	draft: DRAFT_NOTICE,
	unreachable: UNREACHABLE_NOTICE,
};

export type CommandRefusal = Extract<RefusedReason, "busy" | "dialog" | "draft" | "unreachable">;

export function legacyCommandNotice(reason: CommandRefusal): string {
	return COMMAND_NOTICES[reason];
}

export function submitCommand(
	text: string,
	ctx: ExtensionContext,
	tui: TUI | undefined,
	enter: () => void,
): CommandRefusal | undefined {
	const prompt = isPromptEditor(focusedComponent(tui));
	if (!ctx.isIdle()) return "busy";
	if (!tui || tui.hasOverlay() || !prompt) return "dialog";
	if (ctx.ui.getEditorText().trim()) return "draft";
	ctx.ui.setEditorText(text);
	try {
		enter();
	} catch {
		ctx.ui.setEditorText("");
		return "unreachable";
	}
	return undefined;
}
