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
	type InlineAgentRole,
	isSubagentThinkingLevel,
	parseSubagentModelSpec,
	resolveAgentDefinition,
	SUBAGENT_THINKING_LEVELS,
	type SubagentModelSpec,
} from "./definitions.ts";
import { PARENT_MESSAGE_ADDRESS } from "./messages.ts";
import {
	captureWorkspaceSnapshot,
	type ParentToolSnapshot,
	resolveChildModelAndRuntime,
	sanitizeDiagnosticText,
	snapshotParentTools,
} from "./runner.ts";
import type { AdmittedSubagentHandle, SubagentRunScheduler } from "./runs.ts";
import { ensureRunStorageDir } from "./storage.ts";

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
	requestedModel: SubagentModelSpec;
	/** Set when the orchestrator resumes a completed run: its transcript and the message to continue with. */
	resume?: { transcriptPath: string; prompt: string };
	parentModel: ExtensionContext["model"];
	requestedThinkingLevel: string | undefined;
	parentModelRegistry: ExtensionContext["modelRegistry"];
	projectTrusted: boolean;
}

export interface LaunchParams {
	agent: string | InlineAgentRole;
	task?: string;
	name?: string;
	model?: string;
	thinkingLevel?: string;
	background?: boolean;
}

export interface LaunchRequest {
	toolCallId: string;
	parentTurnId: string;
	params: LaunchParams;
	signal?: AbortSignal;
}

/** The parts of the calling tool's context admission reads. Without `executeTool` a launch is refused. */
export type AdmissionContext = Pick<
	ExtensionContext,
	"cwd" | "mode" | "model" | "modelRegistry" | "isProjectTrusted"
> & {
	sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getLeafId" | "getBranch">;
	executeTool?: ExtensionToolContext["executeTool"];
};

export interface RunAdmissionDeps {
	scheduler: Pick<SubagentRunScheduler, "admit" | "listActiveRuns">;
	agentDir: () => string;
	/** Saved roles frozen at session start; discovered on demand when session start was skipped. */
	catalog: () => AgentDefinitionCatalog | undefined;
	loadout: () => ToolLoadout | undefined;
	parentThinkingLevel: () => string;
	runtimeGeneration: () => number;
	activeParentSessionId: () => string | undefined;
}

export interface AdmissionResult {
	readonly ok: boolean;
	readonly handle?: AdmittedSubagentHandle;
	readonly error?: string;
}

