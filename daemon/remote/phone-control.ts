/**
 * Phone control: for one session, whether a Chat's action is allowed and what it becomes: a
 * message for its pane, a change the daemon makes itself, a read of its transcript or a task's
 * output, its status, the commands it lists, or an error. No I/O: the HTTP adapter (http.ts) carries out what this decides.
 */
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
import { findSession, type ListedSession } from "./sessions.ts";
import type { GitInfo } from "./statusline.ts";

/** A listed session, as one lookup per request finds it, with its pane's latest report and the
 *  outcomes of the prompts sent to it, as the daemon's delivery module has them. */
export type PhoneSession = ListedSession & { id: string; report?: PaneReport; outcomes?: PromptOutcome[] };

/** What a Chat asks of a session. A body's fields are `unknown` until the rule for them checks them. */
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

/** A change to the registry's row, which needs no pane. */
export type DaemonOperation = { type: "rename"; name: string } | { type: "pin"; pinned: boolean } | { type: "delete" };

/** A session's own transcript, at its pane's leaf. */
export type Transcript = Pick<ListedSession, "sessionFile" | "leafId">;

/** What to read for the phone: only the session's own files. */
export type TranscriptRead =
	| { type: "task_output"; file: string }
	| { type: "image"; transcript: Transcript; entryId: string; index: number }
	| { type: "message_output"; transcript: Transcript; entryId: string };

export type PhoneError =
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

/** A task as the phone lists it: `output` when its tail can be fetched, its file staying on the Mac. */
export type StatusTask = Omit<PaneTask, "outputFile"> & { output?: boolean };

/**
 * The Chat's status of a session: only these fields of its pane's report reach the phone, so a new
 * one shows there once it is added here. The web app's status bar (web/statusbar.js) documents the
 * same shape. `statusline` (pistatusline's own lines at the phone's width), else `git`: what the
 * Mac adds for the session's directory, which the HTTP adapter reads.
 */
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
	/** Only for a pane that reports them, so the phone tells it from an older one. */
	outcomes?: PromptOutcome[];
	tasks?: StatusTask[];
	git?: GitInfo;
	statusline?: { lines: StatusSpan[][] };
}

/** pi's `defaultProjectTrust` values, as Alt+M cycles them. */
const TRUST = ["always", "ask", "never"] as const;
const NAME_MAX = 100;
/** Never in a name: a control character would be a terminal escape in agent view. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** The one session lookup a request makes, and the event stream's session source. */
export function phoneSession(
	deps: {
		listInstances(): InstanceSummary[];
		report(sessionId: string): PaneReport | undefined;
		outcomes?(sessionId: string): PromptOutcome[];
	},
	id: string,
): PhoneSession | undefined {
	const found = findSession(deps.listInstances(), id);
	if (!found) return undefined;
	const report = deps.report(id);
	const outcomes = deps.outcomes?.(id);
	return { ...found, id, ...(report ? { report } : {}), ...(outcomes ? { outcomes } : {}) };
}

/** The command a "/" line names, as pi reads one (`/compact`, `/skill:pdf …`); none for text such as a path. */
export function commandName(text: string): string | undefined {
	return /^\/([\w.:-]+)(?:\s|$)/.exec(text.trimStart())?.[1];
}

/** A `!` or `!!` line is pi's own shell, which only its prompt runs: sent to the model, it is text.
 *  The phone app keeps a copy (web/live.js), held to this one by a shared test table. */
export function shellLine(text: string): boolean {
	return /^!+\s*\S/.test(text.trimStart());
}

/** Why the row's verdict refuses its pi a message: a Silent pane's takes nothing until it answers. */
function refusal({ verdict }: PhoneSession): PhoneOutcome | undefined {
	if (verdict.act) return undefined;
	return { error: verdict.reason === "silent" ? "session_silent" : "session_not_running" };
}

/** Whether a pane's pi is listed as the row, live or silent: a stored or starting row has none. */
function hasPane({ verdict }: PhoneSession): boolean {
	return verdict.act || verdict.reason === "silent";
}

function toPane(session: PhoneSession, message: PaneMessage): PhoneOutcome {
	return refusal(session) ?? { message };
}

