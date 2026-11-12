import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type ExtensionContext,
	parseSessionEntries,
	SettingsManager,
	type ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { processAlive } from "../../daemon/processes.ts";
import * as forkSettings from "../_shared/settings.ts";
import { evaluateSubagentDelegationDeny } from "../permissions/policy.ts";
import { prepareRunContainment } from "../sandbox/run-containment.ts";
import {
	createInlineAgentDefinition,
	discoverAgentDefinitions,
	isSubagentThinkingLevel,
	parseSubagentModelSpec,
	resolveAgentDefinition,
	SUBAGENT_THINKING_LEVELS,
	type SubagentModelSpec,
} from "./definitions.ts";
import { sanitizeDiagnosticText } from "./diagnostics.ts";
import type { RunDirectory } from "./directory.ts";
import { PARENT_MESSAGE_ADDRESS } from "./messages.ts";
import { resolveChildModelAndRuntime } from "./models.ts";
import type { ParentScopeChecks } from "./parent-scope.ts";
import { readRpcHostSpec, readRpcHostState } from "./rpc-host.ts";
import {
	claimRunGeneration,
	narrowRunDefinition,
	type RpcLaunch,
	type RunDefinition,
	readRunDefinition,
	rpcDenyRules,
	rpcGrantableTools,
	rpcRunMayShell,
	rpcRunProviderRefusal,
	rpcRunTools,
	runDefinitionPath,
	WORKTREE_TOOLS,
} from "./rpc-runs.ts";
import { resolveRunWorkspace, within } from "./run-workspace.ts";
import {
	captureRunBaseline,
	dropRunBaseline,
	type IsolatedWorkspace,
	restoreWorktree,
	worktreeInPlace,
	worktreePath,
	worktreeUnavailable,
} from "./run-worktree.ts";
import {
	type AdmittedSubagentHandle,
	createRunId,
	isResumableSubagentStatus,
	type SubagentRunRecord,
	type SubagentRunScheduler,
	type WorkspaceSnapshot,
} from "./runs.ts";
import { ensureRunStorageDir, writeAtomicPrivateFile } from "./storage.ts";
import type { RunLaunch } from "./tmux-runs.ts";

export const MAX_TASK_INPUT_BYTES = 32 * 1024;
/** Recorded when no level is chosen: the run's pi picks its model's default. */
const MODEL_DEFAULT_THINKING = "model default";
const QUEUE_DOWN = "the daemon that queues runs is not running and could not be started.";
/** Pi built-in extensions a run can be given like tools, when the orchestrator declares them. */
const BUILTIN_EXTENSIONS = ["codemode", "tool_search"];
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The tools a role may name: those the orchestrator can call, and the built-in extensions it declares. */
export function orchestratorTools(loadout: ToolLoadout): string[] {
	const declared = new Set(loadout.declared.map((tool) => tool.name));
	return [...loadout.callable.map((tool) => tool.name), ...BUILTIN_EXTENSIONS.filter((name) => declared.has(name))];
}

/**
 * What a run needs from its admission to execute: it starts as a pi on pi's RPC (ADR-0010). A run in tmux, from before
 * (ADR-0006), is only followed in its pane until it ends.
 */
export type RunExecutionContext = { launch: RunLaunch } | { rpc: RpcLaunch };

export function captureWorkspaceSnapshot(cwd: string): WorkspaceSnapshot {
	try {
		const headRes = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
			cwd,
			encoding: "utf8",
			timeout: 2000,
		});
		const headCommit = headRes.status === 0 ? headRes.stdout.trim() || null : null;

		const statusRes = spawnSync("git", ["status", "--porcelain=v1", "-uall"], {
			cwd,
			encoding: "utf8",
			timeout: 2000,
		});
		if (statusRes.status !== 0) {
			return { headCommit, dirty: false, statusDigest: "" };
		}
		const rawStatus = statusRes.stdout ?? "";
		const dirty = rawStatus.trim().length > 0;
		const statusDigest = dirty ? createHash("sha256").update(rawStatus).digest("hex").slice(0, 16) : "";
		return { headCommit, dirty, statusDigest };
	} catch {
		return { headCommit: null, dirty: false, statusDigest: "" };
	}
}

/** One Run's parameters: those of a single assignment, which a `tasks` entry shares in part. */
const RUN_PARAMETERS = Type.Object({
	agent: Type.Union([
		Type.String({
			description: "Saved subagent role name (for example 'explorer' or 'reviewer').",
		}),
		Type.Object(
			{
				name: Type.String({ description: "Run-local role name; never saved." }),
				description: Type.String({ description: "One-line purpose of this role." }),
				instructions: Type.String({ description: "System instructions for the child." }),
				tools: Type.Optional(Type.Array(Type.String())),
				model: Type.Optional(Type.String({ description: '"inherit" or "provider/model".' })),
				thinkingLevel: Type.Optional(Type.String({ description: "Default thinking level for this role." })),
			},
			{ additionalProperties: false, description: "Inline role used only for this run." },
		),
	]),
	name: Type.Optional(
		Type.String({
			description:
				'Unique name for this child among running agents, used to address it (lowercase letters, digits, "-", "_"). Defaults to "<role>-<n>".',
		}),
	),
	task: Type.String({
		description: "Self-contained task instructions with explicit file paths, symbols, or diff context (max 32 KiB).",
	}),
	cwd: Type.Optional(
		Type.String({
			description:
				"Directory the run works in: absolute, or relative to yours. Defaults to yours. Its project roles are found from there up to its repository root.",
		}),
	),
	agentScope: Type.Optional(
		Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
			description:
				'Which saved roles `agent` may name: "user" (yours and the bundled ones), "project" (the project\'s), or "both" (the default). Project roles need the user\'s trust in their project either way.',
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				'Model for this run: "provider/model" from subagent_models, or "inherit" for the parent model. Overrides the role.',
		}),
	),
	thinkingLevel: Type.Optional(
		Type.String({
			description: `Thinking level for this run (${SUBAGENT_THINKING_LEVELS.join(", ")}), or "inherit" for the parent level. Overrides the role.`,
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"When true, launch in the background and deliver the completed report back to this session branch. Only when you have independent work to do meanwhile.",
		}),
	),
});

