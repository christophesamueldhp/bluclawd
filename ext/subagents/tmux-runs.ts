/**
 * Runs as pi sessions of their own (ADR-0006): a run is an interactive pi in agent view's private
 * tmux server, its role its launch flags. Its task and instructions go in files, as tmux refuses a
 * long command line. Its bluclawd knows it is a run by PARENT_ENV, and reports to its orchestrator
 * through the daemon each time it settles; the orchestrator's foreground launch waits for the first,
 * and every other Report goes to the orchestrator as a notice that wakes it.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionMessage } from "../../daemon/ipc/protocol.ts";
import { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { textOf } from "../../daemon/session-state.ts";
import { PARENT_ENV, RUN_TASK_ENV, Tmux } from "../../daemon/tmux.ts";
import type { AgentDefinition } from "./definitions.ts";
import { NOT_APPROVAL } from "./messages.ts";
import type { SubagentRunnerExecuteParams, SubagentRunnerOutcome } from "./runs.ts";

/** What a run is started as: its role and choices, resolved. */
export interface RunLaunch {
	name: string;
	definition: AgentDefinition;
	/** `provider/id`. */
	model: string;
	thinkingLevel?: string;
	/** Its first prompt; none for a Resume the user starts, who types in the run. */
	task?: string;
	cwd: string;
	/** Where its session, task and instructions are kept. */
	runDir: string;
	/** The session a Resume reopens; a launch starts a new one in `runDir`. */
	sessionFile?: string;
	/** The orchestrator's tmux session. */
	parent: string;
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
		...(run.sessionFile ? ["--session", run.sessionFile] : ["--session-dir", run.runDir]),
	];
}

/** Start the run's pi in a pane of its own; returns its tmux session. */
export function startRun(tmux: Pick<Tmux, "newSession">, run: RunLaunch): string {
	const instructions = join(run.runDir, "instructions.md");
	const task = join(run.runDir, "task.md");
	writeFileSync(instructions, run.definition.instructions);
	if (run.task !== undefined) writeFileSync(task, run.task);
	return tmux.newSession({
		cwd: run.cwd,
		args: runLaunchArgs(run, instructions),
		env: { [PARENT_ENV]: run.parent, ...(run.task !== undefined ? { [RUN_TASK_ENV]: task } : {}) },
	});
}

/** The run's session file: the one a Resume reopened, else the newest pi wrote in its directory. */
export function runSessionFile(run: Pick<RunLaunch, "runDir" | "sessionFile">): string | undefined {
	if (run.sessionFile) return run.sessionFile;
	try {
		return readdirSync(run.runDir)
			.filter((file) => file.endsWith(".jsonl"))
			.map((file) => join(run.runDir, file))
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
	} catch {
		return undefined;
	}
}

/** Stops the run's turn in progress, as Esc does; its pi stays open. False when its pane is gone. */
export function stopTurn(pane: string, tmux: Pick<Tmux, "sendKeys"> = new Tmux()): boolean {
	try {
		tmux.sendKeys(pane, ["Escape"]);
		return true;
	} catch {
		return false;
	}
}

/** A Report as the orchestrator's model reads it: from another session, never the user. */
export function reportText(name: string, text: string): string {
	return `[Report from subagent "${name}", from another session, not from the user. ${NOT_APPROVAL}]\n\n${text}`;
}

/** Where the Reports of the orchestrator's runs go: to the foreground launch waiting for one, else to the run. */
export class RunReports {
	/** Each open run's Report handler, by its tmux session. */
	private readonly runs = new Map<string, (report: SessionMessage) => void>();
	/** Foreground launches waiting for a run's next Report, by run ID. */
	private readonly waiting = new Map<string, (report: SessionMessage | undefined) => void>();

	/** Hands the Reports from `pane` to `onReport` until the returned function is called. */
	listen(pane: string, onReport: (report: SessionMessage) => void): () => void {
		this.runs.set(pane, onReport);
		return () => {
			if (this.runs.get(pane) === onReport) this.runs.delete(pane);
		};
	}

	/** The run's next Report; undefined once `signal` aborts first. */
	next(runId: string, signal?: AbortSignal): Promise<SessionMessage | undefined> {
		return new Promise((resolve) => {
			const done = (report: SessionMessage | undefined) => {
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
	take(runId: string, report: SessionMessage): boolean {
		const waiter = this.waiting.get(runId);
		waiter?.(report);
		return waiter !== undefined;
	}

	/** A message from another session; false when it is no Report of an open run. */
	receive(message: SessionMessage): boolean {
		const run = message.kind === "report" ? this.runs.get(message.from) : undefined;
		run?.(message);
		return run !== undefined;
	}
}

export interface TmuxRunDeps {
	tmux: Pick<Tmux, "newSession" | "end">;
	reports: RunReports;
	/** A Report no foreground launch took: it goes to the orchestrator. */
	notify(report: SessionMessage): void;
}

/**
 * A run's life in its own pi, as the scheduler sees it: it starts the pi, then routes each Report until the
 * run is closed. It stays open between Reports, so only a Close ends it: its pi is hung up, as quitting does,
 * without asking it, and its session is kept for a Resume.
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
	const unlisten = deps.reports.listen(pane, (report) => {
		last = report.text;
		controller.updateProgress(report.text);
		if (!deps.reports.take(record.runId, report)) deps.notify(report);
	});
	try {
		await new Promise<void>((resolve) => {
			if (signal.aborted) return resolve();
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
	} finally {
		unlisten();
	}
	try {
		deps.tmux.end(pane);
	} catch {
		// Its pi has quit already.
	}
	return { status: "closed", complete: false, summaryText: last, transcriptPath: runSessionFile(launch) };
}

/**
 * Inside a run: its task is its first prompt, and each time it settles its last message goes to its
 * orchestrator as a Report.
 */
export function actAsRun(pi: ExtensionAPI, parent: string, pane: string | undefined): void {
	pi.on("session_start", () => {
		const taskFile = process.env[RUN_TASK_ENV];
		// Read once: a reload or a later session of this pi must not send it again.
		delete process.env[RUN_TASK_ENV];
		if (taskFile) pi.sendUserMessage(readFileSync(taskFile, "utf8"));
	});
	pi.on("agent_settled", async (_event, ctx) => {
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
		};
		try {
			await new OrchestratorClient().send(parent, report);
		} catch (error) {
			ctx.ui.notify(
				`Report not sent to the orchestrator: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	});
}