export function decide(session: PhoneSession, action: PhoneAction): PhoneOutcome {
	const { report } = session;
	// A pane from an older bluclawd sends no report, and would ignore what only a newer one runs.
	if (
		(action.type === "model" || action.type === "thinking" || action.type === "trust") &&
		session.verdict.act &&
		!report
	) {
		return { error: "pane_too_old" };
	}
	switch (action.type) {
		case "prompt": {
			const { text, images, id, skills } = action;
			if (skills?.some((id) => !report?.commands?.some((c) => c.source === "skill" && c.skill?.id === id)))
				return { error: "invalid_skills" };
			// Its outcome comes back by its id; the pane refuses it once on another session.
			const sent = id ? { id, ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}) } : {};
			// A slash command, as pi reads one: typed into the pane's prompt (a phone's images never are).
			const name = commandName(text);
			const listed = report?.commands?.find((c) => c.name === name);
			// Selected instructions accompany model prompts; built-ins and shell lines keep their own route.
			const command =
				images || name?.startsWith("skill:") || (skills?.length && listed?.source === "prompt") ? undefined : name;
			const shell = !images && shellLine(text);
			if (command === undefined && !shell)
				return toPane(session, {
					type: "prompt",
					text,
					...(images ? { images } : {}),
					...(skills ? { skills } : {}),
					...sent,
				});
			// Only one the pane lists for a phone: a pane that lists none (an older one) runs none.

			if (!shell && (!listed || !phoneMayRun(listed))) return { error: "command_refused" };
			// Only into an idle, empty prompt. A pane that reports outcomes checks it, with no heartbeat's
			// lag, and reports it refused; for an older one, checked here too.
			if (!report?.outcomes) {
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
			const refused = refusal(session);
			if (refused) return refused;
			// Only a model the pane offered: the phone picks from that list, nothing else reaches the pane.
			if (!report?.models.some((m) => m.provider === provider && m.id === id)) return { error: "invalid_model" };
			return { message: { type: "set_model", provider, id } };
		}
		case "thinking": {
			const refused = refusal(session);
			if (refused) return refused;
			// Only a level the pane offered for its model: none when the model does not reason.
			const { level } = action;
			if (typeof level !== "string" || !report?.thinkingLevels?.includes(level))
				return { error: "invalid_thinking" };
			return { message: { type: "set_thinking", level } };
		}
		case "trust": {
			const refused = refusal(session);
			if (refused) return refused;
			const trust = TRUST.find((value) => value === action.trust);
			if (!trust) return { error: "invalid_trust" };
			// A pane that reports no trust mode is too old to set one.
			if (report?.trust === undefined) return { error: "pane_too_old" };
			return { message: { type: "set_trust", trust } };
		}
		case "rename": {
			const name = typeof action.name === "string" ? action.name.trim() : "";
			if (!name || name.length > NAME_MAX || CONTROL.test(name)) return { error: "invalid_name" };
			// A pane's pi names its session, as agent view's rename does; a stored row is the daemon's.
			return hasPane(session) ? toPane(session, { type: "rename", name }) : { operation: { type: "rename", name } };
		}
		case "pin":
			if (typeof action.pinned !== "boolean") return { error: "invalid_pinned" };
			return { operation: { type: "pin", pinned: action.pinned } };
		case "delete":
			// A pane's row comes back with its next heartbeat: its pi has to quit first.
			return hasPane(session) ? { error: "session_running" } : { operation: { type: "delete" } };
		case "stop_task":
		case "task_output": {
			// Only a task the pane reported: stopping it as /tasks' `x` does, or the tail of its output.
			const known = hasPane(session) ? report?.tasks?.find((t) => t.id === action.taskId) : undefined;
			if (!known) return { error: "unknown_task" };
			if (action.type === "stop_task") return toPane(session, { type: "stop_task", id: known.id });
			return known.outputFile ? { read: { type: "task_output", file: known.outputFile } } : { error: "no_output" };
		}
		case "image":
		case "message_output":
			return { read: { ...action, transcript: { sessionFile: session.sessionFile, leafId: session.leafId } } };
		case "status":
		case "commands":
			// A stored row's last report is no longer its status.
			if (!hasPane(session) || !report) return { error: "no_status" };
			return action.type === "status"
				? { status: statusView(report, session.outcomes ?? []) }
				: { commands: report.commands ?? [] };
	}
}

/** Fetched again after every report: the commands, which rarely change, have their own route.
 *  `outcomes`: the delivery module's, shown only when the pane's report says it reports them. */
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
			// The phone asks for its tail.
			output: task.outputFile ? true : undefined,
		})),
	};
}

function modelView(model: PaneReport["models"][number]): PaneReport["models"][number] {
	return { provider: model.provider, id: model.id, name: model.name };
}