/** What each entry of a `tasks` batch chooses for itself; the call's other parameters apply to every entry. */
const TASK_ENTRY_KEYS = ["agent", "task", "name", "cwd", "model", "thinkingLevel"] as const;
const run = RUN_PARAMETERS.properties;

export const SUBAGENT_TOOL_PARAMETERS = Type.Object({
	...run,
	agent: Type.Optional(run.agent),
	task: Type.Optional(run.task),
	tasks: Type.Optional(
		Type.Array(
			Type.Object(
				{
					agent: run.agent,
					task: run.task,
					name: run.name,
					cwd: run.cwd,
					model: run.model,
					thinkingLevel: run.thinkingLevel,
				},
				{ additionalProperties: false },
			),
			{
				minItems: 1,
				description:
					"Independent assignments to run side by side, in place of agent and task: each entry is a subagent of its own, with its own role, task, name, cwd, model and thinking level. The call waits for every one (unless background) and returns one combined report.",
			},
		),
	),
	chain: Type.Optional(
		Type.Array(
			Type.Object(
				{
					agent: Type.Optional(run.agent),
					resume: Type.Optional(
						Type.String({
							description:
								"In place of agent, name and cwd: the name of an earlier step of this chain, which goes on in its own session, with its context, role and workspace.",
						}),
					),
					task: run.task,
					name: run.name,
					cwd: run.cwd,
					model: run.model,
					thinkingLevel: run.thinkingLevel,
				},
				{ additionalProperties: false },
			),
			{
				minItems: 1,
				description:
					"Dependent steps to run one after another, in place of agent and task: each starts once the one before it completed, given that step's Report. When a step edits, every step works in one isolated worktree, one at a time. A failed, cancelled or blocked step halts the chain; a review that finds defects has completed. The call waits for the whole chain (unless background) and returns one combined report.",
			},
		),
	),
});

/** One Run's parameters: a single assignment's, or a `tasks` entry's with the call's own. */
export type LaunchParams = Static<typeof RUN_PARAMETERS>;
export type SubagentCallParams = Static<typeof SUBAGENT_TOOL_PARAMETERS>;

/** Prefix of a batch's ID, which no run's name may take. */
export const BATCH_ID_PREFIX = "batch_";
/** Prefix of a chain's ID, which no run's name may take. */
export const CHAIN_ID_PREFIX = "chain_";

/**
 * A step of a `chain`: a Run of its own, or the Resume of an earlier step's Run, by that step's index, with its next
 * instruction and any change of model or level.
 */
export type ChainStep =
	| { readonly run: LaunchParams }
	| { readonly resume: number; readonly task: string; readonly model?: string; readonly thinkingLevel?: string };

/**
 * What a subagent call asks for: one Run, a batch of independent ones, or a chain of dependent steps. Alternative
 * shapes are never combined.
 */
export type SubagentInvocation =
	| { readonly ok: true; readonly run: LaunchParams }
	| { readonly ok: true; readonly tasks: LaunchParams[] }
	| { readonly ok: true; readonly chain: ChainStep[] }
	| { readonly ok: false; readonly error: string };

export function subagentInvocation(params: SubagentCallParams): SubagentInvocation {
	const { tasks, chain, ...call } = params;
	if (tasks !== undefined && chain !== undefined) {
		return {
			ok: false,
			error: "`tasks` and `chain` are alternative shapes: give independent assignments as `tasks`, dependent steps as `chain`.",
		};
	}
	const shape = tasks !== undefined ? "tasks" : chain !== undefined ? "chain" : undefined;
	if (shape === undefined) {
		if (call.agent === undefined) return { ok: false, error: "Missing required parameter: agent" };
		if (call.task === undefined) return { ok: false, error: "Missing required parameter: task" };
		return { ok: true, run: { ...call, agent: call.agent, task: call.task } };
	}
	const conflicting = TASK_ENTRY_KEYS.filter((key) => call[key] !== undefined).map((key) => `\`${key}\``);
	if (conflicting.length > 0) {
		return {
			ok: false,
			error: `\`${shape}\` and ${conflicting.join(", ")} are alternative shapes: set ${conflicting.join(", ")} in each entry of \`${shape}\` instead, or leave \`${shape}\` out.`,
		};
	}
	const { agentScope, background } = call;
	if (tasks !== undefined) {
		return { ok: true, tasks: tasks.map((entry) => ({ ...entry, agentScope, background })) };
	}
	const steps: ChainStep[] = [];
	for (const [i, { resume, ...step }] of (chain ?? []).entries()) {
		if (resume === undefined) {
			if (step.agent === undefined) {
				return { ok: false, error: `chain[${i}]: give a step either \`agent\` or \`resume\`.` };
			}
			steps.push({ run: { ...step, agent: step.agent, agentScope, background } });
			continue;
		}
		const target = (chain ?? []).findIndex(
			(earlier, j) => j < i && earlier.resume === undefined && earlier.name?.trim() === resume.trim(),
		);
		if (target < 0) {
			return {
				ok: false,
				error: `chain[${i}]: \`resume\` names an earlier step of this chain by the name it was given, and no earlier step is named "${resume}".`,
			};
		}
		// Repeating the resumed step's role, name or cwd is harmless and ignored; only a different one is refused.
		const resumed = (chain ?? [])[target];
		const differing = (["agent", "name", "cwd"] as const).filter((key) =>
			key === "name"
				? step.name !== undefined && step.name.trim() !== resumed.name?.trim()
				: step[key] !== undefined && !isDeepStrictEqual(step[key], resumed[key]),
		);
		if (differing.length > 0) {
			const fields = differing.map((key) => `\`${key}\``).join(", ");
			return {
				ok: false,
				error: `chain[${i}]: a step that resumes an earlier one goes on with its role, name and cwd, and its ${fields} ${differing.length > 1 ? "differ" : "differs"} from chain[${target}]'s ("${resume}"): leave out ${fields}.`,
			};
		}
		const { task, model, thinkingLevel } = step;
		steps.push({ resume: target, task, ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) });
	}
	return { ok: true, chain: steps };
}

