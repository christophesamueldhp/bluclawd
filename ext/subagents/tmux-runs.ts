/**
 * Runs as pi sessions of their own (ADR-0006): a run is an interactive pi in agent view's private
 * tmux server, its role its launch flags. Its task and instructions go in files, as tmux refuses a
 * long command line. Its bluclawd knows it is a run by PARENT_ENV, and reports to its orchestrator
 * through the daemon each time it settles; the orchestrator's foreground launch waits for the first.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionMessage } from "../../daemon/ipc/protocol.ts";
import { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { textOf } from "../../daemon/session-state.ts";
import { PARENT_ENV, RUN_TASK_ENV, type Tmux } from "../../daemon/tmux.ts";
import { AGENT_NAME_RE, delegationDenied, type LaunchParams, MAX_TASK_INPUT_BYTES } from "./admission.ts";
import {
	type AgentDefinition,
	type AgentDefinitionCatalog,
	createInlineAgentDefinition,
	isSubagentThinkingLevel,
	parseSubagentModelSpec,
	resolveAgentDefinition,
	SUBAGENT_THINKING_LEVELS,
} from "./definitions.ts";
import { NOT_APPROVAL, PARENT_MESSAGE_ADDRESS } from "./messages.ts";
import { createRunId } from "./runs.ts";
import { ensureRunStorageDir } from "./storage.ts";

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

/** The Reports the orchestrator waits for, by the tmux session of the run they come from. */
export class RunReports {
	private readonly waiting = new Map<string, (report: SessionMessage) => void>();

	/** The run's next Report; undefined once `signal` aborts first. */
	next(pane: string, signal?: AbortSignal): Promise<SessionMessage | undefined> {
		return new Promise((resolve) => {
			const done = (report: SessionMessage | undefined) => {
				this.waiting.delete(pane);
				signal?.removeEventListener("abort", aborted);
				resolve(report);
			};
			const aborted = () => done(undefined);
			if (signal?.aborted) return done(undefined);
			signal?.addEventListener("abort", aborted, { once: true });
			this.waiting.set(pane, done);
		});
	}

	/** A message from another session; false when nothing waits for it. */
	receive(message: SessionMessage): boolean {
		const waiter = message.kind === "report" ? this.waiting.get(message.from) : undefined;
		waiter?.(message);
		return waiter !== undefined;
	}
}

export interface ForegroundLaunchDeps {
	tmux: Pick<Tmux, "newSession">;
	/** The orchestrator's tmux session. */
	pane: string;
	agentDir: string;
	catalog: AgentDefinitionCatalog;
	parentThinkingLevel: string;
	reports: RunReports;
	/** Names of the runs this orchestrator launched. */
	names: Set<string>;
}

type LaunchContext = Pick<ExtensionContext, "cwd" | "model" | "modelRegistry" | "isProjectTrusted"> & {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
};

type ToolResult = AgentToolResult<unknown> & { isError?: boolean };

const refused = (text: string): ToolResult => ({
	content: [{ type: "text", text }],
	details: undefined,
	isError: true,
});

/** Launch a run in the foreground: its first Report is the result. */
export async function launchForeground(
	params: LaunchParams,
	signal: AbortSignal | undefined,
	ctx: LaunchContext,
	deps: ForegroundLaunchDeps,
): Promise<ToolResult> {
	const resolved =
		typeof params.agent === "string"
			? resolveAgentDefinition(deps.catalog, params.agent.trim())
			: createInlineAgentDefinition(params.agent);
	if (!resolved.ok) return refused(resolved.error);
	const { definition } = resolved;
	if (!params.task.trim()) return refused("Missing required parameter: task");
	if (Buffer.byteLength(params.task, "utf8") > MAX_TASK_INPUT_BYTES)
		return refused(
			`Delegated task exceeds the ${MAX_TASK_INPUT_BYTES}-byte limit. Supply target file paths instead of pasting large file contents.`,
		);
	const denied = delegationDenied(definition.name, ctx.cwd, deps.agentDir, ctx.isProjectTrusted());
	if (denied) return refused(denied);

	const spec = params.model === undefined ? definition.model : parseSubagentModelSpec(params.model);
	if (!spec)
		return refused(`Invalid subagent "model" value "${params.model}": must be "inherit" or "provider/model".`);
	const model = spec === "inherit" ? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined) : spec;
	const [provider, ...id] = model?.split("/") ?? [];
	if (!model || !ctx.modelRegistry.find(provider, id.join("/")))
		return refused(`Unknown subagent model "${model ?? "inherit"}".`);
	const level = params.thinkingLevel === "inherit" ? deps.parentThinkingLevel : params.thinkingLevel;
	if (level !== undefined && !isSubagentThinkingLevel(level))
		return refused(
			`Invalid subagent "thinkingLevel" value "${level}": must be "inherit" or one of ${SUBAGENT_THINKING_LEVELS.join(", ")}.`,
		);
	const thinkingLevel =
		level ?? definition.thinkingLevel ?? (spec === "inherit" ? deps.parentThinkingLevel : undefined);

	let name = params.name?.trim();
	if (name !== undefined && (!AGENT_NAME_RE.test(name) || name === PARENT_MESSAGE_ADDRESS || name.startsWith("sub_")))
		return refused(`Invalid subagent name "${name}": use lowercase letters, digits, "-" or "_".`);
	if (name !== undefined && deps.names.has(name))
		return refused(`Subagent name "${name}" is already used; choose another name.`);
	for (let n = 1; !name || deps.names.has(name); n++) name = `${definition.name}-${n}`;

	const runId = createRunId();
	const storage = ensureRunStorageDir(deps.agentDir, ctx.sessionManager.getSessionId(), runId);
	if (!storage.ok) return refused(`Cannot launch subagent: storage is unavailable (${storage.error}).`);
	const run: RunLaunch = {
		name,
		definition,
		model,
		thinkingLevel,
		task: params.task,
		cwd: ctx.cwd,
		runDir: storage.runDir,
		parent: deps.pane,
	};
	let pane: string;
	try {
		pane = startRun(deps.tmux, run);
	} catch (error) {
		return refused(`Cannot launch subagent: ${error instanceof Error ? error.message : String(error)}`);
	}
	deps.names.add(name);
	const report = await deps.reports.next(pane, signal);
	const details = { runId, name, pane, agentName: definition.name };
	if (!report)
		return {
			content: [{ type: "text", text: `Stopped waiting for ${name}'s report; it stays open in its own session.` }],
			details,
			isError: true,
		};
	return { content: [{ type: "text", text: reportText(name, report.text) }], details };
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
