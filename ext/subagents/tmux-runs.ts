/**
 * Runs as pi sessions of their own (ADR-0006): a run is an interactive pi in agent view's private
 * tmux server, its role its launch flags. Its task and instructions go in files, as tmux refuses a
 * long command line. Its bluclawd knows it is a run by PARENT_ENV, and reports to its orchestrator
 * through the daemon each time it settles; the orchestrator's foreground launch waits for the first,
 * and every other Report goes to the orchestrator as a notice that wakes it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentActivity } from "../../daemon/activity.ts";
import type { SessionMessage } from "../../daemon/ipc/protocol.ts";
import { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { textOf } from "../../daemon/session-state.ts";
import { PARENT_ENV, RUN_TASK_ENV, type Tmux } from "../../daemon/tmux.ts";
import { ForegroundActivity } from "../agent-view/self-registration.ts";
import type { AgentDefinition } from "./definitions.ts";
import { NOT_APPROVAL } from "./messages.ts";
import type { SubagentRunnerExecuteParams, SubagentRunnerOutcome } from "./runs.ts";
import { type SubagentUsageTotals, sessionUsage } from "./usage.ts";

/** What a run is started as: its role and choices, resolved. */
export interface RunLaunch {
	name: string;
	definition: AgentDefinition;
	/** `provider/id`. */
	model: string;
	thinkingLevel?: string;
	task: string;
	cwd: string;
	/** Where its session, task and instructions are kept. */
	runDir: string;
	/** The orchestrator's tmux session. */
	parent: string;
	/** Whether the orchestrator trusts the project: the run starts in its trust, never asking. */
	projectTrusted: boolean;
}

/** The run's role as pi's launch flags. */
export function runLaunchArgs(run: RunLaunch, instructionsFile: string): string[] {
	const { tools } = run.definition;
	return [
		"--name",
		run.name,
		"--model",
		run.model,
		...(run.thinkingLevel ? ["--thinking", run.thinkingLevel] : []),
		...(tools ? (tools.length > 0 ? ["--tools", tools.join(",")] : ["--no-tools"]) : []),
		"--append-system-prompt",
		instructionsFile,
		"--session-dir",
		run.runDir,
		run.projectTrusted ? "--approve" : "--no-approve",
	];
}

/** Start the run's pi in a pane of its own; returns its tmux session. */
export function startRun(tmux: Pick<Tmux, "newSession">, run: RunLaunch): string {
	const instructions = join(run.runDir, "instructions.md");
	const task = join(run.runDir, "task.md");
	writeFileSync(instructions, run.definition.instructions);
	writeFileSync(task, run.task);
	return tmux.newSession({
		cwd: run.cwd,
		args: runLaunchArgs(run, instructions),
		env: { [PARENT_ENV]: run.parent, [RUN_TASK_ENV]: task },
	});
}

/** A Report as the orchestrator's model reads it: from another session, never the user. */
export function reportText(name: string, text: string): string {
	return `[Report from subagent "${name}", from another session, not from the user. ${NOT_APPROVAL}]\n\n${text}`;
}

type RunReport = Extract<SessionMessage, { kind: "report" }>;

/** Where the Reports of the orchestrator's runs go: to the foreground launch waiting for one, else to the run. */
export class RunReports {
	/** Each open run's message handler, by its tmux session. */
	private readonly runs = new Map<string, (message: SessionMessage) => void>();
	/** Foreground launches waiting for a run's next Report, by run ID. */
	private readonly waiting = new Map<string, (report: RunReport | undefined) => void>();

	/** Hands the messages from `pane` to `onMessage` until the returned function is called. */
	listen(pane: string, onMessage: (message: SessionMessage) => void): () => void {
		this.runs.set(pane, onMessage);
		return () => {
			if (this.runs.get(pane) === onMessage) this.runs.delete(pane);
		};
	}

	/** The run's next Report; undefined once `signal` aborts first. */
	next(runId: string, signal?: AbortSignal): Promise<RunReport | undefined> {
		return new Promise((resolve) => {
			const done = (report: RunReport | undefined) => {
				this.waiting.delete(runId);
				signal?.removeEventListener("abort", aborted);
				resolve(report);
			};
			const aborted = () => done(undefined);
			if (signal?.aborted) return done(undefined);
			signal?.addEventListener("abort", aborted, { once: true });
			this.waiting.set(runId, done);
		});
	}

	/** Gives a run's Report to the launch waiting for it; false when none waits. */
	take(runId: string, report: RunReport): boolean {
		const waiter = this.waiting.get(runId);
		waiter?.(report);
		return waiter !== undefined;
	}

