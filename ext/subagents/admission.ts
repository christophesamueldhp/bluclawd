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
	worktreeOwner,
	worktreePath,
	worktreeUnavailable,
} from "./run-worktree.ts";
import {
	type AdmittedSubagentHandle,
	createRunId,
	formatRunLabel,
	isLegacyRun,
	isResumableSubagentStatus,
	type LatestGenerationKind,
	RUNS_ON_ITS_OWN_PI,
	type SubagentRunRecord,
	type SubagentRunScheduler,
} from "./runs.ts";
import { chainPlanPath, ensureRunStorageDir, readChainPlan } from "./storage.ts";
import { legacyRunRefusal, type RunLaunch } from "./tmux-runs.ts";

export const MAX_TASK_INPUT_BYTES = 32 * 1024;
const MODEL_DEFAULT_THINKING = "model default";
const QUEUE_DOWN = "the daemon that queues runs is not running and could not be started.";
const BUILTIN_EXTENSIONS = ["codemode", "tool_search"];
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function orchestratorTools(loadout: ToolLoadout): string[] {
	const declared = new Set(loadout.declared.map((tool) => tool.name));
	return [...loadout.callable.map((tool) => tool.name), ...BUILTIN_EXTENSIONS.filter((name) => declared.has(name))];
}

export type RunExecutionContext = { launch: RunLaunch } | { rpc: RpcLaunch };

export const BATCH_ID_PREFIX = "batch_";
export const CHAIN_ID_PREFIX = "chain_";

export const nameTaken = (name: string, holder: Pick<SubagentRunRecord, "runId">): string =>
	`Subagent name "${name}" is already used by running agent ${holder.runId}`;

export interface LaunchRequest {
	toolCallId: string;
	parentTurnId: string;
	params: LaunchParams;
	signal?: AbortSignal;
	group?: { batch: string } | { chain: string };
	runId?: string;
	origin?: string;
	workspace?: "isolated" | IsolatedWorkspace;
	keepWorktree?: true;
}

export interface Checked {
	readonly cwd: string;
	readonly root: string;
	readonly writes: boolean;
}

export type Refusal = Extract<AdmissionResult, { ok: false }>;

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
	directory: Pick<RunDirectory, "nameHolder" | "list">;
	agentDir: () => string;
	parentThinkingLevel: () => string;
	scope: ParentScopeChecks;
	pane: () => string | undefined;
	runPane: () => string | undefined;
	tools: () => readonly string[];
	registeredTools: () => readonly string[];
	ensureQueue: () => Promise<boolean>;
}

export type AdmissionResult =
	| { readonly ok: true; readonly handle: AdmittedSubagentHandle }
	| {
			readonly ok: false;
			readonly error: string;
			readonly refusal?: "invalidated" | "unavailable";
	  };

export type ResumeInstruction = { from: "orchestrator" | "user"; text: () => string } | { typed: true };

export interface ResumeChanges {
	model?: string;
	thinkingLevel?: string;
	keepWorktree?: true;
}

export interface RunAdmission {
	check(request: LaunchRequest, ctx: AdmissionContext): Promise<{ ok: true; checked: Checked } | Refusal>;
	admit(checked: Checked): AdmissionResult;
	launch(request: LaunchRequest, ctx: AdmissionContext): Promise<AdmissionResult>;
	resume(
		run: Readonly<SubagentRunRecord>,
		instruction: ResumeInstruction,
		ctx: AdmissionContext,
		changes?: ResumeChanges,
	): Promise<AdmissionResult>;
	adopt(run: Readonly<SubagentRunRecord>): void;
	recover(run: Readonly<SubagentRunRecord>, ctx: AdmissionContext): boolean;
}

interface Entry {
	scope: ParentScope;
	agentName: string;
	inScope(): boolean;
	refuse(error: string): Refusal;
	cannot(why: string): Refusal;
	invalidated: Refusal;
}

interface Passed {
	checked: Checked;
	admit(): AdmissionResult;
}

interface LaunchEntry extends Entry {
	kind: "launch";
	launch: LaunchRequest;
	requestedName: string | undefined;
	parentSessionId: string;
	originEntryId: string | undefined;
}

