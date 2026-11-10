/**
 * Runs on pi's RPC (ADR-0010), behind a switch until they replace runs in tmux: a run is a pi with no pane, held by
 * a host process of its own (rpc-host.ts), that takes its task in a fresh session, stores its Report once its work
 * settles, and exits. For now a run only reads: its tools are a plain allowlist of pi's read tools and codemode,
 * anything else is refused at Admission, and its pi checks every call again (rpc-child.ts).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SessionMessage, SessionUsage } from "../../daemon/ipc/protocol.ts";
import { piCommand } from "../../daemon/tmux.ts";
import type { AgentDefinition } from "./definitions.ts";
import { RUN_DEFINITION_FLAG } from "./rpc-child.ts";
import { launchRpcHost, processAlive, readRpcHostState, stopRpcHost } from "./rpc-host.ts";
import { runTaskText } from "./run-messages.ts";
import type { RunRuntimeOutcome, SubagentRunExecuteParams, SubagentRunOutcome } from "./runs.ts";
import { readRunReports, storedRunReportTextPath } from "./storage.ts";
import type { RunReports } from "./tmux-runs.ts";
import { sessionUsage } from "./usage.ts";

/** Set to launch runs on pi's RPC instead of in tmux. */
const RPC_RUNS_ENV = "BLUCLAWD_RPC_RUNS";
/**
 * Extensions an RPC run's pi loads besides bluclawd's own, separated as PATH is: those that register the providers
 * its model needs, which `-ne` leaves out.
 */
const RPC_PROVIDER_EXTENSIONS_ENV = "BLUCLAWD_RPC_PROVIDER_EXTENSIONS";
const CHILD_EXTENSION = fileURLToPath(new URL("./rpc-child.ts", import.meta.url));

export const rpcRunsEnabled = (): boolean => Boolean(process.env[RPC_RUNS_ENV]);

/** pi's tools that only read. */
const READ_TOOLS = ["read", "grep", "find", "ls"];
/** All an RPC run may have until its other capabilities are enforced: the read tools, and codemode over them. */
const RPC_TOOLS = [...READ_TOOLS, "codemode"];