	/** A message from another session; false when it is from no open run. */
	receive(message: SessionMessage): boolean {
		const run = this.runs.get(message.from);
		run?.(message);
		return run !== undefined;
	}
}

export interface TmuxRunDeps {
	tmux: Pick<Tmux, "newSession">;
	reports: RunReports;
	/** A Report no foreground launch took: it goes to the orchestrator. */
	notify(report: RunReport): void;
	/** The run started waiting on a prompt in its own session: the user is told in the orchestrator's. */
	needsInput(dialog: string | undefined): void;
	/** The run's session usage so far, from its latest Report. */
	usage(totals: SubagentUsageTotals): void;
}

/**
 * A run's life in its own pi, as the scheduler sees it: it starts the pi, then routes each Report until the
 * run is stopped. It stays open between Reports, so only a stop ends it.
 */
export async function executeTmuxRun(
	{ record, signal, controller }: SubagentRunnerExecuteParams,
	launch: RunLaunch,
	deps: TmuxRunDeps,
): Promise<SubagentRunnerOutcome> {
	const pane = startRun(deps.tmux, launch);
	controller.recordPane(pane);
	controller.markRunning();
	let last = "";
	const unlisten = deps.reports.listen(pane, (message) => {
		if (message.kind === "activity") {
			controller.updateActivity(message.activity);
			if (message.activity === "awaiting_input") deps.needsInput(message.dialog);
			return;
		}
		last = message.text;
		if (message.usage) deps.usage(message.usage);
		controller.updateProgress(message.text);
		if (!deps.reports.take(record.runId, message)) deps.notify(message);
	});
	try {
		await new Promise<void>((resolve) => {
			if (signal.aborted) return resolve();
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
	} finally {
		unlisten();
	}
	return { status: "cancelled", complete: false, summaryText: last };
}

/**
 * Inside a run: its task is its first prompt, it tells its orchestrator whenever it starts working, falls
 * idle or waits on a prompt of its own, and each time it settles its last message goes to its orchestrator
 * as a Report.
 */
export function actAsRun(pi: ExtensionAPI, parent: string, pane: string | undefined): void {
	const activity = new ForegroundActivity();
	/** What the orchestrator was last told. States and Reports go out one after another, in order. */
	let told: AgentActivity | undefined;
	let sending = Promise.resolve();
	const tell = (event: { type: string; kind?: string; title?: string }, ctx: ExtensionContext) => {
		const now = activity.apply(event);
		if (!pane || now === told) return sending;
		told = now;
		const message: SessionMessage = {
			type: "session_message",
			kind: "activity",
			from: pane,
			name: pi.getSessionName(),
			activity: now,
			...(now === "awaiting_input" && activity.dialog?.title ? { dialog: activity.dialog.title } : {}),
		};
		sending = sending.then(() => send(parent, message, ctx));
		return sending;
	};

	pi.on("session_start", () => {
		const taskFile = process.env[RUN_TASK_ENV];
		// Read once: a reload or a later session of this pi must not send it again.
		delete process.env[RUN_TASK_ENV];
		if (taskFile) pi.sendUserMessage(readFileSync(taskFile, "utf8"));
	});
	pi.on("agent_start", (event, ctx) => void tell(event, ctx));
	pi.on("turn_start", (event, ctx) => void tell(event, ctx));
	pi.on("ui_prompt_start", (event, ctx) => void tell(event, ctx));
	pi.on("ui_prompt_end", (event, ctx) => void tell(event, ctx));
	pi.on("agent_settled", async (event, ctx) => {
		// Idle before the Report, so the orchestrator it wakes no longer waits for this run.
		await tell(event, ctx);
		if (!pane) return;
		const last = [...ctx.sessionManager.getBranch()]
			.reverse()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		const text = last?.type === "message" && "content" in last.message ? textOf(last.message.content) : "";
		const report: SessionMessage = {
			type: "session_message",
			kind: "report",
			from: pane,
			name: pi.getSessionName(),
			text,
			usage: sessionUsage(ctx.sessionManager.getEntries()),
		};
		sending = sending.then(() => send(parent, report, ctx));
		await sending;
	});
}

async function send(parent: string, message: SessionMessage, ctx: ExtensionContext): Promise<void> {
	try {
		await new OrchestratorClient().send(parent, message);
	} catch (error) {
		ctx.ui.notify(
			`${message.kind === "report" ? "Report" : "State"} not sent to the orchestrator: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
	}
}
