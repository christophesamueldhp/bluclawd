import { shellLine } from "#remote-web/live.js";
import {
	type InstanceSummary,
	type PaneCommand,
	type PaneImage,
	type PaneMessage,
	type PaneReport,
	type PaneTask,
	type PromptOutcome,
	phoneMayRun,
} from "../ipc/protocol.ts";
import type { StatusSpan } from "./pistatusline.ts";
import {
	type ActionVerdict,
	type ChatAction,
	type ChatActions,
	chatActions,
	findSession,
	type ListedSession,
} from "./sessions.ts";
import type { GitInfo } from "./statusline.ts";

export type PhoneSession = ListedSession & {
	id: string;
	actions(): ChatActions;
	report?: PaneReport;
	outcomes?: PromptOutcome[];
};

export type PhoneAction =
	| { type: "prompt"; text: string; images?: PaneImage[]; skills?: string[]; id?: string }
	| { type: "abort" }
	| { type: "model"; provider: unknown; id: unknown }
	| { type: "thinking"; level: unknown }
	| { type: "trust"; trust: unknown }
	| { type: "rename"; name: unknown }
	| { type: "pin"; pinned: unknown }
	| { type: "delete" }
	| { type: "stop_task"; taskId: string }
	| { type: "task_output"; taskId: string }
	| { type: "image"; entryId: string; index: number }
	| { type: "message_output"; entryId: string }
	| { type: "status" }
	| { type: "commands" };

export type DaemonOperation = { type: "rename"; name: string } | { type: "pin"; pinned: boolean } | { type: "delete" };

export type Transcript = Pick<ListedSession, "sessionFile" | "leafId">;

export type TranscriptRead =
	| { type: "task_output"; file: string }
	| { type: "image"; transcript: Transcript; entryId: string; index: number }
	| { type: "message_output"; transcript: Transcript; entryId: string };

export type PhoneError =
	| "pi_not_open"
	| "session_not_running"
	| "session_silent"
	| "session_running"
	| "pane_too_old"
	| "session_busy"
	| "unsent_draft"
	| "command_refused"
	| "invalid_skills"
	| "invalid_model"
	| "invalid_thinking"
	| "invalid_trust"
	| "invalid_name"
	| "invalid_pinned"
	| "unknown_task"
	| "no_output"
	| "no_status";

export type PhoneOutcome =
	| { message: PaneMessage }
	| { operation: DaemonOperation }
	| { read: TranscriptRead }
	| { status: StatusView }
	| { commands: PaneCommand[] }
	| { error: PhoneError };

export type StatusTask = Omit<PaneTask, "outputFile"> & { output?: boolean };

export interface StatusView {
	model?: PaneReport["model"];
	models: PaneReport["models"];
	thinkingLevel?: string;
	thinkingLevels?: string[];
	trust?: PaneReport["trust"];
	context?: PaneReport["context"];
	usage?: PaneReport["usage"];
	subagentUsage?: PaneReport["subagentUsage"];
	notice?: PaneReport["notice"];
	outcomes?: PromptOutcome[];
	tasks?: StatusTask[];
	git?: GitInfo;
	statusline?: { lines: StatusSpan[][] };
}

const TRUST = ["always", "ask", "never"] as const;
const NAME_MAX = 100;
const TERMINAL_UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function phoneSession(
	deps: {
		listInstances(): InstanceSummary[];
		report(sessionId: string): PaneReport | undefined;
		outcomes?(sessionId: string): PromptOutcome[];
		terminalOpen(): boolean;
	},
	id: string,
): PhoneSession | undefined {
	const found = findSession(deps.listInstances(), id);
	if (!found) return undefined;
	const report = deps.report(id);
	const outcomes = deps.outcomes?.(id);
	return {
		...found,
		id,
		actions: () => chatActions(found.verdict, deps.terminalOpen()),
		...(report ? { report } : {}),
		...(outcomes ? { outcomes } : {}),
	};
}

export function commandName(text: string): string | undefined {
	return /^\/([\w.:-]+)(?:\s|$)/.exec(text.trimStart())?.[1];
}

export const REFUSED: Record<Extract<ActionVerdict, { act: false }>["reason"], PhoneError> = {
	no_terminal: "pi_not_open",
	silent: "session_silent",
	starting: "session_not_running",
	not_running: "session_not_running",
	running: "session_running",
};

function refusal(session: PhoneSession, kind: ChatAction): PhoneOutcome | undefined {
	const verdict = session.actions()[kind];
	return verdict.act ? undefined : { error: REFUSED[verdict.reason] };
}

function hasPane({ verdict }: PhoneSession): boolean {
	return verdict.act || verdict.reason === "silent";
}

function toPane(session: PhoneSession, message: PaneMessage): PhoneOutcome {
	return refusal(session, "message") ?? { message };
}

export function paneReportsOutcomes(report: PaneReport | undefined): boolean {
	return Array.isArray(report?.outcomes);
}

function paneTooOld(session: PhoneSession, action: PhoneAction): boolean {
	const setting = action.type === "model" || action.type === "thinking" || action.type === "trust";
	return setting && session.verdict.act && !session.report;
}

