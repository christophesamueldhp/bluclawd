import { readFileSync, realpathSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
	type ExtensionContext,
	parseSessionEntries,
	SettingsManager,
	type ToolLoadout,
} from "@earendil-works/pi-coding-agent";
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
import {
	admitGeneration,
	generationDefinition,
	generationState,
	narrowGeneration,
	runProcessesLeft,
} from "./generation-state.ts";
import type { LaunchParams } from "./invocation.ts";
import { PARENT_MESSAGE_ADDRESS } from "./messages.ts";
import { resolveChildModelAndRuntime } from "./models.ts";
import type { ParentScope, ParentScopeChecks } from "./parent-scope.ts";
import {
	narrowRunDefinition,
	type RpcLaunch,
	type RunDefinition,
	rpcDenyRules,
	rpcGrantableTools,
	rpcRunMayShell,
	rpcRunProviderRefusal,
	rpcRunTools,
	WORKTREE_TOOLS,
} from "./rpc-runs.ts";
import { captureWorkspaceSnapshot, resolveRunWorkspace, within } from "./run-workspace.ts";
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
	formatRunLabel,
	isResumableSubagentStatus,
	type SubagentRunRecord,
	type SubagentRunScheduler,
} from "./runs.ts";
import { ensureRunStorageDir } from "./storage.ts";
import { legacyRunRefusal, type RunLaunch } from "./tmux-runs.ts";

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

/** Prefix of a batch's ID, which no run's name may take. */
export const BATCH_ID_PREFIX = "batch_";
/** Prefix of a chain's ID, which no run's name may take. */
export const CHAIN_ID_PREFIX = "chain_";

/** Why a run cannot have the name `name`: the open run `holder` has it. */
export const nameTaken = (name: string, holder: Pick<SubagentRunRecord, "runId">): string =>
	`Subagent name "${name}" is already used by running agent ${holder.runId}`;

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
	/**
	 * The orchestrator's tmux session, which takes over its runs in tmux from before runs ran on pi's RPC, and becomes the
	 * orchestrator pane of the runs in panes it recovers.
	 */
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

/** What Admission's checks are run for, whether a launch or a Resume, and how it is refused. */
interface Entry {
	scope: ParentScope;
	agentName: string;
	/** Whether the orchestrator's session and branch are still those the run was asked for in. */
	inScope(): boolean;
	refuse(error: string): AdmissionResult;
	/** Refuses, saying the run cannot be launched or resumed, and why. */
	cannot(why: string): AdmissionResult;
	/** The refusal once the orchestrator's session or branch changed meanwhile. */
	invalidated: AdmissionResult;
}

/** A launch: its run's role is resolved afresh. */
interface LaunchEntry extends Entry {
	kind: "launch";
	launch: LaunchRequest;
	requestedName: string | undefined;
	parentSessionId: string;
	originEntryId: string | undefined;
}

/** A Resume: its run is held to the definition frozen at its Admission, which it may not widen (ADR-0010). */
interface ResumeEntry extends Entry {
	kind: "resume";
	run: Readonly<SubagentRunRecord>;
	label: string;
	/** Whether this instance of the session already knows the run. */
	known: boolean;
	buildPrompt: () => string;
	changes: ResumeChanges;
}

/** What a Resume goes on from: its run directory, the definition its run was admitted with, and its saved session. */
interface ResumedFrom {
	runDir: string;
	admitted: RunDefinition;
	sessionFile: string;
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
	 * What a Resume goes on from: the role its run was admitted with (definition.json), never the role's file as it
	 * is now, its saved session, and its workspace, which must still be there.
	 */
	const resumedFrom = async (entry: ResumeEntry): Promise<AdmissionResult | (ResumeEntry & ResumedFrom)> => {
		const { run: current, cannot } = entry;
		const agentDir = deps.agentDir();
		const storage = ensureRunStorageDir(agentDir, current.parentSessionId, current.runId);
		if (!storage.ok) return cannot(`storage is unavailable (${storage.error}).`);
		const { runDir } = storage;
		const admitted = generationDefinition(runDir, 0);
		if (!admitted) return cannot("the role it was admitted with is not stored.");
		const sessionFile = current.transcriptPath;
		if (!sessionFile || !holdsConversation(sessionFile)) return cannot("it has no saved conversation to go on with.");
		if (runProcessesLeft(runDir)) return cannot("its pi from before is still running.");
		// A run that edits resumes in its own worktree exactly, made again if it was removed holding only its baseline.
		if (admitted.workspace) {
			const lost = await restoreWorktree(admitted.workspace, { agentDir, runId: current.runId, runDir });
			if (lost) {
				return cannot(
					`${lost}. It resumes only in its own workspace, never in the checkout as it is now; its transcript and Reports are kept: spawn a new subagent and point it at ${current.reportPath ?? "its report"}.`,
				);
			}
		}
		return { ...entry, runDir, admitted, sessionFile };
	};