/** How a run is named in replies: its quoted name and run ID, or its quoted run ID when unnamed. */
export function formatRunLabel(run: Pick<SubagentRunRecord, "name" | "runId">): string {
	return run.name ? `"${run.name}" (${run.runId})` : `"${run.runId}"`;
}

/** Why a run cannot have the name `name`: the open run `holder` has it. */
export const nameTaken = (name: string, holder: Pick<SubagentRunRecord, "runId">): string =>
	`Subagent name "${name}" is already used by running agent ${holder.runId}`;

/**
 * Why a run in tmux, from before runs ran on pi's RPC, does not go on (ADR-0010): its work continues in a new run,
 * admitted afresh, pointed at its history.
 */
export function legacyRunRefusal(
	run: Pick<SubagentRunRecord, "name" | "runId" | "reportPath" | "transcriptPath">,
): string {
	return `${formatRunLabel(run)} ran in tmux, before runs ran on pi's RPC, and is not resumed. To continue its work, launch a new subagent and point it at its Report (${run.reportPath ?? "none was stored"}) and transcript (${run.transcriptPath ?? "none was stored"}).`;
}

export interface LaunchRequest {
	toolCallId: string;
	parentTurnId: string;
	params: LaunchParams;
	signal?: AbortSignal;
	/** The ID of the `tasks` batch the run is a member of. */
	batch?: string;
	/** The chain the run is a step of. */
	chain?: ChainPlacement;
	/**
	 * Awaited once the run passed every check, just before it is admitted, with where it would work and whether it
	 * edits: a batch's members are admitted together, or none is. False when a sibling was refused, and this run is not
	 * admitted either.
	 */
	ready?: (run: { cwd: string; root: string; writes: boolean }) => Promise<boolean>;
}

/** Where a step of a chain works, and the branch it is held to. */
export interface ChainPlacement {
	id: string;
	/**
	 * The worktree the chain's steps share, when one of them edits: "record" for the first step, whose Admission
	 * records it from the checkout as it is now; the worktree recorded, for each later step.
	 */
	workspace?: "record" | IsolatedWorkspace;
	/** The entry the chain was launched from, which a later step is held to; the current leaf when absent. */
	origin?: string;
	/** The ID the step's run gets, which its chain stored before admitting it. */
	runId?: string;
}

/** The parts of the calling tool's context admission reads. */
export type AdmissionContext = Pick<
	ExtensionContext,
	"cwd" | "mode" | "model" | "modelRegistry" | "isProjectTrusted"
> & {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getLeafId" | "getBranch">;
};

export interface RunAdmissionDeps {
	scheduler: Pick<
		SubagentRunScheduler<RunExecutionContext>,
		"admit" | "resume" | "takeOver" | "getRun" | "getContext"
	>;
	/** Which names the runs of a parent scope hold. */
	directory: Pick<RunDirectory, "nameHolder" | "list">;
	agentDir: () => string;
	parentThinkingLevel: () => string;
	scope: ParentScopeChecks;
	/** The orchestrator's tmux session, which takes over its runs in tmux from before runs ran on pi's RPC. */
	pane: () => string | undefined;
	/** The orchestrator's tmux session when its runs run in panes of their own (ADR-0013); none runs them on pi's RPC. */
	runPane: () => string | undefined;
	/** The tools the orchestrator has, which a role may name. */
	tools: () => readonly string[];
	/** Every tool the orchestrator's pi registered, active or not. */
	registeredTools: () => readonly string[];
	/** Starts the daemon whose queue runs on pi's RPC take their turn in; false when it cannot. */
	ensureQueue: () => Promise<boolean>;
}

export type AdmissionResult =
	| { readonly ok: true; readonly handle: AdmittedSubagentHandle }
	| {
			readonly ok: false;
			readonly error: string;
			/** Why a resume was refused: its session is gone, or the run cannot continue now. */
			readonly refusal?: "invalidated" | "unavailable";
	  };

/** A model or thinking level a Resume asks for in place of those the run had; "inherit" for the orchestrator's. */
export interface ResumeChanges {
	model?: string;
	thinkingLevel?: string;
	/** Set when the instruction is the user's own, given to the run directly, rather than its orchestrator's. */
	from?: "user";
	/** Set when the Resume is a step of the run's chain, which releases the worktree once the chain settles. */
	chainStep?: true;
	/** Set when the user opened the run to type its instruction in its pane: the Resume starts with no task. */
	typed?: true;
}

export interface RunAdmission {
	launch(request: LaunchRequest, ctx: AdmissionContext): Promise<AdmissionResult>;
	/**
	 * Admits a finished run's next generation on pi's RPC. `buildPrompt` is called only once every check has passed,
	 * just before the run starts again; without one, it is refused. A run in tmux from before is never resumed.
	 */
	resume(
		run: Readonly<SubagentRunRecord>,
		buildPrompt: (() => string) | undefined,
		ctx: AdmissionContext,
		changes?: ResumeChanges,
	): Promise<AdmissionResult>;
	/**
	 * Takes over an open run in tmux, from before runs ran on pi's RPC, that this orchestrator's session started before a
	 * reload, its pi still running in its pane, into the current scope: it is followed until it ends or is stopped.
	 */
	adopt(run: Readonly<SubagentRunRecord>): void;
	/**
	 * Takes over an open run on pi's RPC that an earlier instance of this session admitted and left behind (a reload or
	 * a crash), as its run directory stored it: false when that does not hold what it was launched with.
	 */
	recover(run: Readonly<SubagentRunRecord>, ctx: AdmissionContext): boolean;
}