export interface RunAdmission {
	launch(request: LaunchRequest, ctx: AdmissionContext): Promise<AdmissionResult>;
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

export function createRunAdmission(deps: RunAdmissionDeps): RunAdmission {
	const autoNameCounters = new Map<string, number>();
	const reject = (error: string): AdmissionResult => ({ ok: false, error });

	return {
		async launch({ toolCallId, parentTurnId, params, signal }, ctx) {
			const dispatchGeneration = deps.runtimeGeneration();
			const parentSessionId = ctx.sessionManager.getSessionId();
			const originEntryId = ctx.sessionManager.getLeafId() ?? undefined;
			const agentDir = deps.agentDir();
			const cwd = ctx.cwd;
			const projectTrusted = ctx.isProjectTrusted();
			const inlineRole = typeof params.agent === "string" ? undefined : params.agent;
			const agentName = (typeof params.agent === "string" ? params.agent : params.agent.name).trim();
			const taskText = params.task ?? "";
			const isBackground = params.background === true;

			if (!agentName && !inlineRole) return reject("Missing required parameter: agent");
			if (!taskText.trim()) return reject("Missing required parameter: task");
			const taskBytes = Buffer.byteLength(taskText, "utf8");
			if (taskBytes > MAX_TASK_INPUT_BYTES) {
				return reject(
					`Delegated task exceeds the ${MAX_TASK_INPUT_BYTES}-byte limit (${taskBytes} bytes). Supply target file paths instead of pasting large file contents.`,
				);
			}

			// 1. Evaluate parent Subagent / Subagent(agentName) deny rules BEFORE admission or model activity
			const sm = SettingsManager.create(cwd, agentDir, { projectTrusted });
			const delegationDeny = evaluateSubagentDelegationDeny(forkSettings.denyRules(sm), agentName, cwd);
			if (delegationDeny.blocked) return reject(delegationDeny.reason ?? "Blocked by permission rule");

			// 2. Reject background mode in unsupported one-shot modes (print/json)
			if (isBackground && (ctx.mode === "print" || ctx.mode === "json")) {
				return reject(
					`Background subagents are not supported in one-shot "${ctx.mode}" mode because the process exits before background completion. Omit background: true to run in the foreground.`,
				);
			}

			// 3. Validate an inline role, or resolve a saved one from the frozen catalog
			const resolvedDef = inlineRole
				? createInlineAgentDefinition(inlineRole)
				: resolveAgentDefinition(
						deps.catalog() ?? discoverAgentDefinitions({ cwd, agentDir, projectTrusted }),
						agentName,
					);
			if (!resolvedDef.ok || !resolvedDef.definition) {
				return reject(resolvedDef.error ?? `Unknown subagent "${agentName}"`);
			}
			const definition = resolvedDef.definition;

			// 4. Give the child the orchestrator's callable tools, narrowed by the role's tool list
			const loadout = deps.loadout();
			if (!ctx.executeTool || !loadout)
				return reject("Subagent dispatch needs the orchestrator's live tool context.");
			const declaredNames = new Set(loadout.declared.map((tool) => tool.name));
			const callableNames = loadout.callable.map((tool) => tool.name);
			const builtinNames = CHILD_BUILTIN_EXTENSIONS.filter((name) => declaredNames.has(name));
			const availableNames = [...callableNames, ...builtinNames];
			const unknownTools = definition.tools?.filter((name) => !availableNames.includes(name)) ?? [];
			if (unknownTools.length > 0) {
				return reject(
					`Subagent role "${definition.name}" names tools the orchestrator cannot give a child: ${unknownTools.join(", ")}. Available: ${availableNames.join(", ") || "none"}.`,
				);
			}
			const selectedNames = definition.tools ?? availableNames;

			// 5. Resolve spawn > role > parent model and thinking, and verify them before admission
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
			const modelCheck = await resolveChildModelAndRuntime({
				agentDir,
				requestedModel,
				parentModel: ctx.model,
				requestedThinkingLevel,
				parentModelRegistry: ctx.modelRegistry,
			});
			if (!modelCheck.ok || !modelCheck.model) {
				return reject(
					sanitizeDiagnosticText(modelCheck.error ?? `Could not resolve model for subagent "${agentName}".`),
				);
			}

			// Everything from here to admit runs without awaiting, so the session cannot change in between.
			const activeParentSessionId = deps.activeParentSessionId();
			if (
				deps.runtimeGeneration() !== dispatchGeneration ||
				(activeParentSessionId && activeParentSessionId !== parentSessionId) ||
				(originEntryId && !ctx.sessionManager.getBranch().some((entry) => entry.id === originEntryId))
			) {
				return reject("Parent session or branch changed before subagent admission; request cancelled.");
			}
			const startSnapshot = captureWorkspaceSnapshot(cwd);

			// 6. Check storage availability before launching
			const probeDir = ensureRunStorageDir(agentDir, parentSessionId, "probe_check");
			if (!probeDir.ok) {
				return reject(
					`Cannot launch subagent: storage is unavailable (${probeDir.error ?? "storage check failed"}).`,
				);
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

			const context: RunExecutionContext = {
				agentDir,
				definition,
				task: taskText,
				parent: ctx as Pick<ExtensionToolContext, "executeTool">,
				parentTools: snapshotParentTools(
					loadout,
					callableNames.filter((name) => selectedNames.includes(name)),
				),
				activeToolNames: selectedNames.filter((name) => declaredNames.has(name)),
				builtinExtensions: builtinNames.filter((name) => selectedNames.includes(name)),
				requestedModel,
				parentModel: ctx.model,
				requestedThinkingLevel,
				parentModelRegistry: ctx.modelRegistry,
				projectTrusted,
			};

			const admitRes = deps.scheduler.admit({
				parentSessionId,
				runtimeGeneration: dispatchGeneration,
				parentTurnId,
				originToolCallId: toolCallId,
				originEntryId,
				name: runName,
				agentName: definition.name,
				definitionSource: definition.source,
				provider: modelCheck.model.provider,
				modelId: modelCheck.model.id,
				thinkingLevel: modelCheck.thinkingLevel ?? SDK_DEFAULT_THINKING,
				cwd,
				taskSummary: summarizeTaskLabel(taskText),
				startSnapshot,
				deliveryMode: isBackground ? "background" : "foreground",
				// Foreground runs link to the invoking tool call's signal; background runs outlive the launch tool call
				signal: isBackground ? undefined : signal,
				context,
			});
			if (!admitRes.ok || !admitRes.handle) return reject(admitRes.error ?? "Subagent admission rejected.");
			return { ok: true, handle: admitRes.handle };
		},
	};
}
