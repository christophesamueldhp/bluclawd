/**
 * Runs on pi's RPC (ADR-0010), every new run since they replaced runs in tmux: a run is a pi with no pane, held by
 * a host process of its own (rpc-host.ts), that takes its task in a fresh session, stores its Report once its work
 * settles, and exits; a Resume starts another on its saved session, as its next generation. Either waits its turn
 * in the daemon's queue (daemon/run-queue.ts), which starts the host once a slot is free. Its tools are a plain
 * allowlist of pi's read tools, codemode and, for a run that edits or runs commands, edit, write and bash, confined to
 * a worktree of its own (run-worktree.ts), its commands to a sandbox of its own (run-shell.ts); anything else is
 * refused at Admission, and its pi checks every call again (rpc-child.ts). A generation ends once none of its
 * processes runs: its host's group, and every process its commands started (ext/sandbox/run-containment.ts).
 */

import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSessionEntries, type SessionEntry, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { SessionMessage, SessionUsage } from "../../daemon/ipc/protocol.ts";
import { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { runMarker } from "../../daemon/run-members.ts";
import type { RunHostLaunch } from "../../daemon/run-queue.ts";
import * as forkSettings from "../_shared/settings.ts";
import {
	endRunProcesses,
	prepareRunContainment,
	type RunContainment,
	type RunContainmentReady,
} from "../sandbox/run-containment.ts";
import type { AgentDefinition } from "./definitions.ts";
import { SUBAGENT_MESSAGE_TOOL } from "./messages.ts";
import { truncateUtf8Safe } from "./results.ts";
import { type RpcDenyRules, RUN_DEFINITION_FLAG } from "./rpc-child.ts";
import {
	generationHost,
	prepareRpcHost,
	processAlive,
	processGroupAlive,
	type RpcHostSpec,
	readRpcHostState,
	runGroupAlive,
	stopRpcHost,
} from "./rpc-host.ts";
import {
	answerRunApproval,
	markRunApprovalSeen,
	openRunApprovalRequests,
	type RunApprovalAnswer,
	type RunApprovalRequest,
	runApprovalWithdrawn,
} from "./run-approvals.ts";
import { checksLines, commandsRun } from "./run-evidence.ts";
import {
	markRunOutboxRelayed,
	openRunInbox,
	type RunOutboxMessage,
	readRunOutbox,
	relayedRunOutbox,
	sealedRunInbox,
	sealRunInbox,
} from "./run-mailbox.ts";
import { rpcRunMessageText, runTaskText } from "./run-messages.ts";
import { runShellTmp } from "./run-shell.ts";
import {
	describeWorkspace,
	discardWorktree,
	type IsolatedWorkspace,
	materializeWorktree,
	releaseUnchangedWorktree,
	workspaceInstructions,
} from "./run-worktree.ts";
import type { RunRuntimeOutcome, SubagentRunExecuteParams, SubagentRunOutcome } from "./runs.ts";
import { readRunReports, storedRunReportTextPath } from "./storage.ts";
import type { RunReports } from "./tmux-runs.ts";
import { sessionUsage } from "./usage.ts";

/**
 * Extensions an RPC run's pi loads besides bluclawd's own, separated as PATH is: those that register the providers
 * its model needs, which `-ne` leaves out. A stopgap for tests and development; without it, a run of a provider an
 * extension registers is refused at Admission (rpcRunProvider).
 */
const RPC_PROVIDER_EXTENSIONS_ENV = "BLUCLAWD_RPC_PROVIDER_EXTENSIONS";
const CHILD_EXTENSION = fileURLToPath(new URL("./rpc-child.ts", import.meta.url));

/** pi's tools that only read. */
const READ_TOOLS = ["read", "grep", "find", "ls"];
/** pi's tools that change files: a run given either works in a worktree of its own, and changes nothing else. */
export const WRITE_TOOLS = ["edit", "write"];
/** A run given any of these works in a worktree of its own: a command changes files as an edit does. */
export const WORKTREE_TOOLS = [...WRITE_TOOLS, "bash"];
/** All an RPC run may have: the read tools, codemode over them, the edit tools and the shell. */
const RPC_TOOLS = [...READ_TOOLS, "codemode", ...WORKTREE_TOOLS];
/**
 * Marks a tool a role names as given only where it can be: where the orchestrator has it, and for bash where a run's
 * commands can be contained. Without it, a tool that cannot be given refuses the run.
 */
const OPTIONAL_TOOL = "?";
/** What a run gets when its role names no tools: it reads, with what of these its orchestrator can give. */
const DEFAULT_RPC_TOOLS = [...READ_TOOLS, "codemode"].map((tool) => `${tool}${OPTIONAL_TOOL}`);

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
	/** Set when a Resume's instruction is the user's own; otherwise the task is its orchestrator's. */
	taskFrom?: "user";
	/** The worktree of a run that edits, made at its launch, or of its chain; its `cwd` is in it. */
	workspace?: IsolatedWorkspace;
	/** Set when an earlier step of its chain made its worktree, handed on to it as it is. */
	worktreeMade?: boolean;
	/** Set on a step of a chain: its worktree is kept, even unchanged, for the steps after it; the chain releases it. */
	keepWorktree?: boolean;
	/**
	 * Set on a generation an earlier instance of its orchestrator's session admitted and left behind (a reload or a
	 * crash): the spec it was launched with, as stored then. Its host is followed if one took it, else it queues again.
	 */
	recovered?: RpcHostSpec;
	/**
	 * Why the run may no longer start, asked once its turn comes: it may have waited in the queue since Admission. It
	 * narrows what the run is held to, never widens it.
	 */
	recheck(): string | undefined;
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
	/** A run that edits: the worktree it may change, and its baseline. */
	workspace?: IsolatedWorkspace;
	/** A run given `bash`: what its commands' sandbox is named after and kept out of (run-shell.ts). */
	shell?: { runId: string; runDir: string };
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
 * `definition` held as well to what the orchestrator can give now: only the tools it still can, and the deny rules it
 * has now on top of those stored.
 */
export function narrowRunDefinition(
	definition: RunDefinition,
	grantable: readonly string[],
	deny: readonly RpcDenyRules[],
): RunDefinition {
	const stored = new Set(definition.deny.map((rules) => JSON.stringify(rules)));
	return {
		...definition,
		tools: definition.tools.filter((tool) => grantable.includes(tool)),
		deny: [...definition.deny, ...deny.filter((rules) => !stored.has(JSON.stringify(rules)))],
	};
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

const toolName = (listed: string) => (listed.endsWith(OPTIONAL_TOOL) ? listed.slice(0, -1) : listed);

/**
 * Why a run cannot have a model of `provider`, which an extension of the orchestrator's pi registers: a run's pi
 * loads only bluclawd's child extension, so it would lack that provider, or have only pi's own of that name.
 */
export function rpcRunProviderRefusal(provider: string, extensionProviders: readonly string[]): string | undefined {
	if (!extensionProviders.includes(provider) || process.env[RPC_PROVIDER_EXTENSIONS_ENV]) return undefined;
	return `Cannot launch subagent: provider "${provider}" is registered by an extension of this pi, which a run's pi does not load, so the run would not have it as you do. Choose a model of a provider pi has built in, or one configured in models.json.`;
}

/** Whether a run of this role may get `bash`, so whether Admission must know first that its shell can be contained. */
export function rpcRunMayShell(definition: Pick<AgentDefinition, "tools">): boolean {
	return definition.tools?.some((tool) => toolName(tool) === "bash") === true;
}

/**
 * The tools an RPC run gets: those its role names, or every read tool and codemode the orchestrator can give it
 * when it names none. A tool named with a trailing `?` is given only where it can be; any other the orchestrator
 * cannot give, or bash where `shell` says commands cannot be contained, refuses the run. So does a tool no run may
 * have, MCP and subagents among them.
 */
export function rpcRunTools(
	definition: Pick<AgentDefinition, "name" | "tools">,
	available: readonly string[],
	shell: RunContainmentReady | undefined,
): { ok: true; tools: string[] } | { ok: false; error: string } {
	const listed = definition.tools ?? DEFAULT_RPC_TOOLS;
	const givable = (tool: string) => available.includes(tool) && (tool !== "bash" || shell?.ok === true);
	const refused = listed.map(toolName).filter((tool) => !RPC_TOOLS.includes(tool));
	if (refused.length > 0) {
		return {
			ok: false,
			error: `Subagent role "${definition.name}" names tools a run on pi's RPC cannot have: ${refused.join(", ")}. It may only read, script its reads with codemode, and edit files and run commands in a worktree of its own (${RPC_TOOLS.join(", ")}): no MCP, tool search or subagents.`,
		};
	}
	const unknown = listed.filter((tool) => !tool.endsWith(OPTIONAL_TOOL) && !available.includes(tool));
	if (unknown.length > 0) {
		return {
			ok: false,
			error: `Subagent role "${definition.name}" names tools the orchestrator cannot give a child: ${unknown.join(", ")}. Available: ${available.join(", ") || "none"}.`,
		};
	}
	const named = listed.filter((tool) => !tool.endsWith(OPTIONAL_TOOL) || givable(toolName(tool))).map(toolName);
	if (named.includes("bash") && !shell?.ok) {
		return {
			ok: false,
			error: `Subagent role "${definition.name}" names bash, and a run gets no shell here: ${shell?.ok === false ? shell.reason : "it was not checked"}. Give it a role that does not run commands.`,
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

/** The run's pi's flags: only bluclawd's child extension, its tools as an allowlist, its exact model and level. */
function rpcArgs(launch: RpcLaunch, instructionsFile: string, definitionFile: string): string[] {
	const providers = (process.env[RPC_PROVIDER_EXTENSIONS_ENV] ?? "").split(":").filter(Boolean);
	return [
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
		// Its own message tool besides those it was given: the child extension grants it to every run.
		"--tools",
		[...launch.tools, SUBAGENT_MESSAGE_TOOL].join(","),
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

/** How much of the orchestrator's context a run's Report takes: some 2,000 tokens at most, however long its text. */
const MAX_RUN_REPORT_BYTES = 8 * 1024;
/** What a run is told of its Report, which nothing summarizes for it: its orchestrator gets it as it is, bounded. */
const REPORT_INSTRUCTIONS = [
	"",
	"",
	"## Your Report",
	"Your last message, once your work is done, is your Report to your orchestrator. Keep it concise, well under 2,000 tokens and shorter for simple work: what you found or changed, the checks you actually ran and how they ended, and what blocks you. Cite where the evidence is rather than pasting it; your transcript is kept. Never claim a check you did not run.",
].join("\n");
/** How much of why a run failed its Report gives; its stderr and transcript keep all of it. */
const MAX_REASON_BYTES = 1024;
/** How often the orchestrator looks at its run's host. */
const HOST_CHECK_MS = 100;
/** How long a run's host and its pi may take to end, once stopped or done, before what is left of them is killed. */
const STOP_GRACE_MS = 10_000;
/** How long what was killed of a run may take to be gone, before its end is reported as unconfirmed. */
const KILL_WAIT_MS = 5000;

/** The daemon's queue of runs (daemon/run-queue.ts), as an orchestrator takes its turns in it. */
export interface RunSlots {
	/** Starts the daemon if none runs; false when it cannot. */
	ensure(): Promise<boolean>;
	/** True once run `run` of orchestrator `parent` is granted a slot; false when the daemon's wait passed first. */
	claim(run: string, parent: string, signal: AbortSignal): Promise<boolean>;
	/** Has the daemon start a granted run's host; returns its pid. */
	launch(run: string, host: RunHostLaunch): Promise<number>;
	/** Gives up a claim, or a slot not launched yet. */
	release(run: string): Promise<void>;
}

/** The daemon's queue, with the bound on active runs `capacity` gives at each claim. */
export function daemonRunSlots(capacity: () => number): RunSlots {
	let ensuring: Promise<boolean> | undefined;
	return {
		ensure: () => {
			// Shared: launches in one message would each start a daemon.
			ensuring ??= new OrchestratorClient().ensureDaemon().finally(() => {
				ensuring = undefined;
			});
			return ensuring;
		},
		claim: (run, parent, signal) => new OrchestratorClient().claimRun(run, parent, capacity(), signal),
		launch: (run, host) => new OrchestratorClient().launchRun(run, host),
		release: (run) => new OrchestratorClient().releaseRun(run),
	};
}

/** How often in a row the daemon may fail a run's turn, each time started anew, before the run fails. */
const QUEUE_TRIES = 3;

/**
 * Waits for run `run`'s turn in the queue, checks it may still start, and has the daemon start its host. Undefined
 * once `signal` aborts first; its claim is given up then.
 */
async function startInTurn(
	run: string,
	parent: string,
	host: RunHostLaunch,
	recheck: () => string | undefined,
	slots: RunSlots,
	signal: AbortSignal,
): Promise<{ hostPid: number } | { refused: string } | { error: string } | undefined> {
	let failures = 0;
	while (!signal.aborted) {
		try {
			if (!(await slots.claim(run, parent, signal))) {
				failures = 0;
				continue;
			}
			// Stopped as its turn came: it never starts.
			if (signal.aborted) break;
			const refused = recheck();
			if (refused) {
				await slots.release(run).catch(() => {});
				return { refused };
			}
			return { hostPid: await slots.launch(run, host) };
		} catch (error) {
			if (signal.aborted) break;
			// A daemon started anew takes the claim again, from the back of the queue; a slow one may only seem down.
			await slots.ensure();
			if (++failures >= QUEUE_TRIES) {
				await slots.release(run).catch(() => {});
				return { error: error instanceof Error ? error.message : String(error) };
			}
		}
	}
	slots.release(run).catch(() => {});
	return undefined;
}

export interface RpcRunDeps {
	reports: RunReports;
	/** The daemon's queue, which every launch and Resume takes its turn in. */
	slots: RunSlots;
	/** A background run did not start: the orchestrator is told why. */
	notStarted(reason: string): void;
	/** A run taken over ended with no Report while none watched it: the orchestrator is told what is uncertain. */
	lost(reason: string): void;
	/** A Report no foreground launch took: it goes to the orchestrator. */
	notify(report: Extract<SessionMessage, { kind: "report" }>): void;
	/** The usage of the run's session `sessionId`. */
	usage(sessionId: string, totals: SessionUsage): void;
	/** Aborted when this orchestrator hands its open runs over to the next instance of its session (a reload). */
	handOff: AbortSignal;
	/** A finding, question or blocker the run sent while it worked, for its orchestrator or a sibling. */
	relay(message: RunOutboxMessage): void;
	/** An approval the run asks for, answered by the user or blocked; `signal` aborts once it takes no answer. */
	approve(request: RunApprovalRequest, signal: AbortSignal): Promise<RunApprovalAnswer>;
}

const untakenText = (count: number, runDir: string, generation: number) =>
	`${count} message${count === 1 ? "" : "s"} sent to it never reached its pi, kept in ${sealedRunInbox(runDir, generation)}`;

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
	const { workspace, recovered } = launch;
	// A generation recovered has its files from its Admission, its inbox perhaps sealed since.
	if (!recovered) {
		writeFileSync(
			instructions,
			launch.definition.instructions +
				(workspace
					? `\n${workspaceInstructions(
							workspace,
							launch.tools.some((tool) => WORKTREE_TOOLS.includes(tool)),
							launch.tools.includes("bash"),
						)}`
					: "") +
				REPORT_INSTRUCTIONS,
		);
		// Open before anything is awaited: the run takes messages from its Admission on, queued or working.
		openRunInbox(launch.runDir, record.generation);
	}
	/**
	 * What the run's pi has sent out since it was last looked at: its progress is only noted, wakes nobody. How far
	 * it was relayed is stored before each is relayed, so an instance that takes the run over goes on from there.
	 */
	let relayed = relayedRunOutbox(launch.runDir, record.generation);
	const relay = () => {
		for (const message of readRunOutbox(launch.runDir, record.generation, relayed)) {
			relayed = message.seq;
			markRunOutboxRelayed(launch.runDir, record.generation, relayed);
			if (message.kind === "progress") controller.updateProgress(message.content);
			else deps.relay(message);
		}
	};
	/**
	 * Seals the inbox of a run that never started; says how many messages it holds. A launch that never started
	 * leaves no worktree or baseline behind either: there is nothing of it to resume.
	 */
	const untakenNote = () => {
		if (workspace && !launch.sessionFile && !launch.worktreeMade) {
			discardWorktree(workspace, { agentDir: launch.agentDir, runId: record.runId, runDir: launch.runDir });
		}
		const untaken = sealRunInbox(launch.runDir, record.generation).length;
		return untaken ? `; ${untakenText(untaken, launch.runDir, record.generation)}.` : "";
	};
	/** What finds the processes its commands start, for a run with a shell: none may outlive its generation. */
	let contained: RunContainment | undefined;
	// Built before anything is awaited, so within its Admission: the run starts as admitted, however long it queues.
	const host = prepareRpcHost(
		launch.runDir,
		recovered ?? {
			args: rpcArgs(launch, instructions, runDefinitionPath(launch.runDir, record.generation)),
			cwd: launch.cwd,
			agentDir: launch.agentDir,
			prompt:
				launch.taskFrom === "user"
					? rpcRunMessageText({ kind: "user" }, record, launch.task)
					: runTaskText(launch.task, launch.sessionFile !== undefined),
			model: { provider: launch.provider, id: launch.modelId, thinkingLevel: launch.thinkingLevel },
			generation: record.generation,
			...(launch.sessionFile ? { sessionFile: launch.sessionFile } : {}),
		},
	);
	if (launch.tools.includes("bash")) {
		const ready = await prepareRunContainment();
		if (!ready.ok) {
			const reason = `its shell cannot be contained (${ready.reason})`;
			if (record.deliveryMode === "background") deps.notStarted(reason);
			// A Resume that did not start leaves its session as it was, to be resumed again.
			return {
				status: launch.sessionFile ? "closed" : "failed",
				summaryText: "",
				errorMessage: `It did not start: ${reason}${untakenNote()}`,
			};
		}
		contained = { helper: ready.helper, marker: runMarker(record.runId) };
	}
	/** The host that took this generation before this instance did, if one did: followed, never launched again. */
	const taken = recovered ? generationHost(launch.runDir, record.generation) : undefined;
	// A run that edits gets its worktree as its Admission recorded it, before it waits for its turn.
	if (
		workspace &&
		!launch.sessionFile &&
		!launch.worktreeMade &&
		!taken &&
		!(recovered && existsSync(workspace.root))
	) {
		try {
			await materializeWorktree(workspace);
		} catch (error) {
			const reason = `its worktree could not be made (${error instanceof Error ? error.message : String(error)})`;
			if (record.deliveryMode === "background") deps.notStarted(reason);
			return { status: "failed", summaryText: "", errorMessage: `It did not start: ${reason}${untakenNote()}` };
		}
	}
	// Its session's entries from here on are this generation's: an earlier one ended before it was claimed. A generation
	// taken over began when its run was first started.
	const queuedAt = recovered ? (record.startedAt ?? Date.now()) : Date.now();
	const turn = taken
		? { hostPid: taken }
		: await startInTurn(
				`${record.runId}/${record.generation}`,
				record.parentSessionId,
				contained ? { ...host, contained: true } : host,
				launch.recheck,
				deps.slots,
				AbortSignal.any([signal, deps.handOff]),
			);
	if (!turn) {
		// Handed off before it started: the next instance of the session finds it never started, and queues it again.
		if (deps.handOff.aborted) return new Promise<never>(() => {});
		return { status: "cancelled", summaryText: "", errorMessage: `It was stopped before it started${untakenNote()}` };
	}
	if (!("hostPid" in turn)) {
		const reason = "refused" in turn ? turn.refused : `the daemon could not start it (${turn.error})`;
		if (record.deliveryMode === "background" && !deps.reports.awaited(record.runId)) deps.notStarted(reason);
		// A Resume that did not start leaves its session as it was, to be resumed again.
		return {
			status: launch.sessionFile ? "closed" : "failed",
			summaryText: "",
			errorMessage: `It did not start: ${reason}${untakenNote()}`,
		};
	}
	controller.markRunning();
	/** The generation's host: the one that took it, which a host launched again leaves it to, or the one launched. */
	const hostOf = () => generationHost(launch.runDir, record.generation) ?? turn.hostPid;
	/** A host taken over that is gone: its pid, read from disk, may run another process by now, never signalled. */
	const gone = taken !== undefined && !runGroupAlive(taken, launch.runDir);

	// The run's directory keeps the state of its earlier generation's host until this one stores its own.
	const ownState = () => {
		const state = readRpcHostState(launch.runDir);
		return state?.hostPid === hostOf() ? state : undefined;
	};
	const ended = () => gone || ownState()?.exit !== undefined || !processAlive(hostOf());
	/** The approvals asked for that this orchestrator saw and has not answered, each aborted once it takes no answer. */
	const asked = new Map<string, AbortController>();
	const approvals = () => {
		for (const request of openRunApprovalRequests(launch.runDir, record.generation)) {
			// Noted on every look, so the host can tell an orchestrator gone meanwhile from one still asking.
			markRunApprovalSeen(launch.runDir, record.generation, request.id);
			if (asked.has(request.id)) continue;
			const pending = new AbortController();
			asked.set(request.id, pending);
			void deps
				.approve(request, pending.signal)
				.catch((): RunApprovalAnswer => "blocked")
				.then((answer) => {
					if (pending.signal.aborted) return;
					asked.delete(request.id);
					answerRunApproval(launch.runDir, record.generation, request.id, answer);
				});
		}
		for (const [id, pending] of asked) {
			if (!runApprovalWithdrawn(launch.runDir, record.generation, id)) continue;
			asked.delete(id);
			pending.abort();
		}
	};
	await until(
		() => {
			// Handed off, it is the next instance's to relay and answer for: its scope here is gone.
			if (deps.handOff.aborted) return false;
			relay();
			approvals();
			return ended();
		},
		AbortSignal.any([signal, deps.handOff]),
	);
	// No one here answers them any more. A stopped run's host withdraws them, and an answer would let its pi go on;
	// a run handed off is the next instance's to answer.
	for (const [id, pending] of asked) {
		pending.abort();
		if (!signal.aborted && !deps.handOff.aborted) answerRunApproval(launch.runDir, record.generation, id, "blocked");
	}
	// Handed off: the run goes on, and the next instance of the session takes it over; this one stores nothing more,
	// even of a run it was stopping, which that instance stops again.
	if (deps.handOff.aborted) return new Promise<never>(() => {});
	const hostPid = hostOf();
	if (!ended()) stopRpcHost(hostPid);
	// The generation ends once nothing of it runs: its host, its pi, whatever they started in the host's group, and every
	// process its commands started, wherever they went.
	const terminated = gone ? !contained || (await endRunProcesses(contained)) : await endHostGroup(hostPid, contained);
	if (deps.handOff.aborted) return new Promise<never>(() => {});
	if (terminated && contained) rmSync(runShellTmp(launch.agentDir, record.runId), { recursive: true, force: true });
	// Once nothing of it runs, a worktree it left as it was made goes, a Resume making it again; any other stays.
	if (workspace && terminated && !launch.keepWorktree) {
		await releaseUnchangedWorktree(workspace, {
			agentDir: launch.agentDir,
			runId: record.runId,
			runDir: launch.runDir,
		});
	}
	// Where it worked and what it changed there, as Git sees it rather than as the run says.
	const workspaceLines = workspace ? await describeWorkspace(workspace, launch.runDir) : [];
	const workspaceNote = workspaceLines.length ? `\n${workspaceLines.join("\n")}` : "";

	// Whatever it sent before it ended reaches its recipients before its Report.
	relay();
	const state = ownState();
	const entries = state?.sessionFile ? sessionFileEntries(state.sessionFile) : undefined;
	// Counted however the generation ended: what pi counted in its session was spent, Report or not, each entry once.
	const usage = entries && sessionUsage(entries);
	if (usage) {
		controller.updateUsage(usage);
		deps.usage(state?.sessionId ?? record.runId, usage);
	}
	const report = readRunReports(launch.runDir, (state?.reportSeq ?? 0) - 1).find(
		({ seq }) => seq === state?.reportSeq,
	);
	if (!terminated) {
		sealRunInbox(launch.runDir, record.generation);
		return {
			status: "failed",
			summaryText: report?.text ?? "",
			errorMessage: `Its processes did not all end, even killed: ${contained ? `process group ${hostPid}, or a process its commands started,` : `process group ${hostPid}`} still runs. Nothing confirms its work stopped.${workspaceNote}`,
			transcriptPath: state?.sessionFile,
		};
	}
	if (!state?.exit || !report) {
		// Later messages are refused; those it was sent stay on disk, whether its pi took them or not.
		sealRunInbox(launch.runDir, record.generation);
		// Stopped, and nothing of it runs any more: cancelled, though its host ended before it stored a Report.
		if (signal.aborted) {
			return {
				status: "cancelled",
				summaryText: "",
				errorMessage: `Its work was stopped, and nothing of it runs any more; no Report was stored.${workspaceNote}`,
				transcriptPath: state?.sessionFile,
			};
		}
		if (!recovered) {
			return {
				status: "failed",
				summaryText: report?.text ?? "",
				errorMessage: `The run's host ended before its pi did; see rpc-host.error and rpc-child.stderr in ${launch.runDir}.${workspaceNote}`,
				transcriptPath: state?.sessionFile,
			};
		}
		// Taken over from an instance that is gone: whatever it did may have had effects nothing recorded.
		const uncertain = `its host ended with no Report stored, so what its work did by then is uncertain, side effects included; it is not started again. Its transcript says how far it got: ${state?.sessionFile ?? "none was stored"}`;
		deps.lost(uncertain);
		return {
			status: "failed",
			summaryText: "",
			errorMessage: `${uncertain[0].toUpperCase()}${uncertain.slice(1)}; see also rpc-host.error and rpc-child.stderr in ${launch.runDir}.${workspaceNote}`,
			transcriptPath: state?.sessionFile,
		};
	}
	const outcome: RunRuntimeOutcome = report.outcome ?? { status: "failed", error: "no outcome was stored" };
	controller.markDelivered(report.seq);
	controller.updateProgress(report.text);
	const fullReport = storedRunReportTextPath(launch.runDir, report.seq);
	// What the runtime saw, never cut: the run's claim above it takes what room is left.
	const runtime = [
		"---",
		`Outcome: ${outcome.status}${outcome.status === "completed" ? ": its pi settled its work without an error. What the run says above is its own claim; the runtime verified none of it." : `: ${cutReason(outcome.error)}.`}`,
		`Process: exited with ${state.exit.signal ? `signal ${state.exit.signal}` : `code ${state.exit.code}`}, after its Report was stored.`,
		...checksLines(launch.tools, commandsRun(entries ?? [], queuedAt)),
		...(workspace ? workspaceLines : ["Changes: none: it had no tool that changes files."]),
		// A step of a chain is integrated with its chain, once the chain has completed.
		...(workspace && outcome.status === "completed" && !launch.keepWorktree && existsSync(workspace.root)
			? [
					`Integration: once you have reviewed its changes, subagent_integrate "${launch.name}" applies them to your checkout.`,
				]
			: []),
		`Transcript: ${state.sessionFile ?? "none"}`,
		`Report: ${fullReport}`,
		...(report.untaken ? [`Untaken: ${untakenText(report.untaken, launch.runDir, record.generation)}.`] : []),
	].join("\n");
	const text = `${boundedClaim(report.text, MAX_RUN_REPORT_BYTES - bytes(runtime) - 1, fullReport)}\n${runtime}`;
	const message: Extract<SessionMessage, { kind: "report" }> = {
		type: "session_message",
		kind: "report",
		from: record.runId,
		text,
		seq: report.seq,
		...(usage ? { usage } : {}),
		...(state.sessionId ? { sessionId: state.sessionId } : {}),
	};
	// A run stopped by its orchestrator or the user keeps its Report on disk, and wakes nobody with it. One taken over
	// after its Report was delivered, before its end was stored, is not delivered again.
	const delivered = (record.lastDeliveredSeq ?? 0) >= report.seq;
	if (!signal.aborted && !delivered && !deps.reports.take(record.runId, message)) deps.notify(message);
	return {
		// Stopped, and nothing of it runs any more; one that finished its work first was not cancelled.
		status: signal.aborted && outcome.status !== "completed" ? "cancelled" : "closed",
		summaryText: report.text,
		transcriptPath: state.sessionFile,
		...(outcome.status === "completed" ? {} : { errorMessage: `${cutReason(outcome.error)}${workspaceNote}` }),
	};
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** The run's own text, cut to `room` bytes from its end, saying where all of it is when cut. */
function boundedClaim(text: string, room: number, fullReport: string): string {
	if (bytes(text) <= room) return text;
	const cut = `\n[Cut short; its full Report: ${fullReport}]`;
	return `${truncateUtf8Safe(text, Math.max(0, room - bytes(cut))).text}${cut}`;
}

/** Why its work failed, as the runtime saw it: a pi's stderr can run long. */
function cutReason(error: string): string {
	const { text, truncated } = truncateUtf8Safe(error, MAX_REASON_BYTES);
	return truncated ? `${text} […]` : text;
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

/**
 * Waits for the run's host's process group to empty: the host, its pi and whatever the pi started there. What is left
 * after {@link STOP_GRACE_MS} is killed. Then, for a run with a shell, every process its commands started is ended,
 * found by its sandbox wherever it went. True once none of it runs; false when some still does even then.
 */
async function endHostGroup(hostPid: number, contained: RunContainment | undefined): Promise<boolean> {
	const gone = () => !processGroupAlive(hostPid);
	if (!(await until(gone, AbortSignal.timeout(STOP_GRACE_MS)))) {
		try {
			process.kill(-hostPid, "SIGKILL");
		} catch {
			// Gone meanwhile.
		}
		if (!(await until(gone, AbortSignal.timeout(KILL_WAIT_MS)))) return false;
	}
	return contained ? endRunProcesses(contained) : true;
}

/** The entries of the run's session, from its file; none before its pi wrote one. */
export function sessionFileEntries(sessionFile: string): SessionEntry[] | undefined {
	try {
		const entries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
		return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
	} catch {
		return undefined;
	}
}