interface ResumeEntry extends Entry {
	kind: "resume";
	run: Readonly<SubagentRunRecord>;
	label: string;
	known: boolean;
	instruction: ResumeInstruction;
	changes: ResumeChanges;
}

interface ResumedFrom {
	runDir: string;
	admitted: RunDefinition;
	sessionFile: string;
}

/** Whether a saved session holds a conversation, because pi would start a new one at a path without one, without a warning. */
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

export function invalidTaskText(task: string): string | undefined {
	if (!task.trim()) return "Missing required parameter: task";
	const bytes = Buffer.byteLength(task, "utf8");
	if (bytes <= MAX_TASK_INPUT_BYTES) return undefined;
	return `Delegated task exceeds the ${MAX_TASK_INPUT_BYTES}-byte limit (${bytes} bytes). Supply target file paths instead of pasting large file contents.`;
}

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
	const reject = (error: string): Refusal => ({ ok: false, error });
	const admits = new WeakMap<Checked, () => AdmissionResult>();

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

	const resumedFrom = async (entry: ResumeEntry): Promise<Refusal | (ResumeEntry & ResumedFrom)> => {
		const { run: current, cannot } = entry;
		const agentDir = deps.agentDir();
		const storage = ensureRunStorageDir(agentDir, current.parentSessionId, current.runId);
		if (!storage.ok) return cannot(`storage is unavailable (${storage.error}).`);
		const { runDir } = storage;
		const admitted = generationDefinition(runDir, 0);
		if (!admitted) return cannot("the role it was admitted with is not stored.");
		const sessionFile = current.transcriptPath;
		if (!sessionFile || !holdsConversation(sessionFile)) return cannot("it has no saved conversation to go on with.");
		const left = runProcessesLeft(runDir);
		if (left?.host) return cannot("its pi from before is still running.");
		if (left) return cannot(`processes its earlier Generation started still run (process group ${left.group}).`);
		if (admitted.workspace) {
			const owner = worktreeOwner(admitted.workspace, agentDir, current.parentSessionId);
			const lost = await restoreWorktree(admitted.workspace, owner);
			if (lost) {
				return cannot(
					`${lost}. It resumes only in its own workspace, never in the checkout as it is now; its transcript and Reports are kept: spawn a new subagent and point it at ${current.reportPath ?? "its report"}.`,
				);
			}
		}
		return { ...entry, runDir, admitted, sessionFile };
	};

	const paneOf = (): { parentPane?: string } => {
		const parentPane = deps.runPane();
		return parentPane ? { parentPane } : {};
	};
	const kindOf = (pane: { parentPane?: string }): LatestGenerationKind => (pane.parentPane ? "pane" : "rpc");

	const recheckAtQueueTurn =
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
		recheck: recheckAtQueueTurn(run.runId, runDir, run.generation, parent),
	});

	const checkOnRpc = async (asked: LaunchEntry | ResumeEntry, ctx: AdmissionContext): Promise<Refusal | Passed> => {
		const { scope, refuse, cannot } = asked;
		const agentDir = deps.agentDir();

		const denied = deniedReason(asked.agentName, ctx);
		if (denied) return refuse(denied);
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
		const shared = entry.kind === "launch" ? entry.launch.workspace : undefined;
		if (entry.kind === "launch") {
			const unisolated = writes || shared === "isolated" ? worktreeUnavailable(cwd) : undefined;
			if (unisolated) return cannotIsolate(unisolated);
			if (typeof shared === "object" && !within(shared.baseline.source, cwd)) {
				return refuse(
					`Subagent cwd ${cwd} is outside ${shared.baseline.source}, the repository the worktree of its chain was made from: the steps of a chain work in that one worktree.`,
				);
			}
		}

		let requestedModel: SubagentModelSpec;
		let thinkingLevel: string;
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
		const admitWithoutAwaiting = (): AdmissionResult => {
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
			const root =
				entry.kind === "resume"
					? entry.admitted.workspace?.root
					: typeof shared === "object"
						? shared.root
						: undefined;
			const worktreeOccupant =
				root && deps.directory.list(scope).find(({ record }) => within(root, record.cwd))?.record;
			if (worktreeOccupant) {
				return entry.kind === "resume"
					? cannot(
							`its worktree ${root} is in use by ${formatRunLabel(worktreeOccupant)}: no two runs work in one worktree at once.`,
						)
					: refuse(
							`The worktree of its chain, ${root}, is in use by ${formatRunLabel(worktreeOccupant)}: no two runs work in one worktree at once.`,
						);
			}

			if (entry.kind === "resume") {
				const { run: current, runDir, admitted, changes } = entry;
				const { instruction } = entry;
				const typed = "typed" in instruction && deps.runPane() !== undefined;
				const task = "typed" in instruction ? "" : instruction.text();
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
				const pane = paneOf();
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
								...("typed" in instruction || instruction.from === "user" ? { taskFrom: "user" as const } : {}),
								...(changes.keepWorktree ? { keepWorktree: true } : {}),
								...pane,
								...(typed ? { typed: true as const } : {}),
							},
							{ cwd: ctx.cwd, trusted: projectTrusted },
						),
					},
					entry.known ? undefined : { ...current, sessionEpoch: scope.sessionEpoch },
					{ ...model, kind: kindOf(pane) },
				);
				if (!resumed.ok) return refuse(resumed.error);
				return { ok: true, handle: resumed.handle };
			}

			const { toolCallId, parentTurnId, params, signal, group } = entry.launch;
			const isBackground = params.background === true;
			const pane = paneOf();
			const startSnapshot = captureWorkspaceSnapshot(cwd);
			const runId = entry.launch.runId ?? createRunId();
			const storageBeforeListing = ensureRunStorageDir(agentDir, entry.parentSessionId, runId);
			if (!storageBeforeListing.ok) return cannot(`storage is unavailable (${storageBeforeListing.error}).`);
			const childTrusted = workspace.trusted(cwd);
			let isolated: IsolatedWorkspace | undefined;
			let runCwd = cwd;
			if (typeof shared === "object") {
				isolated = shared;
				let stepCwdResolvedNow: string;
				try {
					stepCwdResolvedNow = realpathSync(join(shared.root, relative(shared.baseline.source, cwd)));
				} catch {
					return refuse(
						`Subagent cwd ${cwd} is not in the worktree of its chain, ${shared.root}: the worktree was removed, or the directory is ignored or held no file when the chain began.`,
					);
				}
				if (!within(realpathSync(shared.root), stepCwdResolvedNow)) {
					return refuse(
						`Subagent cwd ${cwd} is not in the worktree of its chain, ${shared.root}: there, it leads to ${stepCwdResolvedNow}. A step works only in its chain's worktree.`,
					);
				}
				runCwd = stepCwdResolvedNow;
			} else if (writes || shared === "isolated") {
				const captured = captureRunBaseline(cwd, runId);
				if (!captured.ok) return cannotIsolate(captured.error);
				isolated = { root: worktreePath(agentDir, runId), baseline: captured.baseline };
				runCwd = join(isolated.root, captured.cwd);
			}
			const refuseIsolated = (error: string): AdmissionResult => {
				if (isolated && typeof shared !== "object") dropRunBaseline(isolated.baseline);
				return refuse(error);
			};
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
				...(tools.includes("bash") ? { shell: { runId, runDir: storageBeforeListing.runDir } } : {}),
			};
			try {
				admitGeneration(storageBeforeListing.runDir, 0, held);
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
				backend: RUNS_ON_ITS_OWN_PI,
				kind: kindOf(pane),
				agentName: definition.name,
				definitionSource: definition.source,
				provider: childModel.model.provider,
				modelId: childModel.model.id,
				thinkingLevel: childModel.thinkingLevel ?? MODEL_DEFAULT_THINKING,
				cwd: runCwd,
				taskSummary: summarizeTaskLabel(params.task),
				startSnapshot,
				deliveryMode: isBackground ? "background" : "foreground",
				...group,
				...(!isBackground && signal ? { signal } : {}),
				context: {
					rpc: rpcLaunch(
						{ runId, generation: 0 },
						storageBeforeListing.runDir,
						held,
						{
							name,
							definition,
							...admitted,
							task: params.task,
							...(typeof shared === "object" ? { worktreeMade: true } : {}),
							...(entry.launch.keepWorktree ? { keepWorktree: true } : {}),
							...pane,
						},
						{ cwd: ctx.cwd, trusted: projectTrusted },
					),
				},
			});
			if (!admitRes.ok) return refuseIsolated(admitRes.error);
			return { ok: true, handle: admitRes.handle };
		};
		return { checked: { cwd, root: workspace.root, writes }, admit: admitWithoutAwaiting };
	};

	const admission: RunAdmission = {
		async check(request, ctx) {
			const { params } = request;
			const dispatched = deps.scope.current();
			if (!dispatched) return reject("Subagent runtime is not initialized for this session.");
			const parentSessionId = ctx.sessionManager.getSessionId();
			const originEntryId = request.origin ?? ctx.sessionManager.getLeafId() ?? undefined;
			const inlineRole = typeof params.agent === "string" ? undefined : params.agent;
			const agentName = (typeof params.agent === "string" ? params.agent : params.agent.name).trim();

			if (!agentName && !inlineRole) return reject("Missing required parameter: agent");
			const invalidTask = invalidTaskText(params.task);
			if (invalidTask) return reject(invalidTask);
			const requestedName = params.name?.trim();
			const invalidName = requestedName === undefined ? undefined : invalidRunName(requestedName);
			if (invalidName) return reject(invalidName);

			const passed = await checkOnRpc(
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
			if (!("checked" in passed)) return passed;
			admits.set(passed.checked, passed.admit);
			return { ok: true, checked: passed.checked };
		},

		admit(checked) {
			const admit = admits.get(checked);
			if (!admit) throw new Error("A launch is admitted once, after its check passed.");
			admits.delete(checked);
			return admit();
		},

		async launch(request, ctx) {
			const checked = await admission.check(request, ctx);
			return checked.ok ? admission.admit(checked.checked) : checked;
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
			const definition = generationDefinition(runDir, run.generation);
			const state = generationState(runDir, run.generation);
			const spec = state.at === "unadmitted" ? undefined : state.launch;
			if (!definition || !spec) return false;
			const { workspace } = definition;
			const inheritsChainWorktree = workspace !== undefined && basename(workspace.root) !== run.runId;
			const pane = spec.pane && { ...spec.pane, parent: deps.pane() ?? spec.pane.parent };
			const plan = run.chain && readChainPlan(chainPlanPath(agentDir, run.parentSessionId, run.chain));
			const stepKeepsWorktree =
				plan &&
				!plan.settled &&
				plan.ran.some((step) => step?.runId === run.runId && step.generation === run.generation);
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
							...(inheritsChainWorktree ? { worktreeMade: true } : {}),
							...(stepKeepsWorktree ? { keepWorktree: true } : {}),
							...(pane ? { parentPane: pane.parent } : {}),
							recovered: pane ? { ...spec, pane } : spec,
						},
						{ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() },
					),
				},
			);
			return true;
		},

		async resume(run, instruction, ctx, changes = {}) {
			const label = formatRunLabel(run);
			const invalidated: Refusal = {
				ok: false,
				refusal: "invalidated",
				error: `${label} belongs to a session that was replaced; spawn a new subagent and point it at ${run.reportPath ?? "the earlier report"}.`,
			};
			const unavailable = (error: string): Refusal => ({ ok: false, refusal: "unavailable", error });
			if (ctx.mode === "print" || ctx.mode === "json") {
				return unavailable(
					`Resuming ${label} is not supported in one-shot "${ctx.mode}" mode because a resume runs in the background and the process exits before it completes.`,
				);
			}
			if (isLegacyRun(run)) return unavailable(legacyRunRefusal(run));

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
			const invalid = invalidModelChoice(changes);
			if (invalid) return unavailable(invalid);

			const passed = await checkOnRpc(
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
					instruction,
					changes,
				},
				ctx,
			);
			return "checked" in passed ? passed.admit() : passed;
		},
	};
	return admission;
}
