/**
 * Runs on pi's RPC (ADR-0010), behind a switch until they replace runs in tmux: a run is a pi with no pane, held by
 * a host process of its own (rpc-host.ts), that takes its task in a fresh session, stores its Report once its work
 * settles, and exits; a Resume starts another on its saved session, as its next generation. For now a run only
 * reads: its tools are a plain allowlist of pi's read tools and codemode, anything else is refused at Admission, and
 * its pi checks every call again (rpc-child.ts).
 */

import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSessionEntries, type SessionEntry, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SessionMessage, SessionUsage } from "../../daemon/ipc/protocol.ts";
import { piCommand } from "../../daemon/tmux.ts";
import * as forkSettings from "../_shared/settings.ts";
import type { AgentDefinition } from "./definitions.ts";
import { type RpcDenyRules, RUN_DEFINITION_FLAG } from "./rpc-child.ts";
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
	thinkingLevel: string;
	tools: string[];
	task: string;
	cwd: string;
	runDir: string;
	agentDir: string;
	projectTrusted: boolean;
	/** The saved session a Resume reopens; absent at the launch, which starts a fresh one. */
	sessionFile?: string;
}

/**
 * What a run's generation is held to, as stored for it: at the launch, the role as admitted (definition.json),
 * which no later generation exceeds; at each Resume, that narrowed to what the orchestrator can give now.
 */
export interface RunDefinition extends AgentDefinition {
	tools: string[];
	deny: RpcDenyRules[];
	cwd: string;
	projectTrusted: boolean;
	admitted: { provider: string; modelId: string; thinkingLevel: string };
}

/** Where the definition of a run's generation is: the launch's in definition.json, each Resume's beside it. */
export function runDefinitionPath(runDir: string, generation: number): string {
	return generation ? join(runDir, "generations", `${generation}.json`) : join(runDir, "definition.json");
}

export function readRunDefinition(path: string): RunDefinition | undefined {
	try {
		const definition = JSON.parse(readFileSync(path, "utf8")) as RunDefinition;
		const { tools, deny, cwd, admitted, instructions } = definition;
		const valid =
			Array.isArray(tools) &&
			Array.isArray(deny) &&
			typeof cwd === "string" &&
			typeof instructions === "string" &&
			typeof admitted?.provider === "string" &&
			typeof admitted.modelId === "string" &&
			typeof admitted.thinkingLevel === "string";
		return valid ? definition : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Claims a run's generation `generation` for a Resume by storing its definition, only if no other Resume stored one
 * first: pi does not lock a session, so this is what keeps it to one pi at a time, across orchestrator processes too.
 */
export function claimRunGeneration(runDir: string, generation: number, definition: RunDefinition): boolean {
	const path = runDefinitionPath(runDir, generation);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const draft = `${path}.${randomUUID()}.tmp`;
	writeFileSync(draft, JSON.stringify(definition, null, 2), { mode: 0o600 });
	try {
		// A link fails where a file exists, and gives it whole: a reader never sees one half written.
		linkSync(draft, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		rmSync(draft, { force: true });
	}
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

/**
 * The deny rules an RPC run is held to, read from the settings of each directory, as trusted: those of its
 * orchestrator and of its own workspace. Rules that cannot be read refuse the run, rather than holding it to none.
 */
export function rpcDenyRules(
	agentDir: string,
	dirs: { cwd: string; trusted: boolean }[],
): { ok: true; deny: RpcDenyRules[] } | { ok: false; error: string } {
	const deny: RpcDenyRules[] = [];
	for (const { cwd, trusted } of dirs) {
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: trusted });
		const unread = [
			...settings.drainErrors().map(({ path, scope }) => path ?? `${scope} settings`),
			...forkSettings.invalidDenyScopes(settings).map((scope) => `${scope} permissions.deny`),
		];
		if (unread.length > 0) {
			return {
				ok: false,
				error: `Cannot launch subagent: the deny rules it must be held to cannot be read (${unread.join(", ")}).`,
			};
		}
		deny.push({ cwd, rules: forkSettings.denyRules(settings) });
	}
	return { ok: true, deny };
}

/** The run's pi with its flags: only bluclawd's child extension, its tools as an allowlist, its exact model and level. */
function rpcCommand(launch: RpcLaunch, instructionsFile: string, definitionFile: string): string[] {
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
		"--thinking",
		launch.thinkingLevel,
		...(launch.tools.length > 0 ? ["--tools", launch.tools.join(",")] : ["--no-tools"]),
		// A plain list keeps every tool named as MCP's, whoever registers it.
		"--exclude-tools",
		MCP_TOOLS.join(","),
		"--name",
		launch.name,
		"--append-system-prompt",
		instructionsFile,
		// By its absolute path: pi would ask on its stdout before opening a session by an id from another project.
		...(launch.sessionFile ? ["--session", launch.sessionFile] : ["--session-dir", launch.runDir]),
		launch.projectTrusted ? "--approve" : "--no-approve",
		`--${RUN_DEFINITION_FLAG}`,
		definitionFile,
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
		command: rpcCommand(launch, instructions, runDefinitionPath(launch.runDir, record.generation)),
		cwd: launch.cwd,
		agentDir: launch.agentDir,
		prompt: runTaskText(launch.task, launch.sessionFile !== undefined),
		model: { provider: launch.provider, id: launch.modelId, thinkingLevel: launch.thinkingLevel },
		generation: record.generation,
		...(launch.sessionFile ? { sessionFile: launch.sessionFile } : {}),
	});
	controller.markRunning();

	// The run's directory keeps the state of its earlier generation's host until this one stores its own.
	const ownState = () => {
		const state = readRpcHostState(launch.runDir);
		return state?.hostPid === hostPid ? state : undefined;
	};
	const ended = () => ownState()?.exit !== undefined || !processAlive(hostPid);
	await until(ended, AbortSignal.any([signal, deps.handOff]));
	// Handed off: the run goes on, its Report kept on disk, and this instance of the session stores nothing more.
	if (!ended() && !signal.aborted) return new Promise<never>(() => {});
	if (!ended()) {
		stopRpcHost(hostPid);
		const stopped = await until(ended, AbortSignal.timeout(STOP_GRACE_MS));
		if (!stopped) killHost(launch.runDir, hostPid);
	}

	const state = ownState();
	const report = readRunReports(launch.runDir, (state?.reportSeq ?? 0) - 1).find(
		({ seq }) => seq === state?.reportSeq,
	);
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