/** pi's names for MCP tools, which its `--tools` list does not filter. */
const MCP_TOOLS = ["mcp__*", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

/** What an RPC run is started as: its role and choices, resolved at Admission. */
export interface RpcLaunch {
	name: string;
	definition: AgentDefinition;
	provider: string;
	modelId: string;
	thinkingLevel?: string;
	tools: string[];
	task: string;
	cwd: string;
	runDir: string;
	agentDir: string;
	projectTrusted: boolean;
}

/**
 * The tools an orchestrator can give an RPC run: those it can call, and codemode when its pi has codemode at all,
 * active or not. Codemode grants nothing of its own: a run's scripts reach only its other tools, and no model.
 */
export function rpcGrantableTools(callable: readonly string[], registered: readonly string[]): string[] {
	return [...callable, ...(registered.includes("codemode") && !callable.includes("codemode") ? ["codemode"] : [])];
}

/**
 * The tools an RPC run gets: those its role names, or every read tool and codemode the orchestrator can give it
 * when it names none. Anything else is refused, the shell, edits, MCP and subagents among them; Admission checks
 * that the orchestrator can give those named.
 */
export function rpcRunTools(
	definition: Pick<AgentDefinition, "name" | "tools">,
	available: readonly string[],
): { ok: true; tools: string[] } | { ok: false; error: string } {
	const named = definition.tools ?? RPC_TOOLS.filter((tool) => available.includes(tool));
	const refused = named.filter((tool) => !RPC_TOOLS.includes(tool));
	if (refused.length > 0) {
		return {
			ok: false,
			error: `Subagent role "${definition.name}" names tools a read-only run cannot have: ${refused.join(", ")}. Runs on pi's RPC only read for now (${RPC_TOOLS.join(", ")}): no shell, edits, MCP, tool search or subagents.`,
		};
	}
	return { ok: true, tools: [...named] };
}

/** The run's pi with its flags: only bluclawd's child extension, its tools as an allowlist, its exact model. */
function rpcCommand(launch: RpcLaunch, instructionsFile: string): string[] {
	const providers = (process.env[RPC_PROVIDER_EXTENSIONS_ENV] ?? "").split(":").filter(Boolean);
	return [
		...piCommand(),
		"--mode",
		"rpc",
		"-ne",
		...[CHILD_EXTENSION, ...providers].flatMap((path) => ["-e", path]),
		"--provider",
		launch.provider,
		"--model",
		launch.modelId,
		...(launch.thinkingLevel ? ["--thinking", launch.thinkingLevel] : []),
		...(launch.tools.length > 0 ? ["--tools", launch.tools.join(",")] : ["--no-tools"]),
		// A plain list keeps every tool named as MCP's, whoever registers it.
		"--exclude-tools",
		MCP_TOOLS.join(","),
		"--name",
		launch.name,
		"--append-system-prompt",
		instructionsFile,
		"--session-dir",
		launch.runDir,
		launch.projectTrusted ? "--approve" : "--no-approve",
		`--${RUN_DEFINITION_FLAG}`,
		join(launch.runDir, "definition.json"),
	];
}

/** How often the orchestrator looks at its run's host. */
const HOST_CHECK_MS = 100;
/** How long a stopped run's host may take to end before it and its pi are killed. */
const STOP_GRACE_MS = 10_000;

export interface RpcRunDeps {
	reports: RunReports;
	/** A Report no foreground launch took: it goes to the orchestrator. */
	notify(report: Extract<SessionMessage, { kind: "report" }>): void;
	/** The usage of the run's session `sessionId`. */
	usage(sessionId: string, totals: SessionUsage): void;
	/** Aborted when this orchestrator hands its open runs over to the next instance of its session (a reload). */
	handOff: AbortSignal;
}

/**
 * A run's generation on pi's RPC, as the scheduler sees it: its host starts its pi, and the generation ends once
 * that pi has exited, its Report stored. The Report goes to the orchestrator with how the work settled and how the
 * pi exited, apart from what the run claims.
 */
export async function executeRpcRun(
	{ record, signal, controller }: SubagentRunExecuteParams,
	launch: RpcLaunch,
	deps: RpcRunDeps,
): Promise<SubagentRunOutcome> {
	const instructions = join(launch.runDir, "instructions.md");
	writeFileSync(instructions, launch.definition.instructions);
	const hostPid = launchRpcHost(launch.runDir, {
		command: rpcCommand(launch, instructions),
		cwd: launch.cwd,
		agentDir: launch.agentDir,
		prompt: runTaskText(launch.task, false),
		model: { provider: launch.provider, id: launch.modelId },
	});
	controller.markRunning();

	const ended = () => readRpcHostState(launch.runDir)?.exit !== undefined || !processAlive(hostPid);
	await until(ended, AbortSignal.any([signal, deps.handOff]));
	// Handed off: the run goes on, its Report kept on disk, and this instance of the session stores nothing more.
	if (!ended() && !signal.aborted) return new Promise<never>(() => {});
	if (!ended()) {
		stopRpcHost(hostPid);
		const stopped = await until(ended, AbortSignal.timeout(STOP_GRACE_MS));
		if (!stopped) killHost(launch.runDir, hostPid);
	}

	const state = readRpcHostState(launch.runDir);
	const [report] = readRunReports(launch.runDir, record.lastDeliveredSeq ?? 0);
	if (!state?.exit || !report) {
		return {
			status: "failed",
			summaryText: report?.text ?? "",
			errorMessage: `The run's host ended before its pi did; see rpc-host.error and rpc-child.stderr in ${launch.runDir}.`,
			transcriptPath: state?.sessionFile,
		};
	}
	const outcome: RunRuntimeOutcome = report.outcome ?? { status: "failed", error: "no outcome was stored" };
	const usage = state.sessionFile ? sessionFileUsage(state.sessionFile) : undefined;
	if (usage) {
		controller.updateUsage(usage);
		deps.usage(state.sessionId ?? record.runId, usage);
	}
	controller.markDelivered(report.seq);
	controller.updateProgress(report.text);
	const text = [
		report.text,
		"---",
		`Outcome: ${outcome.status}${outcome.status === "completed" ? ": its pi settled its work without an error. What the run says above is its own claim; the runtime verified none of it." : `: ${outcome.error}.`}`,
		`Process: exited with ${state.exit.signal ? `signal ${state.exit.signal}` : `code ${state.exit.code}`}, after its Report was stored.`,
		`Transcript: ${state.sessionFile ?? "none"}`,
		`Report: ${storedRunReportTextPath(launch.runDir, report.seq)}`,
	].join("\n");
	const message: Extract<SessionMessage, { kind: "report" }> = {
		type: "session_message",
		kind: "report",
		from: record.runId,
		text,
		seq: report.seq,
		...(usage ? { usage } : {}),
		...(state.sessionId ? { sessionId: state.sessionId } : {}),
	};
	// A run stopped by its orchestrator or the user keeps its Report on disk, and wakes nobody with it.
	if (!signal.aborted && !deps.reports.take(record.runId, message)) deps.notify(message);
	return {
		status: "closed",
		summaryText: report.text,
		transcriptPath: state.sessionFile,
		...(outcome.status === "completed" ? {} : { errorMessage: outcome.error }),
	};
}

/** Resolves true once `done` holds, checked every {@link HOST_CHECK_MS}; false once `signal` aborts first. */
function until(done: () => boolean, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		const check = () => {
			if (done()) return finish(true);
			if (signal.aborted) return finish(false);
		};
		const finish = (result: boolean) => {
			clearInterval(timer);
			signal.removeEventListener("abort", check);
			resolve(result);
		};
		const timer = setInterval(check, HOST_CHECK_MS);
		signal.addEventListener("abort", check);
		check();
	});
}

/** Ends a host that did not stop in time, and the run's pi with it. */
function killHost(runDir: string, hostPid: number): void {
	const childPid = readRpcHostState(runDir)?.childPid;
	for (const pid of [hostPid, childPid]) {
		try {
			if (pid) process.kill(pid, "SIGKILL");
		} catch {
			// Gone already.
		}
	}
}

/** The usage of the run's session, from its file: what pi counted, once per entry. */
function sessionFileUsage(sessionFile: string): SessionUsage | undefined {
	try {
		const entries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
		return sessionUsage(entries.filter((entry): entry is SessionEntry => entry.type !== "session"));
	} catch {
		return undefined;
	}
}
