import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { type Static, Type } from "@earendil-works/pi-ai";
import { type ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";
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
import type { RunDirectory } from "./directory.ts";
import { PARENT_MESSAGE_ADDRESS } from "./messages.ts";
import { resolveChildModelAndRuntime } from "./models.ts";
import type { ParentScopeChecks } from "./parent-scope.ts";
import {
	type AdmittedSubagentHandle,
	createRunId,
	isResumableSubagentStatus,
	type SubagentRunRecord,
	type SubagentRunScheduler,
	type WorkspaceSnapshot,
} from "./runs.ts";
import { ensureRunStorageDir, recordCountedSessionUsage } from "./storage.ts";
import type { RunLaunch } from "./tmux-runs.ts";

export const MAX_TASK_INPUT_BYTES = 32 * 1024;
/** Recorded when no level is chosen: the run's pi picks its model's default. */
const SDK_DEFAULT_THINKING = "model default";
/** How many runs an orchestrator holds open at once: each is a full pi. */
export const MAX_OPEN_RUNS = 8;
const TOO_MANY_OPEN = `An orchestrator holds at most ${MAX_OPEN_RUNS} open subagents. Close one whose work is done with subagent_close, then try again.`;
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const NEEDS_TMUX =
	"Subagents need tmux: each run is a pi session of its own in agent view's tmux server, and this pi does not run there. Install tmux if it is missing (brew install tmux), then start pi again in a terminal.";

/** What a run needs from its admission to execute: it starts as a pi of its own in tmux (ADR-0006), its role as its launch flags. */
export interface RunExecutionContext {
	launch: RunLaunch;
}

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
	scheduler: Pick<SubagentRunScheduler<RunExecutionContext>, "admit" | "resume" | "getRun" | "getContext">;
	/** Which names the runs of a parent scope hold. */
	directory: Pick<RunDirectory, "nameHolder" | "list">;
	agentDir: () => string;
	/** Saved roles frozen at session start; discovered on demand when session start was skipped. */
	catalog: () => AgentDefinitionCatalog | undefined;
	parentThinkingLevel: () => string;
	scope: ParentScopeChecks;
	/** The orchestrator's tmux session, where its runs start as pis of their own; without one, none starts. */
	pane: () => string | undefined;
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
	 * Admits a completed or closed run's next generation. `buildPrompt` is called only once every check has
	 * passed, just before the run starts again. Without one, the run resumes for the user to type in.
	 */
	resume(
		run: Readonly<SubagentRunRecord>,
		buildPrompt: (() => string) | undefined,
		ctx: AdmissionContext,
	): Promise<AdmissionResult>;
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
			return refuse.unavailable(
				`${label} is ${current.status}; only a completed or closed subagent can be resumed.`,
			);
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
		const previous = deps.scheduler.getContext(current.runId);
		const resumed = deps.scheduler.resume(
			current.runId,
			{
				launch: {
					name: current.name ?? current.runId,
					definition: previous ? previous.launch.definition : roleOf(current, ctx),
					model: `${current.provider}/${current.modelId}`,
					thinkingLevel: current.thinkingLevel === SDK_DEFAULT_THINKING ? undefined : current.thinkingLevel,
					task: buildPrompt?.(),
					cwd: current.cwd,
					runDir: storage.runDir,
					sessionFile,
					parent: parentPane,
					projectTrusted: ctx.isProjectTrusted(),
				},
			},
			known ? undefined : { ...current, sessionEpoch: scope.sessionEpoch },
		);
		if (!resumed.ok) return refuse.unavailable(resumed.error);
		return { ok: true, handle: resumed.handle };
	};

	/**
	 * The role a run known only from disk resumes with: its saved role as it is now. An inline role is not kept,
	 * so such a run resumes with no instructions of its own and every tool.
	 */
	const roleOf = (run: Readonly<SubagentRunRecord>, ctx: AdmissionContext): AgentDefinition => {
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
			// A run is a pi of its own in tmux (ADR-0006): there is no other way to run one.
			const parentPane = deps.pane();
			if (parentPane === undefined) return reject(NEEDS_TMUX);
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
			const childModel = await resolveChildModel(requestedModel, requestedThinkingLevel, ctx);
			if (!childModel.ok) return reject(childModel.error);

			// Everything from here to admit runs without awaiting, so the session cannot change in between.
			if (
				dispatched.parentSessionId !== parentSessionId ||
				!deps.scope.inScope(dispatched) ||
				!deps.scope.onBranch(originEntryId)
			) {
				return reject("Parent session or branch changed before subagent admission; request cancelled.");
			}
			if (deps.directory.list(dispatched).length >= MAX_OPEN_RUNS) return reject(TOO_MANY_OPEN);
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

			const admitRes = deps.scheduler.admit({
				runId,
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
				// Not linked to the call's signal: an aborted foreground call only stops waiting for the run's Report.
				context: {
					launch: {
						name: runName,
						definition,
						model: `${childModel.model.provider}/${childModel.model.id}`,
						thinkingLevel: childModel.thinkingLevel,
						task: taskText,
						cwd,
						runDir: storage.runDir,
						parent: parentPane,
						projectTrusted,
					},
				},
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
			const parentPane = deps.pane();
			if (parentPane === undefined) return unavailable(NEEDS_TMUX);
			return resumeInTmux(run, parentPane, buildPrompt, ctx, { invalidated, unavailable });
		},
	};
}
