import { type Static, Type } from "@earendil-works/pi-ai";
import {
	type ExtensionContext,
	type ExtensionToolContext,
	SettingsManager,
	type ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import * as forkSettings from "../_shared/settings.ts";
import { evaluateSubagentDelegationDeny } from "../permissions/policy.ts";
import {
	type AgentDefinition,
	type AgentDefinitionCatalog,
	createInlineAgentDefinition,
	discoverAgentDefinitions,
	isSubagentThinkingLevel,
	parseSubagentModelSpec,
	resolveAgentDefinition,
	SUBAGENT_THINKING_LEVELS,
	type SubagentModelSpec,
} from "./definitions.ts";
import { sanitizeDiagnosticText } from "./diagnostics.ts";
import { PARENT_MESSAGE_ADDRESS } from "./messages.ts";
import type { ParentScopeChecks } from "./parent-scope.ts";
import {
	captureWorkspaceSnapshot,
	type ParentToolSnapshot,
	type ResolvedChildModel,
	resolveChildModelAndRuntime,
	snapshotParentTools,
} from "./runner.ts";
import type { AdmittedSubagentHandle, SubagentRunRecord, SubagentRunScheduler } from "./runs.ts";
import { ensureSessionStorageDir } from "./storage.ts";

export const MAX_TASK_INPUT_BYTES = 32 * 1024;
/** Recorded until the child session reports the level the SDK chose for its model. */
const SDK_DEFAULT_THINKING = "model default";
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Pi built-in extensions a child runs itself, over its own copies of the orchestrator's tools. */
const CHILD_BUILTIN_EXTENSIONS = ["codemode", "tool_search"];

/** What a run needs from its admission to execute. */
export interface RunExecutionContext {
	agentDir: string;
	definition: AgentDefinition;
	task: string;
	parent: Pick<ExtensionToolContext, "executeTool">;
	parentTools: readonly ParentToolSnapshot[];
	activeToolNames: readonly string[];
	builtinExtensions: readonly string[];
	childModel: ResolvedChildModel;
	/** Set when the orchestrator resumes a completed run: its transcript and the message to continue with. */
	resume?: { transcriptPath: string; prompt: string };
	projectTrusted: boolean;
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
				"When true, launch in the background and deliver the completed report back to this session branch.",
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

/** The parts of the calling tool's context admission reads. Without `executeTool` a run is refused. */
export type AdmissionContext = Pick<
	ExtensionContext,
	"cwd" | "mode" | "model" | "modelRegistry" | "isProjectTrusted"
> & {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getLeafId" | "getBranch">;
	executeTool?: ExtensionToolContext["executeTool"];
};

export interface RunAdmissionDeps {
	scheduler: Pick<
		SubagentRunScheduler<RunExecutionContext>,
		"admit" | "resume" | "getRun" | "getContext" | "listActiveRuns"
	>;
	agentDir: () => string;
	/** Saved roles frozen at session start; discovered on demand when session start was skipped. */
	catalog: () => AgentDefinitionCatalog | undefined;
	loadout: () => ToolLoadout | undefined;
	parentThinkingLevel: () => string;
	scope: ParentScopeChecks;
}

export type AdmissionResult =
	| { readonly ok: true; readonly handle: AdmittedSubagentHandle }
	| {
			readonly ok: false;
			readonly error: string;
			/** Why a resume was refused: its session is gone, or the run cannot continue now. */
			readonly refusal?: "invalidated" | "unavailable";
	  };

export interface RunAdmission {
	launch(request: LaunchRequest, ctx: AdmissionContext): Promise<AdmissionResult>;
	/**
	 * Admits a completed run's next generation. `buildPrompt` is called only once every check has passed,
	 * just before the run starts again.
	 */
	resume(run: Readonly<SubagentRunRecord>, buildPrompt: () => string, ctx: AdmissionContext): Promise<AdmissionResult>;
}

type ChildTools = Pick<RunExecutionContext, "parent" | "parentTools" | "activeToolNames" | "builtinExtensions">;

function summarizeTaskLabel(task: string): string {
	const firstLine =
		task
			.trim()
			.split("\n")
			.find((line) => line.trim().length > 0) ?? "";
	const compact = firstLine.replace(/\s+/g, " ").trim();
	return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact;
}

export function createRunAdmission(deps: RunAdmissionDeps): RunAdmission {
	const autoNameCounters = new Map<string, number>();
	const reject = (error: string): AdmissionResult => ({ ok: false, error });

	// Parent Subagent / Subagent(agentName) deny rules, evaluated before any model activity.
	const deniedReason = (agentName: string, ctx: AdmissionContext): string | undefined => {
		const sm = SettingsManager.create(ctx.cwd, deps.agentDir(), { projectTrusted: ctx.isProjectTrusted() });
		const delegationDeny = evaluateSubagentDelegationDeny(forkSettings.denyRules(sm), agentName, ctx.cwd);
		return delegationDeny.blocked ? (delegationDeny.reason ?? "Blocked by permission rule") : undefined;
	};

	// The orchestrator's callable tools, narrowed by the role's tool list.
	const selectChildTools = (
		definition: AgentDefinition,
		ctx: AdmissionContext,
	): { tools: ChildTools; error?: never } | { tools?: never; error: string } => {
		const loadout = deps.loadout();
		if (!ctx.executeTool || !loadout)
			return { error: "Subagent dispatch needs the orchestrator's live tool context." };
		const declaredNames = new Set(loadout.declared.map((tool) => tool.name));
		const callableNames = loadout.callable.map((tool) => tool.name);
		const builtinNames = CHILD_BUILTIN_EXTENSIONS.filter((name) => declaredNames.has(name));
		const availableNames = [...callableNames, ...builtinNames];
		const unknownTools = definition.tools?.filter((name) => !availableNames.includes(name)) ?? [];
		if (unknownTools.length > 0) {
			return {
				error: `Subagent role "${definition.name}" names tools the orchestrator cannot give a child: ${unknownTools.join(", ")}. Available: ${availableNames.join(", ") || "none"}.`,
			};
		}
		const selectedNames = definition.tools ?? availableNames;
		return {
			tools: {
				parent: ctx as Pick<ExtensionToolContext, "executeTool">,
				parentTools: snapshotParentTools(
					loadout,
					callableNames.filter((name) => selectedNames.includes(name)),
				),
				activeToolNames: selectedNames.filter((name) => declaredNames.has(name)),
				builtinExtensions: builtinNames.filter((name) => selectedNames.includes(name)),
			},
		};
	};

	const resolveChildModel = async (
		requestedModel: SubagentModelSpec,
		requestedThinkingLevel: string | undefined,
		ctx: AdmissionContext,
	): Promise<{ childModel: ResolvedChildModel; error?: never } | { childModel?: never; error: string }> => {
		const resolved = await resolveChildModelAndRuntime({
			agentDir: deps.agentDir(),
			requestedModel,
			parentModel: ctx.model,
			requestedThinkingLevel,
			parentModelRegistry: ctx.modelRegistry,
		});
		if (!resolved.ok) return { error: sanitizeDiagnosticText(resolved.error) };
		return {
			childModel: {
				model: resolved.model,
				modelRuntime: resolved.modelRuntime,
				thinkingLevel: resolved.thinkingLevel,
			},
		};
	};

	return {
		async launch({ toolCallId, parentTurnId, params, signal }, ctx) {
			const dispatched = deps.scope.current();
			if (!dispatched) return reject("Subagent runtime is not initialized for this session.");
			const parentSessionId = ctx.sessionManager.getSessionId();
			const originEntryId = ctx.sessionManager.getLeafId() ?? undefined;
			const agentDir = deps.agentDir();
			const cwd = ctx.cwd;
			const projectTrusted = ctx.isProjectTrusted();
			const inlineRole = typeof params.agent === "string" ? undefined : params.agent;
			const agentName = (typeof params.agent === "string" ? params.agent : params.agent.name).trim();
			const taskText = params.task;
			const isBackground = params.background === true;

			if (!agentName && !inlineRole) return reject("Missing required parameter: agent");
			if (!taskText.trim()) return reject("Missing required parameter: task");
			const taskBytes = Buffer.byteLength(taskText, "utf8");
			if (taskBytes > MAX_TASK_INPUT_BYTES) {
				return reject(
					`Delegated task exceeds the ${MAX_TASK_INPUT_BYTES}-byte limit (${taskBytes} bytes). Supply target file paths instead of pasting large file contents.`,
				);
			}

			const denied = deniedReason(agentName, ctx);
			if (denied) return reject(denied);

			// Background runs outlive one-shot (print/json) modes, whose process exits first.
			if (isBackground && (ctx.mode === "print" || ctx.mode === "json")) {
				return reject(
					`Background subagents are not supported in one-shot "${ctx.mode}" mode because the process exits before background completion. Omit background: true to run in the foreground.`,
				);
			}

			// An inline role is validated; a saved one comes from the frozen catalog.
			const resolvedDef = inlineRole
				? createInlineAgentDefinition(inlineRole)
				: resolveAgentDefinition(
						deps.catalog() ?? discoverAgentDefinitions({ cwd, agentDir, projectTrusted }),
						agentName,
					);
			if (!resolvedDef.ok) {
				return reject(resolvedDef.error);
			}
			const definition = resolvedDef.definition;

			const { tools, error: toolsError } = selectChildTools(definition, ctx);
			if (!tools) return reject(toolsError);

			// Spawn > role > parent for the model and thinking level, verified before admission.
			const spawnModel = params.model === undefined ? undefined : parseSubagentModelSpec(params.model);
			if (params.model !== undefined && !spawnModel) {
				return reject(
					`Invalid subagent "model" value "${params.model}": must be "inherit" or explicit "provider/model".`,
				);
			}
			if (
				params.thinkingLevel !== undefined &&
				params.thinkingLevel !== "inherit" &&
				!isSubagentThinkingLevel(params.thinkingLevel)
			) {
				return reject(
					`Invalid subagent "thinkingLevel" value "${params.thinkingLevel}": must be "inherit" or one of ${SUBAGENT_THINKING_LEVELS.join(", ")}.`,
				);
			}
			const parentThinkingLevel = deps.parentThinkingLevel();
			const requestedModel = spawnModel ?? definition.model;
			const explicitThinkingLevel =
				params.thinkingLevel === "inherit"
					? parentThinkingLevel
					: (params.thinkingLevel ?? definition.thinkingLevel);
			// A chosen model without a level gets the SDK's default for that model; an inherited one keeps the parent's.
			const requestedThinkingLevel =
				explicitThinkingLevel ?? (requestedModel === "inherit" ? parentThinkingLevel : undefined);
			const { childModel, error: modelError } = await resolveChildModel(requestedModel, requestedThinkingLevel, ctx);
			if (!childModel) return reject(modelError);

			// Everything from here to admit runs without awaiting, so the session cannot change in between.
			if (
				dispatched.parentSessionId !== parentSessionId ||
				!deps.scope.inScope(dispatched) ||
				!deps.scope.onBranch(originEntryId)
			) {
				return reject("Parent session or branch changed before subagent admission; request cancelled.");
			}
			const startSnapshot = captureWorkspaceSnapshot(cwd);

			const sessionDir = ensureSessionStorageDir(agentDir, parentSessionId);
			if (!sessionDir.ok) {
				return reject(`Cannot launch subagent: storage is unavailable (${sessionDir.error}).`);
			}

			const liveRuns = deps.scheduler.listActiveRuns(parentSessionId);
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
				const holder = liveRuns.find((run) => run.name === requestedName);
				if (holder) {
					return reject(
						`Subagent name "${requestedName}" is already used by running agent ${holder.runId}; choose another name.`,
					);
				}
			}
			let runName = requestedName;
			while (!runName || liveRuns.some((run) => run.name === runName)) {
				const key = `${parentSessionId}:${definition.name}`;
				const next = (autoNameCounters.get(key) ?? 0) + 1;
				autoNameCounters.set(key, next);
				runName = `${definition.name}-${next}`;
			}

			if (signal?.aborted) return reject("Subagent request was aborted before admission.");

			const admitRes = deps.scheduler.admit({
				parentSessionId,
				sessionEpoch: dispatched.sessionEpoch,
				parentTurnId,
				originToolCallId: toolCallId,
				originEntryId,
				name: runName,
				agentName: definition.name,
				definitionSource: definition.source,
				provider: childModel.model.provider,
				modelId: childModel.model.id,
				thinkingLevel: childModel.thinkingLevel ?? SDK_DEFAULT_THINKING,
				cwd,
				taskSummary: summarizeTaskLabel(taskText),
				startSnapshot,
				deliveryMode: isBackground ? "background" : "foreground",
				// Foreground runs link to the invoking tool call's signal; background runs outlive the launch tool call
				signal: isBackground ? undefined : signal,
				context: { agentDir, definition, task: taskText, ...tools, childModel, projectTrusted },
			});
			if (!admitRes.ok) return reject(admitRes.error);
			return { ok: true, handle: admitRes.handle };
		},

		async resume(run, buildPrompt, ctx) {
			const label = formatRunLabel(run);
			const invalidated: AdmissionResult = {
				ok: false,
				refusal: "invalidated",
				error: `${label} belongs to a session that was reloaded or replaced; spawn a new subagent and point it at ${run.reportPath ?? "the earlier report"}.`,
			};
			const unavailable = (error: string): AdmissionResult => ({ ok: false, refusal: "unavailable", error });
			if (ctx.mode === "print" || ctx.mode === "json") {
				return unavailable(
					`Resuming ${label} is not supported in one-shot "${ctx.mode}" mode because a resume runs in the background and the process exits before it completes.`,
				);
			}
			// Checked again after the model is resolved, since another message may resume the run meanwhile.
			const checkResumable = (): { transcriptPath: string; refused?: never } | { refused: AdmissionResult } => {
				const current = deps.scheduler.getRun(run.runId);
				if (!current || !deps.scope.inScope(current)) {
					return { refused: invalidated };
				}
				if (current.status !== "completed") {
					return {
						refused: unavailable(`${label} is ${current.status}; only a completed subagent can be resumed.`),
					};
				}
				if (!current.transcriptPath) return { refused: unavailable(`${label} has no saved transcript to resume.`) };
				const holder = current.name
					? deps.scheduler.listActiveRuns(current.parentSessionId).find((r) => r.name === current.name)
					: undefined;
				if (holder)
					return { refused: unavailable(`${label} cannot resume: its name is now used by ${holder.runId}.`) };
				return { transcriptPath: current.transcriptPath };
			};

			const beforeModel = checkResumable();
			if (beforeModel.refused) return beforeModel.refused;
			const previous = deps.scheduler.getContext(run.runId);
			if (!previous) return invalidated;

			const denied = deniedReason(run.agentName, ctx);
			if (denied) return unavailable(denied);
			// The run keeps its role, inline ones included, but gets the orchestrator's tools as they are now.
			const { tools, error: toolsError } = selectChildTools(previous.definition, ctx);
			if (!tools) return unavailable(toolsError);
			// The run keeps the model and level it ran with; a level the SDK chose is chosen again.
			const { childModel, error: modelError } = await resolveChildModel(
				`${run.provider}/${run.modelId}`,
				run.thinkingLevel === SDK_DEFAULT_THINKING ? undefined : run.thinkingLevel,
				ctx,
			);
			if (!childModel) return unavailable(modelError);

			const resumable = checkResumable();
			if (resumable.refused) return resumable.refused;
			const resumed = deps.scheduler.resume(run.runId, {
				...previous,
				...tools,
				childModel,
				projectTrusted: ctx.isProjectTrusted(),
				resume: { transcriptPath: resumable.transcriptPath, prompt: buildPrompt() },
			});
			if (!resumed.ok) return unavailable(resumed.error);
			return { ok: true, handle: resumed.handle };
		},
	};
}