/** Whether a saved session holds a conversation: pi would start a new one at a path without one, silently. */
function holdsConversation(sessionFile: string): boolean {
	try {
		return parseSessionEntries(readFileSync(sessionFile, "utf8")).some((entry) => entry.type === "message");
	} catch {
		return false;
	}
}

function summarizeTaskLabel(task: string): string {
	const firstLine =
		task
			.trim()
			.split("\n")
			.find((line) => line.trim().length > 0) ?? "";
	const compact = firstLine.replace(/\s+/g, " ").trim();
	return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact;
}

/** Why the parent's Subagent / Subagent(agentName) deny rules refuse a run, evaluated before any model activity. */
export function delegationDenied(
	agentName: string,
	cwd: string,
	agentDir: string,
	projectTrusted: boolean,
): string | undefined {
	const sm = SettingsManager.create(cwd, agentDir, { projectTrusted });
	const delegationDeny = evaluateSubagentDelegationDeny(forkSettings.denyRules(sm), agentName, cwd);
	return delegationDeny.blocked ? (delegationDeny.reason ?? "Blocked by permission rule") : undefined;
}

/** Why a run cannot be given `task`, a launch's or a Resume's instruction. */
export function invalidTaskText(task: string): string | undefined {
	if (!task.trim()) return "Missing required parameter: task";
	const bytes = Buffer.byteLength(task, "utf8");
	if (bytes <= MAX_TASK_INPUT_BYTES) return undefined;
	return `Delegated task exceeds the ${MAX_TASK_INPUT_BYTES}-byte limit (${bytes} bytes). Supply target file paths instead of pasting large file contents.`;
}

/** Why a run cannot be called `name`: it must not read as the orchestrator's address, a run ID or a batch ID. */
function invalidRunName(name: string): string | undefined {
	if (
		AGENT_NAME_RE.test(name) &&
		name !== PARENT_MESSAGE_ADDRESS &&
		!name.startsWith("sub_") &&
		!name.startsWith(BATCH_ID_PREFIX) &&
		!name.startsWith(CHAIN_ID_PREFIX)
	) {
		return undefined;
	}
	return `Invalid subagent name "${name}": use lowercase letters, digits, "-" or "_", and not "${PARENT_MESSAGE_ADDRESS}" or a "sub_", "${BATCH_ID_PREFIX}" or "${CHAIN_ID_PREFIX}" prefix.`;
}

/** Why a call's model or thinking level cannot be what it names, before either is resolved. */
export function invalidModelChoice({ model, thinkingLevel }: ResumeChanges): string | undefined {
	if (model !== undefined && !parseSubagentModelSpec(model)) {
		return `Invalid subagent "model" value "${model}": must be "inherit" or explicit "provider/model".`;
	}
	if (thinkingLevel !== undefined && thinkingLevel !== "inherit" && !isSubagentThinkingLevel(thinkingLevel)) {
		return `Invalid subagent "thinkingLevel" value "${thinkingLevel}": must be "inherit" or one of ${SUBAGENT_THINKING_LEVELS.join(", ")}.`;
	}
	return undefined;
}