	/** A generation runs in a pane of its own while its orchestrator runs in one (ADR-0013), else on pi's RPC. */
	const paneOf = (): { parentPane?: string } => {
		const parentPane = deps.runPane();
		return parentPane ? { parentPane } : {};
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
			const definition = generationDefinition(runDir, generation);
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
				narrowGeneration(runDir, generation, narrowed);
			} catch (error) {
				return `storage is unavailable (${error instanceof Error ? error.message : String(error)})`;
			}
			return undefined;
		};

	/**
	 * What generation `generation` of a run on pi's RPC starts as: held to `held`, its definition as stored, which is
	 * checked again once its turn in the queue comes, against `parent`, its orchestrator's directory and trust.
	 */
	const rpcLaunch = (
		run: { runId: string; generation: number },
		runDir: string,
		held: RunDefinition,
		start: Omit<RpcLaunch, "tools" | "cwd" | "runDir" | "agentDir" | "projectTrusted" | "workspace" | "recheck">,
		parent: { cwd: string; trusted: boolean },
	): RpcLaunch => ({
		...start,
		tools: held.tools,
		cwd: held.cwd,
		runDir,
		agentDir: deps.agentDir(),
		projectTrusted: held.projectTrusted,
		...(held.workspace ? { workspace: held.workspace } : {}),
		recheck: recheckRpc(run.runId, runDir, run.generation, parent),
	});

	/**
	 * Admits a launch's run, or a Resume's next generation, on pi's RPC, once it passed every check, in this order for
	 * both. A launch resolves its role afresh. A Resume is held to the role its run was admitted with, and to no more
	 * than its orchestrator can give now: tools both allow, deny rules of either, trust both grant. It keeps its model
	 * and level unless the call changes them, and its workspace.
	 */
	const admitOnRpc = async (asked: LaunchEntry | ResumeEntry, ctx: AdmissionContext): Promise<AdmissionResult> => {
		const { scope, refuse, cannot } = asked;
		const agentDir = deps.agentDir();

		const denied = deniedReason(asked.agentName, ctx);
		if (denied) return refuse(denied);
		// Background runs outlive one-shot (print/json) modes, whose process exits first.
		if (
			asked.kind === "launch" &&
			asked.launch.params.background === true &&
			(ctx.mode === "print" || ctx.mode === "json")
		) {
			return refuse(
				`Background subagents are not supported in one-shot "${ctx.mode}" mode because the process exits before background completion. Omit background: true to run in the foreground.`,
			);
		}
		const entry = asked.kind === "resume" ? await resumedFrom(asked) : asked;
		if ("ok" in entry) return entry;

		const projectTrusted = ctx.isProjectTrusted();
		const resolved = resolveRunWorkspace(entry.kind === "resume" ? entry.admitted.cwd : entry.launch.params.cwd, {
			cwd: ctx.cwd,
			projectTrusted,
			agentDir,
			denyRules: forkSettings.denyRules(SettingsManager.create(ctx.cwd, agentDir, { projectTrusted })),
		});
		if (entry.kind === "resume" && (!resolved.ok || resolved.workspace.cwd !== entry.admitted.cwd)) {
			return cannot(
				`its workspace ${entry.admitted.cwd} is no longer available (${resolved.ok ? `it now leads to ${resolved.workspace.cwd}` : resolved.error}). It resumes only in its own workspace; spawn a new subagent and point it at ${entry.run.reportPath ?? "its report"}.`,
			);
		}
		if (!resolved.ok) return refuse(resolved.error);
		const { workspace } = resolved;
		const { cwd } = workspace;
		const read = rpcDenyRules(agentDir, [
			{ cwd: ctx.cwd, trusted: projectTrusted },
			{ cwd, trusted: workspace.trusted(cwd) },
		]);
		if (!read.ok) return refuse(read.error);
		const { deny } = read;

		// A Resume keeps the role it was admitted with. An inline role is validated. A saved one is found from the
		// run's own directory.
		const role =
			entry.kind === "resume"
				? { ok: true as const, definition: entry.admitted }
				: typeof entry.launch.params.agent !== "string"
					? createInlineAgentDefinition(entry.launch.params.agent)
					: resolveAgentDefinition(
							discoverAgentDefinitions({
								cwd,
								root: workspace.root,
								agentDir,
								projectTrusted: workspace.trusted,
								scope: entry.launch.params.agentScope,
							}),
							entry.agentName,
						);
		if (!role.ok) return refuse(role.error);
		const { definition } = role;
		const grantable = rpcGrantableTools(deps.tools(), deps.registeredTools());
		// Whether a run's commands can be contained here is known before it is given a shell.
		let tools: string[];
		if (entry.kind === "resume") {
			tools = narrowRunDefinition(entry.admitted, grantable, []).tools;
			if (tools.includes("bash")) {
				const shell = await prepareRunContainment();
				if (!shell.ok) return cannot(`it runs commands, and a run gets no shell here: ${shell.reason}.`);
			}
		} else {
			const shell = rpcRunMayShell(definition) ? await prepareRunContainment() : undefined;
			const given = rpcRunTools(definition, grantable, shell);
			if (!given.ok) return refuse(given.error);
			tools = given.tools;
		}
		const writes = tools.some((tool) => WORKTREE_TOOLS.includes(tool));
		const cannotIsolate = (why: string) =>
			refuse(
				`Subagent role "${definition.name}" may edit files or run commands, so it works in an isolated Git worktree, and none can be made: ${why}. Such a run never works in a shared checkout: give it a cwd in a Git repository with a commit, or a role that only reads.`,
			);
		// A step of a chain whose steps share a worktree works in it, whether it edits or not.
		const shared = entry.kind === "launch" ? entry.launch.chain?.workspace : undefined;
		if (entry.kind === "launch") {
			// Known before a batch's members are admitted together, unlike what recording the checkout may still find.
			const unisolated = writes || shared === "record" ? worktreeUnavailable(cwd) : undefined;
			if (unisolated) return cannotIsolate(unisolated);
			if (typeof shared === "object" && !within(shared.baseline.source, cwd)) {
				return refuse(
					`Subagent cwd ${cwd} is outside ${shared.baseline.source}, the repository the worktree of its chain was made from: the steps of a chain work in that one worktree.`,
				);
			}
		}

		// A launch's model and level each as the call asks, else as the role does, else as the orchestrator has them,
		// verified before admission. A Resume's as the call asks, else as the run's latest generation had them.
		let requestedModel: SubagentModelSpec;
		let thinkingLevel: string;
		// Whether the level is the orchestrator's, as neither the call nor the role sets one.
		let inherited = false;
		if (entry.kind === "resume") {
			const { changes } = entry;
			const prior = generationDefinition(entry.runDir, entry.run.generation)?.admitted ?? entry.admitted.admitted;
			thinkingLevel =
				changes.thinkingLevel === "inherit"
					? deps.parentThinkingLevel()
					: (changes.thinkingLevel ?? prior.thinkingLevel);
			requestedModel =
				changes.model === undefined
					? `${prior.provider}/${prior.modelId}`
					: (parseSubagentModelSpec(changes.model) ?? "inherit");
		} else {
			const { params } = entry.launch;
			const invalid = invalidModelChoice(params);
			if (invalid) return refuse(invalid);
			const spawnModel = params.model === undefined ? undefined : parseSubagentModelSpec(params.model);
			const parentThinkingLevel = deps.parentThinkingLevel();
			requestedModel = spawnModel ?? definition.model;
			const explicitThinkingLevel =
				params.thinkingLevel === "inherit"
					? parentThinkingLevel
					: (params.thinkingLevel ?? definition.thinkingLevel);
			// A level is resolved apart from the model, as the parent's when none is chosen.
			thinkingLevel = explicitThinkingLevel ?? parentThinkingLevel;
			inherited = explicitThinkingLevel === undefined;
		}
		const childModel = await resolveChildModel(requestedModel, thinkingLevel, ctx);
		if (!childModel.ok) {
			return refuse(
				inherited && childModel.error.startsWith("Thinking level")
					? `${childModel.error} That level is yours, inherited as neither the call nor the role sets one: set thinkingLevel ("off" for a model that does not reason).`
					: childModel.error,
			);
		}
		if (!(await deps.ensureQueue())) return cannot(QUEUE_DOWN);
		const ready = entry.kind === "launch" ? entry.launch.ready : undefined;
		if (ready && !(await ready({ cwd, root: workspace.root, writes }))) {
			return refuse("Not admitted: another member of its batch was refused.");
		}

		// Everything from here to the admission runs without awaiting, so the session cannot change in between.
		if (!entry.inScope()) return entry.invalidated;
		if (entry.kind === "resume") {
			const latest = deps.scheduler.getRun(entry.run.runId) ?? entry.run;
			if (!isResumableSubagentStatus(latest.status) || latest.generation !== entry.run.generation) {
				return cannot("another Resume of it started meanwhile.");
			}
		}
		const holderOf = (name: string) => deps.directory.nameHolder(scope, name)?.record;
		let name: string;
		if (entry.kind === "resume") {
			const holder = entry.run.name ? holderOf(entry.run.name) : undefined;
			if (holder) return refuse(`${entry.label} cannot resume: its name is now used by ${holder.runId}.`);
			name = entry.run.name ?? entry.run.runId;
		} else {
			const { requestedName } = entry;
			if (requestedName !== undefined) {
				const holder = holderOf(requestedName);
				if (holder) {
					return refuse(`${nameTaken(requestedName, holder)}; choose another name.`);
				}
			}
			let runName = requestedName;
			while (!runName || holderOf(runName)) {
				const key = `${entry.parentSessionId}:${definition.name}`;
				const next = (autoNameCounters.get(key) ?? 0) + 1;
				autoNameCounters.set(key, next);
				runName = `${definition.name}-${next}`;
			}
			name = runName;
			if (entry.launch.signal?.aborted) return refuse("Subagent request was aborted before admission.");
		}
		// A worktree has one run in it at a time: the step before hands it on by ending.
		const root =
			entry.kind === "resume"
				? entry.admitted.workspace?.root
				: typeof shared === "object"
					? shared.root
					: undefined;
		const occupant = root && deps.directory.list(scope).find(({ record }) => within(root, record.cwd))?.record;
		if (occupant) {
			return entry.kind === "resume"
				? cannot(
						`its worktree ${root} is in use by ${formatRunLabel(occupant)}: no two runs work in one worktree at once.`,
					)
				: refuse(
						`The worktree of its chain, ${root}, is in use by ${formatRunLabel(occupant)}: no two runs work in one worktree at once.`,
					);
		}

		if (entry.kind === "resume") {
			const { run: current, runDir, admitted, changes } = entry;
			// One the user types in its pane has no task until they do.
			const typed = changes.typed === true && deps.runPane() !== undefined;
			const task = typed ? "" : entry.buildPrompt();
			const invalidTask = typed ? undefined : invalidTaskText(task);
			if (invalidTask) return refuse(invalidTask);
			const model = { provider: childModel.model.provider, modelId: childModel.model.id, thinkingLevel };
			const held: RunDefinition = {
				...narrowRunDefinition(admitted, grantable, deny),
				projectTrusted: admitted.projectTrusted && workspace.trusted(cwd),
				admitted: model,
			};
			if (admitted.workspace && !worktreeInPlace(admitted.workspace, runDir)) {
				return cannot("its worktree was cleaned up meanwhile.");
			}
			const generation = current.generation + 1;
			try {
				if (!admitGeneration(runDir, generation, held)) {
					return cannot(`another Resume of it already started its generation ${generation}.`);
				}
			} catch (error) {
				return cannot(`storage is unavailable (${error instanceof Error ? error.message : String(error)}).`);
			}
			const resumed = deps.scheduler.resume(
				current.runId,
				{
					rpc: rpcLaunch(
						{ runId: current.runId, generation },
						runDir,
						held,
						{
							name,
							definition: held,
							...model,
							task,
							sessionFile: entry.sessionFile,
							...(changes.from ? { taskFrom: changes.from } : {}),
							...(changes.chainStep ? { keepWorktree: true } : {}),
							...paneOf(),
							...(typed ? { typed: true as const } : {}),
						},
						{ cwd: ctx.cwd, trusted: projectTrusted },
					),
				},
				entry.known ? undefined : { ...current, sessionEpoch: scope.sessionEpoch },
				model,
			);
			if (!resumed.ok) return refuse(resumed.error);
			return { ok: true, handle: resumed.handle };
		}

		const { toolCallId, parentTurnId, params, signal, batch, chain } = entry.launch;
		const isBackground = params.background === true;
		const startSnapshot = captureWorkspaceSnapshot(cwd);
		// Prepared before admission, so a run that cannot store anything is never listed.
		const runId = chain?.runId ?? createRunId();
		const storage = ensureRunStorageDir(agentDir, entry.parentSessionId, runId);
		if (!storage.ok) return cannot(`storage is unavailable (${storage.error}).`);
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
				return refuse(
					`Subagent cwd ${cwd} is not in the worktree of its chain, ${shared.root}: the worktree was removed, or the directory is ignored or held no file when the chain began.`,
				);
			}
			if (!within(realpathSync(shared.root), step)) {
				return refuse(
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
			return refuse(error);
		};
		// The role as admitted, with what it may do and the model and level it runs at: what the run, and any later
		// continuation of it, is held to.
		const admitted = {
			provider: childModel.model.provider,
			modelId: childModel.model.id,
			thinkingLevel,
		};
		const held: RunDefinition = {
			...definition,
			tools,
			deny,
			cwd: runCwd,
			projectTrusted: childTrusted,
			admitted,
			...(isolated ? { workspace: isolated } : {}),
			...(tools.includes("bash") ? { shell: { runId, runDir: storage.runDir } } : {}),
		};
		try {
			admitGeneration(storage.runDir, 0, held);
		} catch (error) {
			return refuseIsolated(
				`Cannot launch subagent: storage is unavailable (${error instanceof Error ? error.message : String(error)}).`,
			);
		}

		const admitRes = deps.scheduler.admit({
			runId,
			parentSessionId: entry.parentSessionId,
			sessionEpoch: scope.sessionEpoch,
			parentTurnId,
			originToolCallId: toolCallId,
			originEntryId: entry.originEntryId,
			name,
			backend: "rpc",
			agentName: definition.name,
			definitionSource: definition.source,
			provider: childModel.model.provider,
			modelId: childModel.model.id,
			thinkingLevel: childModel.thinkingLevel ?? MODEL_DEFAULT_THINKING,
			cwd: runCwd,
			taskSummary: summarizeTaskLabel(params.task),
			startSnapshot,
			deliveryMode: isBackground ? "background" : "foreground",
			...(batch ? { batch } : {}),
			...(chain ? { chain: chain.id } : {}),
			// Cancelling a foreground call cancels its run's work. A run in the background goes on whatever becomes of
			// the call.
			...(!isBackground && signal ? { signal } : {}),
			context: {
				rpc: rpcLaunch(
					{ runId, generation: 0 },
					storage.runDir,
					held,
					{
						name,
						definition,
						...admitted,
						task: params.task,
						...(typeof shared === "object" ? { worktreeMade: true } : {}),
						...(chain ? { keepWorktree: true } : {}),
						...paneOf(),
					},
					{ cwd: ctx.cwd, trusted: projectTrusted },
				),
			},
		});
		if (!admitRes.ok) return refuseIsolated(admitRes.error);
		return { ok: true, handle: admitRes.handle };
	};

	return {
		async launch(request, ctx) {
			const { params, chain } = request;
			const dispatched = deps.scope.current();
			if (!dispatched) return reject("Subagent runtime is not initialized for this session.");
			const parentSessionId = ctx.sessionManager.getSessionId();
			const originEntryId = chain?.origin ?? ctx.sessionManager.getLeafId() ?? undefined;
			const inlineRole = typeof params.agent === "string" ? undefined : params.agent;
			const agentName = (typeof params.agent === "string" ? params.agent : params.agent.name).trim();

			if (!agentName && !inlineRole) return reject("Missing required parameter: agent");
			const invalidTask = invalidTaskText(params.task);
			if (invalidTask) return reject(invalidTask);
			const requestedName = params.name?.trim();
			const invalidName = requestedName === undefined ? undefined : invalidRunName(requestedName);
			if (invalidName) return reject(invalidName);

			return admitOnRpc(
				{
					kind: "launch",
					scope: dispatched,
					agentName,
					inScope: () =>
						dispatched.parentSessionId === parentSessionId &&
						deps.scope.inScope(dispatched) &&
						deps.scope.onBranch(originEntryId),
					refuse: reject,
					cannot: (why) => reject(`Cannot launch subagent: ${why}`),
					invalidated: reject("Parent session or branch changed before subagent admission; request cancelled."),
					launch: request,
					requestedName,
					parentSessionId,
					originEntryId,
				},
				ctx,
			);
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
			const definition = generationDefinition(runDir, run.generation);
			const state = generationState(runDir, run.generation);
			const spec = state.at === "unadmitted" ? undefined : state.launch;
			if (!definition || !spec) return false;
			const { workspace } = definition;
			// A run in a pane follows its orchestrator to the pane its session runs in now (ADR-0008): its spec says which.
			const pane = spec.pane && { ...spec.pane, parent: deps.pane() ?? spec.pane.parent };
			deps.scheduler.takeOver(
				{ ...run, sessionEpoch: scope.sessionEpoch },
				{
					rpc: rpcLaunch(
						run,
						runDir,
						definition,
						{
							name: run.name ?? run.runId,
							definition,
							provider: spec.model.provider,
							modelId: spec.model.id,
							thinkingLevel: spec.model.thinkingLevel,
							task: "",
							...(spec.sessionFile ? { sessionFile: spec.sessionFile } : {}),
							// A later step of a chain works in the worktree its first step made, named after that step's run.
							...(workspace && basename(workspace.root) !== run.runId ? { worktreeMade: true } : {}),
							...(run.chain ? { keepWorktree: true } : {}),
							...(pane ? { parentPane: pane.parent } : {}),
							recovered: pane ? { ...spec, pane } : spec,
						},
						// Not yet started, it starts only once the session that returned may still start it, as at any turn.
						{ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() },
					),
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

			// A closed run on pi's RPC reopens its saved session in a pi of its own, as its next generation, given an
			// instruction.
			const cannot = (why: string) => unavailable(`Cannot resume ${label}: ${why}`);
			const scope = deps.scope.current();
			const known = deps.scheduler.getRun(run.runId);
			const current = known ?? run;
			const inScope = () =>
				scope !== undefined &&
				deps.scope.inScope(scope) &&
				current.parentSessionId === scope.parentSessionId &&
				(!known || deps.scope.inScope(known)) &&
				deps.scope.onBranch(current.originEntryId);
			if (!scope || !inScope()) return invalidated;
			if (!isResumableSubagentStatus(current.status)) {
				return unavailable(`${label} is ${current.status}; only a finished or stopped subagent can be resumed.`);
			}
			if (!buildPrompt) return cannot("a Resume needs an instruction for it.");
			const invalid = invalidModelChoice(changes);
			if (invalid) return unavailable(invalid);

			return admitOnRpc(
				{
					kind: "resume",
					scope,
					agentName: current.agentName,
					inScope: () => deps.scope.current()?.sessionEpoch === scope.sessionEpoch && inScope(),
					refuse: unavailable,
					cannot,
					invalidated,
					run: current,
					label,
					known: known !== undefined,
					buildPrompt,
					changes,
				},
				ctx,
			);
		},
	};
}
