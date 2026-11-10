import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ExtensionContext,
	parseSessionEntries,
	SettingsManager,
	type ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import * as forkSettings from "../_shared/settings.ts";
import { evaluateSubagentDelegationDeny } from "../permissions/policy.ts";
import {
	type AgentDefinition,
	type AgentDefinitionCatalog,
	createInlineAgentDefinition,
	discoverAgentDefinitions,
	type InlineAgentRole,
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
import type { RpcDenyRules } from "./rpc-child.ts";
import { processAlive, readRpcHostState } from "./rpc-host.ts";
import {
	claimRunGeneration,
	narrowRunDefinition,
	type RpcLaunch,
	type RunDefinition,
	readRunDefinition,
	rpcDenyRules,
	rpcGrantableTools,
	rpcRunsEnabled,
	rpcRunTools,
	runDefinitionPath,
	WRITE_TOOLS,
} from "./rpc-runs.ts";
import { type RunWorkspace, resolveRunWorkspace } from "./run-workspace.ts";
import { captureRunBaseline, dropRunBaseline, type IsolatedWorkspace, worktreePath } from "./run-worktree.ts";
import {
	type AdmittedSubagentHandle,
	createRunId,
	isResumableSubagentStatus,
	type SubagentRunRecord,
	type SubagentRunScheduler,
	type WorkspaceSnapshot,
} from "./runs.ts";
import { ensureRunStorageDir, recordCountedSessionUsage, writeAtomicPrivateFile } from "./storage.ts";
import type { RunLaunch } from "./tmux-runs.ts";

export const MAX_TASK_INPUT_BYTES = 32 * 1024;
/** Recorded when no level is chosen: the run's pi picks its model's default. */
const MODEL_DEFAULT_THINKING = "model default";
/** How many runs an orchestrator holds open at once: each is a full pi. */
export const MAX_OPEN_RUNS = 8;
const QUEUE_DOWN = "the daemon that queues runs is not running and could not be started.";
const TOO_MANY_OPEN = `An orchestrator holds at most ${MAX_OPEN_RUNS} open subagents. Close one whose work is done with subagent_close, then try again.`;
/** Pi built-in extensions a run can be given like tools, when the orchestrator declares them. */
const BUILTIN_EXTENSIONS = ["codemode", "tool_search"];
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const NEEDS_TMUX =
	"Subagents need tmux: each run is a pi session of its own in agent view's tmux server, and this pi does not run there. Install tmux if it is missing (brew install tmux), then start pi again in a terminal.";

/** The tools a role may name: those the orchestrator can call, and the built-in extensions it declares. */
export function orchestratorTools(loadout: ToolLoadout): string[] {
	const declared = new Set(loadout.declared.map((tool) => tool.name));
	return [...loadout.callable.map((tool) => tool.name), ...BUILTIN_EXTENSIONS.filter((name) => declared.has(name))];
}

/**
 * What a run needs from its admission to execute: it starts as a pi of its own in tmux (ADR-0006), its role as its
 * launch flags, or, behind a switch, as a pi on pi's RPC (ADR-0010).
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

export const SUBAGENT_TOOL_PARAMETERS = Type.Object({
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
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description:
				"Accepted for compatibility, and ignored: whether a project's roles may run is the user's trust in that project, which no call can change.",
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

export type LaunchParams = Static<typeof SUBAGENT_TOOL_PARAMETERS>;

/** How a run is named in replies: its quoted name and run ID, or its quoted run ID when unnamed. */
export function formatRunLabel(run: Pick<SubagentRunRecord, "name" | "runId">): string {
	return run.name ? `"${run.name}" (${run.runId})` : `"${run.runId}"`;
}

export interface LaunchRequest {
	toolCallId: string;
	parentTurnId: string;
	params: LaunchParams;
	signal?: AbortSignal;
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
	/** Saved roles frozen at session start; discovered on demand when session start was skipped. */
	catalog: () => AgentDefinitionCatalog | undefined;
	parentThinkingLevel: () => string;
	scope: ParentScopeChecks;
	/** The orchestrator's tmux session, where its runs start as pis of their own; without one, none starts. */
	pane: () => string | undefined;
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
}

export interface RunAdmission {
	launch(request: LaunchRequest, ctx: AdmissionContext): Promise<AdmissionResult>;
	/**
	 * Admits a closed run's next generation. `buildPrompt` is called only once every check has
	 * passed, just before the run starts again. Without one, the run resumes for the user to type in.
	 */
	resume(
		run: Readonly<SubagentRunRecord>,
		buildPrompt: (() => string) | undefined,
		ctx: AdmissionContext,
		changes?: ResumeChanges,
	): Promise<AdmissionResult>;
	/**
	 * Takes over an open run this orchestrator's session started before a reload, its pi still running in its pane,
	 * into the current scope.
	 */
	adopt(run: Readonly<SubagentRunRecord>, ctx: AdmissionContext): void;
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

/** The inline role of the subagent call `toolCallId` on the orchestrator's branch. */
function launchedRole(toolCallId: string, ctx: AdmissionContext): AgentDefinition | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const call = entry.message.content.find((part) => part.type === "toolCall" && part.id === toolCallId);
		const agent = call?.type === "toolCall" ? call.arguments.agent : undefined;
		if (agent === undefined) continue;
		if (typeof agent !== "object" || agent === null || Array.isArray(agent)) return undefined;
		const role = createInlineAgentDefinition(agent as unknown as InlineAgentRole);
		return role.ok ? role.definition : undefined;
	}
	return undefined;
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
function invalidTaskText(task: string): string | undefined {
	if (!task.trim()) return "Missing required parameter: task";
	const bytes = Buffer.byteLength(task, "utf8");
	if (bytes <= MAX_TASK_INPUT_BYTES) return undefined;
	return `Delegated task exceeds the ${MAX_TASK_INPUT_BYTES}-byte limit (${bytes} bytes). Supply target file paths instead of pasting large file contents.`;
}

/** Why a call's model or thinking level cannot be what it names, before either is resolved. */
function invalidModelChoice({ model, thinkingLevel }: ResumeChanges): string | undefined {
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
		return resolved.ok ? resolved : { ...resolved, error: sanitizeDiagnosticText(resolved.error) };
	};

	/**
	 * A closed run, or a run known only from disk (an earlier instance's, or one from before runs were pis of their
	 * own), reopens its session as a pi in tmux, as its next generation in the current scope.
	 */
	const resumeInTmux = (
		run: Readonly<SubagentRunRecord>,
		parentPane: string,
		buildPrompt: (() => string) | undefined,
		ctx: AdmissionContext,
		refuse: { invalidated: AdmissionResult; unavailable: (error: string) => AdmissionResult },
	): AdmissionResult => {
		const label = formatRunLabel(run);
		const scope = deps.scope.current();
		const known = deps.scheduler.getRun(run.runId);
		if (!scope || !deps.scope.inScope(scope) || run.parentSessionId !== scope.parentSessionId) {
			return refuse.invalidated;
		}
		if (known && !deps.scope.inScope(known)) return refuse.invalidated;
		const current = known ?? run;
		if (!isResumableSubagentStatus(current.status)) {
			return refuse.unavailable(`${label} is ${current.status}; only a closed subagent can be resumed.`);
		}
		if (deps.directory.list(scope).length >= MAX_OPEN_RUNS) return refuse.unavailable(TOO_MANY_OPEN);
		const sessionFile = current.transcriptPath;
		if (!sessionFile || !existsSync(sessionFile))
			return refuse.unavailable(`${label} has no saved session to resume.`);
		const holder = current.name ? deps.directory.nameHolder(scope, current.name)?.record : undefined;
		if (holder) return refuse.unavailable(`${label} cannot resume: its name is now used by ${holder.runId}.`);
		const denied = deniedReason(current.agentName, ctx);
		if (denied) return refuse.unavailable(denied);
		const storage = ensureRunStorageDir(deps.agentDir(), current.parentSessionId, current.runId);
		if (!storage.ok) return refuse.unavailable(`Cannot resume ${label}: storage is unavailable (${storage.error}).`);
		// A run from before runs were pis of their own had its session's usage counted by its orchestrator already.
		if (!current.pane) recordCountedSessionUsage(deps.agentDir(), current.parentSessionId, sessionFile);
		const resumed = deps.scheduler.resume(
			current.runId,
			{ launch: { ...launchOf(current, storage.runDir, parentPane, ctx), task: buildPrompt?.() } },
			known ? undefined : { ...current, sessionEpoch: scope.sessionEpoch },
		);
		if (!resumed.ok) return refuse.unavailable(resumed.error);
		return { ok: true, handle: resumed.handle };
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
		const task = buildPrompt();
		const invalidTask = invalidTaskText(task);
		if (invalidTask) return refuse.unavailable(invalidTask);
		const model = { provider: childModel.model.provider, modelId: childModel.model.id, thinkingLevel };
		const definition: RunDefinition = {
			...narrowRunDefinition(admitted, grantable, deny.deny),
			projectTrusted: admitted.projectTrusted && workspace.workspace.trusted(cwd),
			admitted: model,
		};
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
					...(definition.workspace ? { workspace: definition.workspace } : {}),
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

	/** How the run is started again, as its record and its role say. */
	const launchOf = (
		run: Readonly<SubagentRunRecord>,
		runDir: string,
		parentPane: string,
		ctx: AdmissionContext,
	): RunLaunch => {
		const previous = deps.scheduler.getContext(run.runId);
		return {
			name: run.name ?? run.runId,
			definition: previous && "launch" in previous ? previous.launch.definition : roleOf(run, ctx),
			model: `${run.provider}/${run.modelId}`,
			thinkingLevel: run.thinkingLevel === MODEL_DEFAULT_THINKING ? undefined : run.thinkingLevel,
			cwd: run.cwd,
			runDir,
			sessionFile: run.transcriptPath,
			parent: parentPane,
			projectTrusted: ctx.isProjectTrusted(),
		};
	};

	/**
	 * The role a run known only from disk resumes with: an inline role as the call that launched it gave it, a saved
	 * role as it is now. One found in neither resumes with no instructions of its own and every tool.
	 */
	const roleOf = (run: Readonly<SubagentRunRecord>, ctx: AdmissionContext): AgentDefinition => {
		const inline = run.definitionSource === "inline" ? launchedRole(run.originToolCallId, ctx) : undefined;
		if (inline) return inline;
		const saved = resolveAgentDefinition(
			deps.catalog() ??
				discoverAgentDefinitions({
					cwd: ctx.cwd,
					agentDir: deps.agentDir(),
					projectTrusted: ctx.isProjectTrusted(),
				}),
			run.agentName,
		);
		if (saved.ok) return saved.definition;
		return {
			name: run.agentName,
			description: "",
			model: "inherit",
			instructions: "",
			source: run.definitionSource,
		};
	};

	return {
		async launch({ toolCallId, parentTurnId, params, signal }, ctx) {
			// A run is a pi of its own in tmux (ADR-0006), unless runs on pi's RPC are switched on.
			const rpc = rpcRunsEnabled();
			const parentPane = deps.pane();
			if (parentPane === undefined && !rpc) return reject(NEEDS_TMUX);
			const dispatched = deps.scope.current();
			if (!dispatched) return reject("Subagent runtime is not initialized for this session.");
			const parentSessionId = ctx.sessionManager.getSessionId();
			const originEntryId = ctx.sessionManager.getLeafId() ?? undefined;
			const agentDir = deps.agentDir();
			const projectTrusted = ctx.isProjectTrusted();
			const inlineRole = typeof params.agent === "string" ? undefined : params.agent;
			const agentName = (typeof params.agent === "string" ? params.agent : params.agent.name).trim();
			const taskText = params.task;
			const isBackground = params.background === true;

			if (!agentName && !inlineRole) return reject("Missing required parameter: agent");
			const invalidTask = invalidTaskText(taskText);
			if (invalidTask) return reject(invalidTask);

			const denied = deniedReason(agentName, ctx);
			if (denied) return reject(denied);

			// Background runs outlive one-shot (print/json) modes, whose process exits first.
			if (isBackground && (ctx.mode === "print" || ctx.mode === "json")) {
				return reject(
					`Background subagents are not supported in one-shot "${ctx.mode}" mode because the process exits before background completion. Omit background: true to run in the foreground.`,
				);
			}

			if (!rpc && (params.cwd !== undefined || params.agentScope !== undefined)) {
				return reject("A subagent's own cwd or agentScope needs runs on pi's RPC; omit them.");
			}
			let workspace: RunWorkspace | undefined;
			let deny: RpcDenyRules[] = [];
			if (rpc) {
				const resolved = resolveRunWorkspace(params.cwd, {
					cwd: ctx.cwd,
					projectTrusted,
					agentDir,
					denyRules: forkSettings.denyRules(SettingsManager.create(ctx.cwd, agentDir, { projectTrusted })),
				});
				if (!resolved.ok) return reject(resolved.error);
				workspace = resolved.workspace;
				const read = rpcDenyRules(agentDir, [
					{ cwd: ctx.cwd, trusted: projectTrusted },
					{ cwd: workspace.cwd, trusted: workspace.trusted(workspace.cwd) },
				]);
				if (!read.ok) return reject(read.error);
				deny = read.deny;
			}
			const cwd = workspace?.cwd ?? ctx.cwd;

			// An inline role is validated. A saved one is found from the run's own directory on pi's RPC, else in the
			// catalog frozen at session start.
			const resolvedDef = inlineRole
				? createInlineAgentDefinition(inlineRole)
				: resolveAgentDefinition(
						workspace
							? discoverAgentDefinitions({
									cwd,
									root: workspace.root,
									agentDir,
									projectTrusted: workspace.trusted,
									scope: params.agentScope,
								})
							: (deps.catalog() ?? discoverAgentDefinitions({ cwd, agentDir, projectTrusted })),
						agentName,
					);
			if (!resolvedDef.ok) {
				return reject(resolvedDef.error);
			}
			const definition = resolvedDef.definition;
			const available = rpc ? rpcGrantableTools(deps.tools(), deps.registeredTools()) : deps.tools();
			const rpcTools = rpc ? rpcRunTools(definition, available) : undefined;
			if (rpcTools && !rpcTools.ok) return reject(rpcTools.error);
			const unknownTools = definition.tools?.filter((name) => !available.includes(name)) ?? [];
			if (unknownTools.length > 0) {
				return reject(
					`Subagent role "${definition.name}" names tools the orchestrator cannot give a child: ${unknownTools.join(", ")}. Available: ${available.join(", ") || "none"}.`,
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
			const rpcThinkingLevel = explicitThinkingLevel ?? parentThinkingLevel;
			// On pi's RPC a level is resolved apart from the model, as the parent's when none is chosen. In tmux a chosen
			// model without a level gets the SDK's default for that model; an inherited one keeps the parent's.
			const requestedThinkingLevel = rpc || requestedModel === "inherit" ? rpcThinkingLevel : explicitThinkingLevel;
			const childModel = await resolveChildModel(requestedModel, requestedThinkingLevel, ctx);
			if (!childModel.ok) return reject(childModel.error);
			if (rpc && !(await deps.ensureQueue())) return reject(`Cannot launch subagent: ${QUEUE_DOWN}`);

			// Everything from here to admit runs without awaiting, so the session cannot change in between.
			if (
				dispatched.parentSessionId !== parentSessionId ||
				!deps.scope.inScope(dispatched) ||
				!deps.scope.onBranch(originEntryId)
			) {
				return reject("Parent session or branch changed before subagent admission; request cancelled.");
			}
			// Runs on pi's RPC have no such bound: those over the daemon's active ones wait in its queue.
			if (!rpc && deps.directory.list(dispatched).length >= MAX_OPEN_RUNS) return reject(TOO_MANY_OPEN);
			const startSnapshot = captureWorkspaceSnapshot(cwd);

			const holderOf = (name: string) => deps.directory.nameHolder(dispatched, name)?.record;
			const requestedName = params.name?.trim();
			if (requestedName !== undefined) {
				if (
					!AGENT_NAME_RE.test(requestedName) ||
					requestedName === PARENT_MESSAGE_ADDRESS ||
					requestedName.startsWith("sub_")
				) {
					return reject(
						`Invalid subagent name "${requestedName}": use lowercase letters, digits, "-" or "_", and not "${PARENT_MESSAGE_ADDRESS}" or a "sub_" prefix.`,
					);
				}
				const holder = holderOf(requestedName);
				if (holder) {
					return reject(
						`Subagent name "${requestedName}" is already used by running agent ${holder.runId}; choose another name.`,
					);
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

			// Prepared before admission, so a run that cannot store anything is never listed.
			const runId = createRunId();
			const storage = ensureRunStorageDir(agentDir, parentSessionId, runId);
			if (!storage.ok) {
				return reject(`Cannot launch subagent: storage is unavailable (${storage.error}).`);
			}
			const childTrusted = workspace?.trusted(cwd) ?? projectTrusted;
			// A run that edits works in a worktree of its own, made from the checkout as it is now, and never in the
			// checkout. It keeps the checkout's trust and deny rules: its files are the checkout's.
			let isolated: IsolatedWorkspace | undefined;
			let runCwd = cwd;
			if (rpcTools?.tools.some((tool) => WRITE_TOOLS.includes(tool))) {
				const captured = captureRunBaseline(cwd, runId);
				if (!captured.ok) {
					return reject(
						`Subagent role "${definition.name}" may edit files, so it works in an isolated Git worktree, and none can be made: ${captured.error}. A run that edits never works in a shared checkout: give it a cwd in a Git repository with a commit, or a role that only reads.`,
					);
				}
				isolated = { root: worktreePath(agentDir, runId), baseline: captured.baseline };
				runCwd = join(isolated.root, captured.cwd);
			}
			const refuseIsolated = (error: string): AdmissionResult => {
				if (isolated) dropRunBaseline(isolated.baseline);
				return reject(error);
			};
			if (rpcTools) {
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
			}

			const admitRes = deps.scheduler.admit({
				runId,
				parentSessionId,
				sessionEpoch: dispatched.sessionEpoch,
				parentTurnId,
				originToolCallId: toolCallId,
				originEntryId,
				name: runName,
				...(rpcTools ? { backend: "rpc" as const } : {}),
				agentName: definition.name,
				definitionSource: definition.source,
				provider: childModel.model.provider,
				modelId: childModel.model.id,
				thinkingLevel: childModel.thinkingLevel ?? MODEL_DEFAULT_THINKING,
				cwd: runCwd,
				taskSummary: summarizeTaskLabel(taskText),
				startSnapshot,
				deliveryMode: isBackground ? "background" : "foreground",
				// Cancelling a foreground call on pi's RPC cancels its run's work; one in tmux only stops waiting for its
				// Report. A run in the background goes on whatever becomes of the call.
				...(rpcTools && !isBackground && signal ? { signal } : {}),
				context: rpcTools
					? {
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
								recheck: recheckRpc(runId, storage.runDir, 0, { cwd: ctx.cwd, trusted: projectTrusted }),
							},
						}
					: {
							launch: {
								name: runName,
								definition,
								model: `${childModel.model.provider}/${childModel.model.id}`,
								thinkingLevel: childModel.thinkingLevel,
								task: taskText,
								cwd,
								runDir: storage.runDir,
								// Without a pane, a launch gets this far only with runs on pi's RPC switched on.
								parent: parentPane!,
								projectTrusted,
							},
						},
			});
			if (!admitRes.ok) return refuseIsolated(admitRes.error);
			return { ok: true, handle: admitRes.handle };
		},

		adopt(run, ctx) {
			const parentPane = deps.pane();
			const scope = deps.scope.current();
			const storage = ensureRunStorageDir(deps.agentDir(), run.parentSessionId, run.runId);
			if (!parentPane || !scope || !run.pane || !storage.ok) return;
			deps.scheduler.takeOver(
				{ ...run, sessionEpoch: scope.sessionEpoch },
				{ launch: { ...launchOf(run, storage.runDir, parentPane, ctx), pane: run.pane } },
			);
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
			if (run.backend === "rpc") return resumeOnRpc(run, buildPrompt, ctx, changes, { invalidated, unavailable });
			if (changes.model !== undefined || changes.thinkingLevel !== undefined) {
				return unavailable(`${label} runs in tmux, and resumes only with the model and level it had.`);
			}
			const parentPane = deps.pane();
			if (parentPane === undefined) return unavailable(NEEDS_TMUX);
			return resumeInTmux(run, parentPane, buildPrompt, ctx, { invalidated, unavailable });
		},
	};
}