export function createRunAdmission(deps: RunAdmissionDeps): RunAdmission {
	const autoNameCounters = new Map<string, number>();
	const reject = (error: string): AdmissionResult => ({ ok: false, error });

	const deniedReason = (agentName: string, ctx: AdmissionContext): string | undefined =>
		delegationDenied(agentName, ctx.cwd, deps.agentDir(), ctx.isProjectTrusted());

	const resolveChildModel = async (
		requestedModel: SubagentModelSpec,
		requestedThinkingLevel: string | undefined,
		ctx: AdmissionContext,
	) => {
		const resolved = await resolveChildModelAndRuntime({
			agentDir: deps.agentDir(),
			requestedModel,
			parentModel: ctx.model,
			requestedThinkingLevel,
			parentModelRegistry: ctx.modelRegistry,
		});
		if (!resolved.ok) return { ...resolved, error: sanitizeDiagnosticText(resolved.error) };
		const refused = rpcRunProviderRefusal(resolved.model.provider, ctx.modelRegistry.getRegisteredProviderIds());
		return refused ? { ok: false as const, error: refused } : resolved;
	};

	/**
	 * A closed run on pi's RPC reopens its saved session in a pi of its own, as its next generation, given an
	 * instruction. It is held to the role it was admitted with (definition.json), never to the role's file as it is
	 * now, and to no more than its orchestrator can give now: tools both allow, deny rules of either, trust both
	 * grant. It keeps its model and level unless the call changes them, and its workspace, which must still be there.
	 */
	const resumeOnRpc = async (
		run: Readonly<SubagentRunRecord>,
		buildPrompt: (() => string) | undefined,
		ctx: AdmissionContext,
		changes: ResumeChanges,
		refuse: { invalidated: AdmissionResult; unavailable: (error: string) => AdmissionResult },
	): Promise<AdmissionResult> => {
		const label = formatRunLabel(run);
		const cannot = (why: string) => refuse.unavailable(`Cannot resume ${label}: ${why}`);
		const scope = deps.scope.current();
		const known = deps.scheduler.getRun(run.runId);
		const current = known ?? run;
		const inScope = () =>
			scope !== undefined &&
			deps.scope.inScope(scope) &&
			current.parentSessionId === scope.parentSessionId &&
			(!known || deps.scope.inScope(known)) &&
			deps.scope.onBranch(current.originEntryId);
		if (!scope || !inScope()) return refuse.invalidated;
		if (!isResumableSubagentStatus(current.status)) {
			return refuse.unavailable(
				`${label} is ${current.status}; only a finished or stopped subagent can be resumed.`,
			);
		}
		if (!buildPrompt) return cannot("a Resume needs an instruction for it.");
		const invalid = invalidModelChoice(changes);
		if (invalid) return refuse.unavailable(invalid);
		const denied = deniedReason(current.agentName, ctx);
		if (denied) return refuse.unavailable(denied);
		const agentDir = deps.agentDir();
		const storage = ensureRunStorageDir(agentDir, current.parentSessionId, current.runId);
		if (!storage.ok) return cannot(`storage is unavailable (${storage.error}).`);
		const { runDir } = storage;
		const admitted = readRunDefinition(runDefinitionPath(runDir, 0));
		if (!admitted) return cannot("the role it was admitted with is not stored.");
		const sessionFile = current.transcriptPath;
		if (!sessionFile || !holdsConversation(sessionFile)) return cannot("it has no saved conversation to go on with.");
		const host = readRpcHostState(runDir);
		if (host && host.exit === undefined && processAlive(host.hostPid)) {
			return cannot("its pi from before is still running.");
		}
		// A run that edits resumes in its own worktree exactly, made again if it was removed holding only its baseline.
		if (admitted.workspace) {
			const lost = await restoreWorktree(admitted.workspace, { agentDir, runId: current.runId, runDir });
			if (lost) {
				return cannot(
					`${lost}. It resumes only in its own workspace, never in the checkout as it is now; its transcript and Reports are kept: spawn a new subagent and point it at ${current.reportPath ?? "its report"}.`,
				);
			}
		}

		const projectTrusted = ctx.isProjectTrusted();
		const workspace = resolveRunWorkspace(admitted.cwd, {
			cwd: ctx.cwd,
			projectTrusted,
			agentDir,
			denyRules: forkSettings.denyRules(SettingsManager.create(ctx.cwd, agentDir, { projectTrusted })),
		});
		if (!workspace.ok || workspace.workspace.cwd !== admitted.cwd) {
			return cannot(
				`its workspace ${admitted.cwd} is no longer available (${workspace.ok ? `it now leads to ${workspace.workspace.cwd}` : workspace.error}). It resumes only in its own workspace; spawn a new subagent and point it at ${current.reportPath ?? "its report"}.`,
			);
		}
		const { cwd } = admitted;
		const grantable = rpcGrantableTools(deps.tools(), deps.registeredTools());
		if (narrowRunDefinition(admitted, grantable, []).tools.includes("bash")) {
			const shell = await prepareRunContainment();
			if (!shell.ok) return cannot(`it runs commands, and a run gets no shell here: ${shell.reason}.`);
		}
		const deny = rpcDenyRules(agentDir, [
			{ cwd: ctx.cwd, trusted: projectTrusted },
			{ cwd, trusted: workspace.workspace.trusted(cwd) },
		]);
		if (!deny.ok) return refuse.unavailable(deny.error);

		// Model and level each as the call asks, else as the run's latest generation had them.
		const prior = readRunDefinition(runDefinitionPath(runDir, current.generation))?.admitted ?? admitted.admitted;
		const thinkingLevel =
			changes.thinkingLevel === "inherit"
				? deps.parentThinkingLevel()
				: (changes.thinkingLevel ?? prior.thinkingLevel);
		const requestedModel: SubagentModelSpec =
			changes.model === undefined
				? `${prior.provider}/${prior.modelId}`
				: (parseSubagentModelSpec(changes.model) ?? "inherit");
		const childModel = await resolveChildModel(requestedModel, thinkingLevel, ctx);
		if (!childModel.ok) return refuse.unavailable(childModel.error);
		if (!(await deps.ensureQueue())) return cannot(QUEUE_DOWN);

		// Everything from here to the resume runs without awaiting, so the session cannot change in between.
		const latest = deps.scheduler.getRun(run.runId) ?? current;
		if (deps.scope.current()?.sessionEpoch !== scope.sessionEpoch || !inScope()) return refuse.invalidated;
		if (!isResumableSubagentStatus(latest.status) || latest.generation !== current.generation) {
			return cannot("another Resume of it started meanwhile.");
		}
		const holder = current.name ? deps.directory.nameHolder(scope, current.name)?.record : undefined;
		if (holder) return refuse.unavailable(`${label} cannot resume: its name is now used by ${holder.runId}.`);
		const root = admitted.workspace?.root;
		const occupant = root && deps.directory.list(scope).find(({ record }) => within(root, record.cwd))?.record;
		if (occupant) {
			return cannot(
				`its worktree ${root} is in use by ${formatRunLabel(occupant)}: no two runs work in one worktree at once.`,
			);
		}
		// One the user types in its pane has no task until they do.
		const typed = changes.typed === true && deps.runPane() !== undefined;
		const task = typed ? "" : buildPrompt();
		const invalidTask = typed ? undefined : invalidTaskText(task);
		if (invalidTask) return refuse.unavailable(invalidTask);
		const model = { provider: childModel.model.provider, modelId: childModel.model.id, thinkingLevel };
		const definition: RunDefinition = {
			...narrowRunDefinition(admitted, grantable, deny.deny),
			projectTrusted: admitted.projectTrusted && workspace.workspace.trusted(cwd),
			admitted: model,
		};
		if (admitted.workspace && !worktreeInPlace(admitted.workspace, runDir)) {
			return cannot("its worktree was cleaned up meanwhile.");
		}
		const generation = current.generation + 1;
		try {
			if (!claimRunGeneration(runDir, generation, definition)) {
				return cannot(`another Resume of it already started its generation ${generation}.`);
			}
		} catch (error) {
			return cannot(`storage is unavailable (${error instanceof Error ? error.message : String(error)}).`);
		}
		const resumed = deps.scheduler.resume(
			current.runId,
			{
				rpc: {
					name: current.name ?? current.runId,
					definition,
					...model,
					tools: definition.tools,
					task,
					cwd,
					runDir,
					agentDir,
					projectTrusted: definition.projectTrusted,
					sessionFile,
					...(changes.from ? { taskFrom: changes.from } : {}),
					...(changes.chainStep ? { keepWorktree: true } : {}),
					...(definition.workspace ? { workspace: definition.workspace } : {}),
					...paneOf(),
					...(typed ? { typed: true as const } : {}),
					recheck: recheckRpc(current.runId, runDir, generation, { cwd: ctx.cwd, trusted: projectTrusted }),
				},
			},
			known ? undefined : { ...current, sessionEpoch: scope.sessionEpoch },
			model,
		);
		if (!resumed.ok) return refuse.unavailable(resumed.error);
		return { ok: true, handle: resumed.handle };
	};

	/**
	 * Why a run on pi's RPC, admitted with orchestrator `parent`'s directory and trust, may no longer start once its
	 * turn in the queue comes: its scope or branch is gone, or its delegation is denied now. What its orchestrator
	 * can no longer give, or now denies, is stored in the generation's definition, which its pi enforces.
	 */
	/** A generation runs in a pane of its own while its orchestrator runs in one (ADR-0013), else on pi's RPC. */
	const paneOf = (): { parentPane?: string } => {
		const parentPane = deps.runPane();
		return parentPane ? { parentPane } : {};
	};

	const recheckRpc =
		(runId: string, runDir: string, generation: number, parent: { cwd: string; trusted: boolean }) =>
		(): string | undefined => {
			const run = deps.scheduler.getRun(runId);
			if (!run || !deps.scope.inScope(run) || !deps.scope.onBranch(run.originEntryId)) {
				return "its orchestrator's session or branch changed since it was admitted";
			}
			const agentDir = deps.agentDir();
			const denied = delegationDenied(run.agentName, parent.cwd, agentDir, parent.trusted);
			if (denied) return denied;
			const path = runDefinitionPath(runDir, generation);
			const definition = readRunDefinition(path);
			if (!definition) return "the definition it was admitted with is not stored";
			const deny = rpcDenyRules(agentDir, [parent, { cwd: definition.cwd, trusted: definition.projectTrusted }]);
			if (!deny.ok) return deny.error;
			const narrowed = narrowRunDefinition(
				definition,
				rpcGrantableTools(deps.tools(), deps.registeredTools()),
				deny.deny,
			);
			if (JSON.stringify(narrowed) === JSON.stringify(definition)) return undefined;
			try {
				writeAtomicPrivateFile(path, JSON.stringify(narrowed, null, 2));
			} catch (error) {
				return `storage is unavailable (${error instanceof Error ? error.message : String(error)})`;
			}
			return undefined;
		};

	return {
		async launch({ toolCallId, parentTurnId, params, signal, batch, chain, ready }, ctx) {
			const dispatched = deps.scope.current();
			if (!dispatched) return reject("Subagent runtime is not initialized for this session.");
			const parentSessionId = ctx.sessionManager.getSessionId();
			const originEntryId = chain?.origin ?? ctx.sessionManager.getLeafId() ?? undefined;
			const agentDir = deps.agentDir();
			const projectTrusted = ctx.isProjectTrusted();
			const inlineRole = typeof params.agent === "string" ? undefined : params.agent;
			const agentName = (typeof params.agent === "string" ? params.agent : params.agent.name).trim();
			const taskText = params.task;
			const isBackground = params.background === true;

			if (!agentName && !inlineRole) return reject("Missing required parameter: agent");
			const invalidTask = invalidTaskText(taskText);
			if (invalidTask) return reject(invalidTask);
			const requestedName = params.name?.trim();
			const invalidName = requestedName === undefined ? undefined : invalidRunName(requestedName);
			if (invalidName) return reject(invalidName);

			const denied = deniedReason(agentName, ctx);
			if (denied) return reject(denied);

			// Background runs outlive one-shot (print/json) modes, whose process exits first.
			if (isBackground && (ctx.mode === "print" || ctx.mode === "json")) {
				return reject(
					`Background subagents are not supported in one-shot "${ctx.mode}" mode because the process exits before background completion. Omit background: true to run in the foreground.`,
				);
			}

			const resolved = resolveRunWorkspace(params.cwd, {
				cwd: ctx.cwd,
				projectTrusted,
				agentDir,
				denyRules: forkSettings.denyRules(SettingsManager.create(ctx.cwd, agentDir, { projectTrusted })),
			});
			if (!resolved.ok) return reject(resolved.error);
			const { workspace } = resolved;
			const read = rpcDenyRules(agentDir, [
				{ cwd: ctx.cwd, trusted: projectTrusted },
				{ cwd: workspace.cwd, trusted: workspace.trusted(workspace.cwd) },
			]);
			if (!read.ok) return reject(read.error);
			const { deny } = read;
			const { cwd } = workspace;

			// An inline role is validated. A saved one is found from the run's own directory.
			const resolvedDef = inlineRole
				? createInlineAgentDefinition(inlineRole)
				: resolveAgentDefinition(
						discoverAgentDefinitions({
							cwd,
							root: workspace.root,
							agentDir,
							projectTrusted: workspace.trusted,
							scope: params.agentScope,
						}),
						agentName,
					);
			if (!resolvedDef.ok) {
				return reject(resolvedDef.error);
			}
			const definition = resolvedDef.definition;
			const available = rpcGrantableTools(deps.tools(), deps.registeredTools());
			// Whether a run's commands can be contained here is known before it is given a shell.
			const shell = rpcRunMayShell(definition) ? await prepareRunContainment() : undefined;
			const rpcTools = rpcRunTools(definition, available, shell);
			if (!rpcTools.ok) return reject(rpcTools.error);
			const writes = rpcTools.tools.some((tool) => WORKTREE_TOOLS.includes(tool));
			const cannotIsolate = (why: string) =>
				reject(
					`Subagent role "${definition.name}" may edit files or run commands, so it works in an isolated Git worktree, and none can be made: ${why}. Such a run never works in a shared checkout: give it a cwd in a Git repository with a commit, or a role that only reads.`,
				);
			// A step of a chain whose steps share a worktree works in it, whether it edits or not.
			const shared = chain?.workspace;
			// Known before a batch's members are admitted together, unlike what recording the checkout may still find.
			const unisolated = writes || shared === "record" ? worktreeUnavailable(cwd) : undefined;
			if (unisolated) return cannotIsolate(unisolated);
			if (typeof shared === "object" && !within(shared.baseline.source, cwd)) {
				return reject(
					`Subagent cwd ${cwd} is outside ${shared.baseline.source}, the repository the worktree of its chain was made from: the steps of a chain work in that one worktree.`,
				);
			}

			// Spawn > role > parent for the model and thinking level, verified before admission.
			const invalid = invalidModelChoice(params);
			if (invalid) return reject(invalid);
			const spawnModel = params.model === undefined ? undefined : parseSubagentModelSpec(params.model);
			const parentThinkingLevel = deps.parentThinkingLevel();
			const requestedModel = spawnModel ?? definition.model;
			const explicitThinkingLevel =
				params.thinkingLevel === "inherit"
					? parentThinkingLevel
					: (params.thinkingLevel ?? definition.thinkingLevel);
			// A level is resolved apart from the model, as the parent's when none is chosen.
			const rpcThinkingLevel = explicitThinkingLevel ?? parentThinkingLevel;
			const childModel = await resolveChildModel(requestedModel, rpcThinkingLevel, ctx);
			if (!childModel.ok) {
				const inherited = explicitThinkingLevel === undefined && childModel.error.startsWith("Thinking level");
				return reject(
					inherited
						? `${childModel.error} That level is yours, inherited as neither the call nor the role sets one: set thinkingLevel ("off" for a model that does not reason).`
						: childModel.error,
				);
			}
			if (!(await deps.ensureQueue())) return reject(`Cannot launch subagent: ${QUEUE_DOWN}`);
			if (ready && !(await ready({ cwd, root: workspace.root, writes }))) {
				return reject("Not admitted: another member of its batch was refused.");
			}

			// Everything from here to admit runs without awaiting, so the session cannot change in between.
			if (
				dispatched.parentSessionId !== parentSessionId ||
				!deps.scope.inScope(dispatched) ||
				!deps.scope.onBranch(originEntryId)
			) {
				return reject("Parent session or branch changed before subagent admission; request cancelled.");
			}
			const startSnapshot = captureWorkspaceSnapshot(cwd);

			const holderOf = (name: string) => deps.directory.nameHolder(dispatched, name)?.record;
			if (requestedName !== undefined) {
				const holder = holderOf(requestedName);
				if (holder) {
					return reject(`${nameTaken(requestedName, holder)}; choose another name.`);
				}
			}
			let runName = requestedName;
			while (!runName || holderOf(runName)) {
				const key = `${parentSessionId}:${definition.name}`;
				const next = (autoNameCounters.get(key) ?? 0) + 1;
				autoNameCounters.set(key, next);
				runName = `${definition.name}-${next}`;
			}

			if (signal?.aborted) return reject("Subagent request was aborted before admission.");
			// A worktree has one run in it at a time: the step before hands it on by ending.
			const occupant =
				typeof shared === "object" &&
				deps.directory.list(dispatched).find(({ record }) => within(shared.root, record.cwd))?.record;
			if (occupant) {
				return reject(
					`The worktree of its chain, ${shared.root}, is in use by ${formatRunLabel(occupant)}: no two runs work in one worktree at once.`,
				);
			}

			// Prepared before admission, so a run that cannot store anything is never listed.
			const runId = chain?.runId ?? createRunId();
			const storage = ensureRunStorageDir(agentDir, parentSessionId, runId);
			if (!storage.ok) {
				return reject(`Cannot launch subagent: storage is unavailable (${storage.error}).`);
			}
			const childTrusted = workspace.trusted(cwd);
			// A run that edits works in a worktree of its own, made from the checkout as it is now, and never in the
			// checkout. It keeps the checkout's trust and deny rules: its files are the checkout's.
			let isolated: IsolatedWorkspace | undefined;
			let runCwd = cwd;
			if (typeof shared === "object") {
				isolated = shared;
				// As it resolves now: a step before may have made a link of it, which leads out of the worktree.
				let step: string;
				try {
					step = realpathSync(join(shared.root, relative(shared.baseline.source, cwd)));
				} catch {
					return reject(
						`Subagent cwd ${cwd} is not in the worktree of its chain, ${shared.root}: the worktree was removed, or the directory is ignored or held no file when the chain began.`,
					);
				}
				if (!within(realpathSync(shared.root), step)) {
					return reject(
						`Subagent cwd ${cwd} is not in the worktree of its chain, ${shared.root}: there, it leads to ${step}. A step works only in its chain's worktree.`,
					);
				}
				runCwd = step;
			} else if (writes || shared === "record") {
				const captured = captureRunBaseline(cwd, runId);
				if (!captured.ok) return cannotIsolate(captured.error);
				isolated = { root: worktreePath(agentDir, runId), baseline: captured.baseline };
				runCwd = join(isolated.root, captured.cwd);
			}
			const refuseIsolated = (error: string): AdmissionResult => {
				// A chain's worktree recorded by an earlier step stays its chain's.
				if (isolated && typeof shared !== "object") dropRunBaseline(isolated.baseline);
				return reject(error);
			};
			// The role as admitted, with what it may do and the model and level it runs at: what the run, and any later
			// continuation of it, is held to.
			const admitted = {
				provider: childModel.model.provider,
				modelId: childModel.model.id,
				thinkingLevel: rpcThinkingLevel,
			};
			try {
				writeAtomicPrivateFile(
					join(storage.runDir, "definition.json"),
					JSON.stringify(
						{
							...definition,
							tools: rpcTools.tools,
							deny,
							cwd: runCwd,
							projectTrusted: childTrusted,
							admitted,
							...(isolated ? { workspace: isolated } : {}),
							...(rpcTools.tools.includes("bash") ? { shell: { runId, runDir: storage.runDir } } : {}),
						},
						null,
						2,
					),
				);
			} catch (error) {
				return refuseIsolated(
					`Cannot launch subagent: storage is unavailable (${error instanceof Error ? error.message : String(error)}).`,
				);
			}

			const admitRes = deps.scheduler.admit({
				runId,
				parentSessionId,
				sessionEpoch: dispatched.sessionEpoch,
				parentTurnId,
				originToolCallId: toolCallId,
				originEntryId,
				name: runName,
				backend: "rpc",
				agentName: definition.name,
				definitionSource: definition.source,
				provider: childModel.model.provider,
				modelId: childModel.model.id,
				thinkingLevel: childModel.thinkingLevel ?? MODEL_DEFAULT_THINKING,
				cwd: runCwd,
				taskSummary: summarizeTaskLabel(taskText),
				startSnapshot,
				deliveryMode: isBackground ? "background" : "foreground",
				...(batch ? { batch } : {}),
				...(chain ? { chain: chain.id } : {}),
				// Cancelling a foreground call cancels its run's work. A run in the background goes on whatever becomes of
				// the call.
				...(!isBackground && signal ? { signal } : {}),
				context: {
					rpc: {
						name: runName,
						definition,
						provider: childModel.model.provider,
						modelId: childModel.model.id,
						thinkingLevel: rpcThinkingLevel,
						tools: rpcTools.tools,
						task: taskText,
						cwd: runCwd,
						runDir: storage.runDir,
						agentDir,
						projectTrusted: childTrusted,
						...(isolated ? { workspace: isolated } : {}),
						...(typeof shared === "object" ? { worktreeMade: true } : {}),
						...(chain ? { keepWorktree: true } : {}),
						...paneOf(),
						recheck: recheckRpc(runId, storage.runDir, 0, { cwd: ctx.cwd, trusted: projectTrusted }),
					},
				},
			});
			if (!admitRes.ok) return refuseIsolated(admitRes.error);
			return { ok: true, handle: admitRes.handle };
		},

		adopt(run) {
			const parentPane = deps.pane();
			const scope = deps.scope.current();
			const storage = ensureRunStorageDir(deps.agentDir(), run.parentSessionId, run.runId);
			if (!parentPane || !scope || !run.pane || !storage.ok) return;
			deps.scheduler.takeOver(
				{ ...run, sessionEpoch: scope.sessionEpoch },
				{ launch: { runDir: storage.runDir, sessionFile: run.transcriptPath, parent: parentPane, pane: run.pane } },
			);
		},

		recover(run, ctx) {
			const scope = deps.scope.current();
			const agentDir = deps.agentDir();
			const storage = ensureRunStorageDir(agentDir, run.parentSessionId, run.runId);
			if (!scope || !storage.ok) return false;
			const { runDir } = storage;
			// As admitted, frozen before it queued: its role, grants and model, and what its host starts.
			const definition = readRunDefinition(runDefinitionPath(runDir, run.generation));
			const spec = readRpcHostSpec(runDir);
			if (!definition || spec?.generation !== run.generation) return false;
			const { workspace } = definition;
			// A run in a pane follows its orchestrator to the pane its session runs in now (ADR-0008): its spec says which.
			const pane = spec.pane && { ...spec.pane, parent: deps.pane() ?? spec.pane.parent };
			deps.scheduler.takeOver(
				{ ...run, sessionEpoch: scope.sessionEpoch },
				{
					rpc: {
						name: run.name ?? run.runId,
						definition,
						provider: spec.model.provider,
						modelId: spec.model.id,
						thinkingLevel: spec.model.thinkingLevel,
						tools: definition.tools,
						task: "",
						cwd: definition.cwd,
						runDir,
						agentDir,
						projectTrusted: definition.projectTrusted,
						...(spec.sessionFile ? { sessionFile: spec.sessionFile } : {}),
						// A later step of a chain works in the worktree its first step made, named after that step's run.
						...(workspace
							? { workspace, ...(basename(workspace.root) !== run.runId ? { worktreeMade: true } : {}) }
							: {}),
						...(run.chain ? { keepWorktree: true } : {}),
						...(pane ? { parentPane: pane.parent } : {}),
						recovered: pane ? { ...spec, pane } : spec,
						// Not yet started, it starts only once the session that returned may still start it, as at any turn.
						recheck: recheckRpc(run.runId, runDir, run.generation, {
							cwd: ctx.cwd,
							trusted: ctx.isProjectTrusted(),
						}),
					},
				},
			);
			return true;
		},

		async resume(run, buildPrompt, ctx, changes = {}) {
			const label = formatRunLabel(run);
			const invalidated: AdmissionResult = {
				ok: false,
				refusal: "invalidated",
				error: `${label} belongs to a session that was replaced; spawn a new subagent and point it at ${run.reportPath ?? "the earlier report"}.`,
			};
			const unavailable = (error: string): AdmissionResult => ({ ok: false, refusal: "unavailable", error });
			if (ctx.mode === "print" || ctx.mode === "json") {
				return unavailable(
					`Resuming ${label} is not supported in one-shot "${ctx.mode}" mode because a resume runs in the background and the process exits before it completes.`,
				);
			}
			if (run.backend !== "rpc") return unavailable(legacyRunRefusal(run));
			return resumeOnRpc(run, buildPrompt, ctx, changes, { invalidated, unavailable });
		},
	};
}