function typedIntoPrompt(
	name: string | undefined,
	images: PaneImage[] | undefined,
	skills: string[] | undefined,
	listed: PaneCommand | undefined,
): boolean {
	if (name === undefined || images || name.startsWith("skill:")) return false;
	return !(skills?.length && listed?.source === "prompt");
}

export function decide(session: PhoneSession, action: PhoneAction): PhoneOutcome {
	const { report } = session;
	if (paneTooOld(session, action)) return { error: "pane_too_old" };
	switch (action.type) {
		case "prompt": {
			const { text, images, id, skills } = action;
			if (skills?.some((id) => !report?.commands?.some((c) => c.source === "skill" && c.skill?.id === id)))
				return { error: "invalid_skills" };
			const sent = id ? { id, ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}) } : {};
			const name = commandName(text);
			const listed = report?.commands?.find((c) => c.name === name);
			const shell = !images && shellLine(text);
			if (!typedIntoPrompt(name, images, skills, listed) && !shell)
				return toPane(session, {
					type: "prompt",
					text,
					...(images ? { images } : {}),
					...(skills ? { skills } : {}),
					...sent,
				});

			if (!shell && (!listed || !phoneMayRun(listed))) return { error: "command_refused" };
			if (!paneReportsOutcomes(report)) {
				if (session.busy) return { error: "session_busy" };
				if (session.draft) return { error: "unsent_draft" };
			}
			return toPane(session, { type: "command", text, ...sent });
		}
		case "abort":
			return toPane(session, { type: "abort" });
		case "model": {
			const { provider, id } = action;
			if (typeof provider !== "string" || typeof id !== "string" || !provider || !id)
				return { error: "invalid_model" };
			const refused = refusal(session, "settings");
			if (refused) return refused;
			if (!report?.models.some((m) => m.provider === provider && m.id === id)) return { error: "invalid_model" };
			return { message: { type: "set_model", provider, id } };
		}
		case "thinking": {
			const refused = refusal(session, "settings");
			if (refused) return refused;
			const { level } = action;
			if (typeof level !== "string" || !report?.thinkingLevels?.includes(level))
				return { error: "invalid_thinking" };
			return { message: { type: "set_thinking", level } };
		}
		case "trust": {
			const refused = refusal(session, "settings");
			if (refused) return refused;
			const trust = TRUST.find((value) => value === action.trust);
			if (!trust) return { error: "invalid_trust" };
			if (report?.trust === undefined) return { error: "pane_too_old" };
			return { message: { type: "set_trust", trust } };
		}
		case "rename": {
			const name = typeof action.name === "string" ? action.name.trim() : "";
			if (!name || name.length > NAME_MAX || TERMINAL_UNSAFE_CHARS.test(name)) return { error: "invalid_name" };
			return (
				refusal(session, "rename") ??
				(session.verdict.act ? { message: { type: "rename", name } } : { operation: { type: "rename", name } })
			);
		}
		case "pin":
			if (typeof action.pinned !== "boolean") return { error: "invalid_pinned" };
			return refusal(session, "pin") ?? { operation: { type: "pin", pinned: action.pinned } };
		case "delete":
			return refusal(session, "delete") ?? { operation: { type: "delete" } };
		case "stop_task":
		case "task_output": {
			const known = hasPane(session) ? report?.tasks?.find((t) => t.id === action.taskId) : undefined;
			if (!known) return { error: "unknown_task" };
			if (action.type === "stop_task")
				return refusal(session, "tasks") ?? { message: { type: "stop_task", id: known.id } };
			return known.outputFile ? { read: { type: "task_output", file: known.outputFile } } : { error: "no_output" };
		}
		case "image":
		case "message_output":
			return { read: { ...action, transcript: { sessionFile: session.sessionFile, leafId: session.leafId } } };
		case "status":
		case "commands":
			if (!hasPane(session) || !report) return { error: "no_status" };
			return action.type === "status"
				? { status: statusView(report, session.outcomes ?? []) }
				: { commands: report.commands ?? [] };
	}
}

function statusView(report: PaneReport, outcomes: PromptOutcome[]): StatusView {
	const { model, context, usage, subagentUsage: runs, notice } = report;
	return {
		model: model && modelView(model),
		models: report.models.map(modelView),
		thinkingLevel: report.thinkingLevel,
		thinkingLevels: report.thinkingLevels,
		trust: report.trust,
		context: context && { tokens: context.tokens, contextWindow: context.contextWindow, percent: context.percent },
		usage: usage && {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cost: usage.cost,
		},
		subagentUsage: runs && {
			runCount: runs.runCount,
			input: runs.input,
			output: runs.output,
			cacheRead: runs.cacheRead,
			cacheWrite: runs.cacheWrite,
			cost: runs.cost,
		},
		notice: notice && { text: notice.text, at: notice.at },
		outcomes: report.outcomes && outcomes.map((outcome) => ({ ...outcome })),
		tasks: report.tasks?.map((task) => ({
			id: task.id,
			kind: task.kind,
			label: task.label,
			startedAt: task.startedAt,
			foreground: task.foreground,
			status: task.status,
			model: task.model,
			output: task.outputFile ? true : undefined,
		})),
	};
}

function modelView(model: PaneReport["models"][number]): PaneReport["models"][number] {
	return { provider: model.provider, id: model.id, name: model.name };
}
