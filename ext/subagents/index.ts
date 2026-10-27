import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type InlineExtension,
	SettingsManager,
	type ToolLoadout,
	type ToolLoadoutChanges,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentTaskInfo,
	type AgentTaskSource,
	notifyAgentTasksChanged,
	publishAgentTasks,
} from "../_shared/agent-tasks.ts";
import * as forkSettings from "../_shared/settings.ts";
import { STATUS_KEYS } from "../_shared/status-keys.ts";
import { deliverOrHold } from "../background-bash/notification-hold.ts";
import { createSubagentPolicySnapshot, evaluateSubagentDelegationDeny } from "../permissions/policy.ts";
import {
	type AgentDefinitionCatalog,
	ALLOWED_SUBAGENT_TOOLS,
	createInlineAgentDefinition,
	discoverAgentDefinitions,
	EXTENDED_SUBAGENTS_RELEASED,
	formatAgentRoutingDescriptions,
	isReadOnlySubagentTools,
	isSubagentThinkingLevel,
	parseSubagentModelSpec,
	resolveAgentDefinition,
	SUBAGENT_THINKING_LEVELS,
	type SubagentModelSpec,
} from "./definitions.ts";
import { buildSubagentResultEnvelope, MAX_PARENT_REPORT_BYTES, type SubagentResultDetails } from "./results.ts";
import {
	captureWorkspaceSnapshot,
	describeSubagentModels,
	resolveChildModelAndRuntime,
	runRestrictedSubagent,
	sanitizeDiagnosticText,
} from "./runner.ts";
import {
	isTerminalSubagentStatus,
	type SubagentRunRecord,
	SubagentRunScheduler,
	type SubagentStopSource,
} from "./runs.ts";
import {
	appendParentRunReference,
	ensureRunStorageDir,
	readBoundedSubagentReport,
	readPersistedRunRecord,
	reconcileInterruptedRuns,
	recordBackgroundUsageInLedger,
	writeFullSubagentReport,
	writePersistedRunRecord,
} from "./storage.ts";

export const MAX_TASK_INPUT_BYTES = 32 * 1024;
export const SUBAGENT_NOTIFICATION_CUSTOM_TYPE = "subagent-notification";
const BACKGROUND_BATCH_WINDOW_MS = 40;

export interface SubagentExtensionOptions {
	agentDir?: string;
	batchWindowMs?: number;
}

function buildBaseSubagentDescription(catalog?: AgentDefinitionCatalog): string {
	const rolesSection = catalog
		? formatAgentRoutingDescriptions(catalog)
		: "- `explorer`: Focused read-only codebase explorer.\n- `reviewer`: Focused read-only code reviewer.";
	return [
		"Delegate a focused, read-only subtask (`explorer` or `reviewer`) to an isolated child agent with a fresh context window.",
		"",
		"When to delegate:",
		"- Multi-file codebase exploration where intermediate search output does not belong in the main conversation.",
		"- Independent code review of a supplied diff or explicit target files.",
		"- Independent read-only investigations that can run in parallel.",
		"",
		"When NOT to delegate (use direct `grep`, `find`, or `read` instead):",
		"- Single-symbol or single-file lookups where the target path is already known.",
		"- Tightly coupled sequential steps where each step depends on the previous result.",
		"- Tasks requiring file edits or shell execution (subagents in M1/M2 are strictly read-only).",
		"",
		"Available subagent roles:",
		rolesSection,
	].join("\n");
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

export function createSubagentsExtension(options: SubagentExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return function subagentsFactory(pi: ExtensionAPI): void {
		const resolveAgentDir = () => options.agentDir ?? getAgentDir();

		let runtimeGeneration = 0;
		let activeCtx: ExtensionContext | undefined;
		let activeParentSessionId: string | undefined;
		let activeTurnIndex = 0;
		let catalog: AgentDefinitionCatalog | undefined;
		let unpublishTasks: (() => void) | undefined;

		// Batching queue for background completion notices per (sessionId, generation)
		let pendingNotices: Array<{
			record: Readonly<SubagentRunRecord>;
			parentText: string;
			details: SubagentResultDetails;
		}> = [];
		let batchTimer: ReturnType<typeof setTimeout> | undefined;

		const isOwnedAndValid = (record: Readonly<SubagentRunRecord>, checkBranch = true): boolean => {
			if (!activeCtx) return false;
			if (runtimeGeneration !== record.runtimeGeneration) return false;
			try {
				const currentSessionId = activeCtx.sessionManager?.getSessionId?.();
				if (!currentSessionId || currentSessionId !== record.parentSessionId) return false;
				if (checkBranch && record.originEntryId) {
					const branch = activeCtx.sessionManager?.getBranch?.() ?? [];
					if (!branch.some((entry: { id?: string }) => entry.id === record.originEntryId)) return false;
				}
				return true;
			} catch {
				// SDK disposal can invalidate the context without emitting session_shutdown.
				return false;
			}
		};

		const refreshFooterStatus = () => {
			try {
				if (!activeCtx?.hasUI) return;
				const activeRuns = scheduler.listActiveRuns(activeParentSessionId);
				if (activeRuns.length === 0) {
					activeCtx.ui.setStatus(STATUS_KEYS.subagents, undefined);
				} else {
					const runningCount = activeRuns.filter((r) => r.status === "running" || r.status === "starting").length;
					const stoppingCount = activeRuns.filter((r) => r.status === "stopping").length;
					const parts: string[] = [];
					if (runningCount > 0) parts.push(`${runningCount} subagent${runningCount === 1 ? "" : "s"}`);
					if (stoppingCount > 0) parts.push(`${stoppingCount} stopping`);
					activeCtx.ui.setStatus(STATUS_KEYS.subagents, activeCtx.ui.theme.fg("dim", parts.join(" · ")));
				}
			} catch {
				// Ignore stale UI context errors
			}
		};

		const flushPendingBackgroundNotices = () => {
			batchTimer = undefined;
			if (pendingNotices.length === 0) return;
			const batch = pendingNotices.splice(0);
			const deliveringGeneration = runtimeGeneration;
			const deliveringSessionId = activeParentSessionId;

			deliverOrHold(() => {
				if (!activeCtx || runtimeGeneration !== deliveringGeneration) return;
				if (activeParentSessionId !== deliveringSessionId) return;

				const validItems = batch.filter((item) => isOwnedAndValid(item.record, true));
				if (validItems.length === 0) return;

				const combinedText =
					validItems.length === 1
						? validItems[0].parentText
						: [
								`[${validItems.length} background subagents finished]`,
								...validItems.map((item) => item.parentText),
							].join("\n\n---\n\n");

				pi.sendMessage(
					{
						customType: SUBAGENT_NOTIFICATION_CUSTOM_TYPE,
						content: [{ type: "text", text: combinedText }],
						display: true,
						details:
							validItems.length === 1
								? validItems[0].details
								: {
										runs: validItems.map((item) => item.details),
									},
					},
					{
						deliverAs: "followUp",
						triggerTurn: true,
					},
				);
			});
		};

		const scheduleBackgroundDelivery = (
			record: Readonly<SubagentRunRecord>,
			parentText: string,
			details: SubagentResultDetails,
		) => {
			// User-initiated, remote-initiated, or session-invalidation stops must not trigger an unsolicited new parent turn
			if (
				record.stopSource === "user" ||
				record.stopSource === "remote" ||
				record.stopSource === "session_invalidated"
			) {
				return;
			}
			if (!isOwnedAndValid(record, true)) {
				return;
			}
			pendingNotices.push({ record, parentText, details });
			const windowMs = options.batchWindowMs ?? BACKGROUND_BATCH_WINDOW_MS;
			if (windowMs <= 0) {
				flushPendingBackgroundNotices();
				return;
			}
			if (!batchTimer) {
				batchTimer = setTimeout(flushPendingBackgroundNotices, windowMs);
				batchTimer.unref?.();
			}
		};

		interface RunExecutionContext {
			agentDir: string;
			definition: NonNullable<ReturnType<typeof resolveAgentDefinition>["definition"]>;
			task: string;
			policySnapshot: NonNullable<ReturnType<typeof createSubagentPolicySnapshot>["snapshot"]>;
			requestedModel: SubagentModelSpec;
			parentModel: ExtensionContext["model"];
			requestedThinkingLevel: string;
			parentModelRegistry: ExtensionContext["modelRegistry"];
			projectTrusted: boolean;
		}

		const scheduler = new SubagentRunScheduler({
			onStateChange: (record) => {
				const agentDir = resolveAgentDir();
				writePersistedRunRecord(agentDir, record);
				if (record.lastProgressText && !isTerminalSubagentStatus(record.status)) {
					writeFullSubagentReport(
						agentDir,
						record,
						`Run: ${record.runId} (${record.agentName})\nStatus: ${record.status}\n\n${record.lastProgressText}`,
					);
				}
				refreshFooterStatus();
				notifyAgentTasksChanged();
			},
			executeRun: async (params) => {
				const execCtx = params.context as RunExecutionContext;
				const storage = ensureRunStorageDir(execCtx.agentDir, params.record.parentSessionId, params.record.runId);
				if (!storage.ok || !storage.runDir) throw new Error(storage.error ?? "Subagent storage is unavailable.");
				return runRestrictedSubagent({
					...params,
					agentDir: execCtx.agentDir,
					definition: execCtx.definition,
					task: execCtx.task,
					policySnapshot: execCtx.policySnapshot,
					requestedModel: execCtx.requestedModel,
					parentModel: execCtx.parentModel,
					requestedThinkingLevel: execCtx.requestedThinkingLevel,
					parentModelRegistry: execCtx.parentModelRegistry,
					projectTrusted: execCtx.projectTrusted,
					childSessionDir: storage.runDir,
				});
			},
		});

		const finalizeAndPersistRun = (
			agentDir: string,
			completedRecord: Readonly<SubagentRunRecord>,
			deliveryMode: "foreground" | "background",
		) => {
			const mutableRecord: SubagentRunRecord = structuredClone(completedRecord);
			const initialEnvelope = buildSubagentResultEnvelope(mutableRecord, MAX_PARENT_REPORT_BYTES);
			const reportRes = writeFullSubagentReport(agentDir, mutableRecord, initialEnvelope.fullReportText);
			if (reportRes.ok && reportRes.reportPath) {
				mutableRecord.reportPath = reportRes.reportPath;
			} else {
				mutableRecord.reportPath = undefined;
			}
			if (deliveryMode === "foreground") {
				mutableRecord.foregroundUsageAttributed = true;
			} else {
				mutableRecord.backgroundDeliveryAttempted = true;
				recordBackgroundUsageInLedger(agentDir, mutableRecord);
			}

			writePersistedRunRecord(agentDir, mutableRecord);
			if (isOwnedAndValid(mutableRecord, false)) {
				appendParentRunReference(pi, mutableRecord);
			}
			const finalEnvelope = buildSubagentResultEnvelope(mutableRecord, MAX_PARENT_REPORT_BYTES);
			refreshFooterStatus();
			notifyAgentTasksChanged();
			return { record: mutableRecord, envelope: finalEnvelope };
		};

		const taskSource: AgentTaskSource = {
			list: (owner?: string): AgentTaskInfo[] => {
				const targetOwner = owner ?? activeParentSessionId;
				const agentDir = resolveAgentDir();
				return scheduler.listActiveRuns(targetOwner).map((run) => {
					const reportFile = join(agentDir, "bluclawd", "subagents", run.parentSessionId, run.runId, "report.md");
					return {
						id: run.runId,
						owner: run.parentSessionId,
						agent: run.agentName,
						task: run.taskSummary || run.agentName,
						startedAt: run.startedAt ?? run.admittedAt,
						status: run.status,
						model: `${run.provider}/${run.modelId}`,
						outputFile: reportFile,
						output: () => {
							const bounded = readBoundedSubagentReport(agentDir, run.parentSessionId, run.runId, 8192);
							return bounded.ok && bounded.content ? bounded.content : (run.lastProgressText ?? "");
						},
					};
				});
			},
			stop: (id: string, stopOptions?: { owner?: string; source?: SubagentStopSource }): boolean => {
				const run = scheduler.getRun(id);
				if (!run) return false;
				const expectedOwner = stopOptions?.owner ?? activeParentSessionId;
				if (expectedOwner && run.parentSessionId !== expectedOwner) {
					return false;
				}
				return scheduler.cancelRun(id, stopOptions?.source ?? "user", `Stopped subagent ${id}`);
			},
			getReport: (id: string, owner?: string): string | undefined => {
				const targetOwner = owner ?? activeParentSessionId;
				if (!targetOwner) return undefined;
				const agentDir = resolveAgentDir();
				const res = readBoundedSubagentReport(agentDir, targetOwner, id);
				return res.ok ? res.content : undefined;
			},
			getRun: (id: string, owner?: string): Readonly<SubagentRunRecord> | undefined => {
				const targetOwner = owner ?? activeParentSessionId;
				const live = scheduler.getRun(id);
				if (live) {
					if (targetOwner && live.parentSessionId !== targetOwner) return undefined;
					return live;
				}
				if (!targetOwner) return undefined;
				return readPersistedRunRecord(resolveAgentDir(), targetOwner, id);
			},
		};

		const invalidateCurrentSessionRuns = (reason: string) => {
			runtimeGeneration++;
			if (batchTimer) {
				clearTimeout(batchTimer);
				batchTimer = undefined;
			}
			pendingNotices = [];
			if (activeParentSessionId) {
				scheduler.cancelRunsForSession(activeParentSessionId, "session_invalidated", reason);
			}
			refreshFooterStatus();
			notifyAgentTasksChanged();
		};

		pi.on("session_start", async (event, ctx) => {
			if (activeParentSessionId) {
				invalidateCurrentSessionRuns(`Session replaced (${event.reason})`);
			}
			runtimeGeneration++;
			activeCtx = ctx;
			activeParentSessionId = ctx.sessionManager.getSessionId();
			activeTurnIndex = 0;

			const agentDir = resolveAgentDir();
			const projectTrusted = ctx.isProjectTrusted();
			catalog = discoverAgentDefinitions({
				cwd: ctx.cwd,
				agentDir,
				projectTrusted,
			});

			for (const diag of catalog.diagnostics) {
				if (ctx.hasUI) {
					ctx.ui.notify(`subagents: ${diag}`, "warning");
				}
			}

			// Detect conflicting third-party `subagent` tool registrations
			const allTools = pi.getAllTools?.() ?? [];
			const subagentTools = allTools.filter((t) => t.name === "subagent");
			const hasConflict =
				subagentTools.length > 1 ||
				subagentTools.some((t) => !t.description?.startsWith("Delegate a focused, read-only subtask"));
			if (hasConflict) {
				ctx.ui.notify(
					"Conflicting third-party `subagent` tool registration detected; bluclawd's subagent tool must be unique.",
					"warning",
				);
			}

			// Reconcile orphaned runs referenced on the active branch from prior crashes
			const branchEntries = ctx.sessionManager.getBranch();
			const liveIds = new Set(scheduler.listActiveRuns(activeParentSessionId).map((r) => r.runId));
			reconcileInterruptedRuns(agentDir, activeParentSessionId, branchEntries, liveIds);

			unpublishTasks?.();
			unpublishTasks = publishAgentTasks(taskSource);
			refreshFooterStatus();
		});

		pi.on("turn_start", async () => {
			activeTurnIndex++;
		});

		pi.on("session_before_switch", async () => {
			invalidateCurrentSessionRuns("Parent session switching");
			return undefined;
		});

		pi.on("session_before_fork", async () => {
			invalidateCurrentSessionRuns("Parent session forking");
			return undefined;
		});

		pi.on("session_tree", async (_event, ctx) => {
			activeCtx = ctx;
			const sessionId = ctx.sessionManager.getSessionId();
			const activeEntryIds = new Set<string>(ctx.sessionManager.getBranch().map((entry) => entry.id));
			scheduler.cancelRunsNotOnBranch(
				sessionId,
				activeEntryIds,
				"Originating branch is no longer active after tree navigation",
			);
			refreshFooterStatus();
			notifyAgentTasksChanged();
		});

		pi.on("session_shutdown", async () => {
			invalidateCurrentSessionRuns("Parent session shutting down");
			unpublishTasks?.();
			unpublishTasks = undefined;
			activeCtx = undefined;
		});

		pi.registerTool({
			name: "subagent_models",
			label: "Subagent models",
			exposure: "model-only",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			description:
				"List models a subagent can run with: provider/model identity, auth status, supported thinking levels, and execution support. Pass the result's provider/id as the subagent `model`.",
			parameters: Type.Object({
				provider: Type.Optional(Type.String({ description: "Only list models from this provider." })),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, toolCtx) => {
				const ctx = toolCtx ?? activeCtx;
				if (!ctx) {
					return {
						content: [{ type: "text", text: "Subagent runtime is not initialized for this session." }],
						details: undefined,
						isError: true,
					};
				}
				const models = describeSubagentModels(ctx.modelRegistry, params.provider);
				return { content: [{ type: "text", text: JSON.stringify({ models }) }], details: undefined };
			},
		});

		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			exposure: "model-only",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
			description: buildBaseSubagentDescription(),
			prepareLoadout: (loadout: ToolLoadout): ToolLoadoutChanges | undefined => {
				if (!catalog) return undefined;
				if (!loadout.declared.some((t) => t.name === "subagent")) return undefined;
				return {
					descriptions: {
						subagent: buildBaseSubagentDescription(catalog),
					},
				};
			},
			parameters: Type.Object({
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
							thinkingLevel: Type.Optional(
								Type.String({ description: "Default thinking level for this role." }),
							),
						},
						{ additionalProperties: false, description: "Inline role used only for this run." },
					),
				]),
				task: Type.String({
					description:
						"Self-contained task instructions with explicit file paths, symbols, or diff context (max 32 KiB).",
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
			}),
			execute: async (toolCallId, params, signal, _onUpdate, toolCtx) => {
				const ctx = toolCtx ?? activeCtx;
				if (!ctx) {
					return {
						content: [{ type: "text", text: "Subagent runtime is not initialized for this session." }],
						details: undefined,
						isError: true,
					};
				}

				const dispatchGeneration = runtimeGeneration;
				const parentSessionId = ctx.sessionManager.getSessionId();
				const originEntryId = ctx.sessionManager.getLeafId() ?? undefined;
				const turnId = `turn_${activeTurnIndex}`;
				const agentDir = resolveAgentDir();
				const cwd = ctx.cwd;
				const projectTrusted = ctx.isProjectTrusted();
				const inlineRole = typeof params.agent === "string" ? undefined : params.agent;
				const agentName = (typeof params.agent === "string" ? params.agent : params.agent.name).trim();
				const taskText = params.task ?? "";
				const isBackground = params.background === true;

				if (!agentName && !inlineRole) {
					return {
						content: [{ type: "text", text: "Missing required parameter: agent" }],
						details: undefined,
						isError: true,
					};
				}
				if (!taskText.trim()) {
					return {
						content: [{ type: "text", text: "Missing required parameter: task" }],
						details: undefined,
						isError: true,
					};
				}
				const taskBytes = Buffer.byteLength(taskText, "utf8");
				if (taskBytes > MAX_TASK_INPUT_BYTES) {
					return {
						content: [
							{
								type: "text",
								text: `Delegated task exceeds the ${MAX_TASK_INPUT_BYTES}-byte limit (${taskBytes} bytes). Supply target file paths instead of pasting large file contents.`,
							},
						],
						details: undefined,
						isError: true,
					};
				}

				// 1. Evaluate parent Subagent / Subagent(agentName) deny rules BEFORE admission or model activity
				const sm = SettingsManager.create(cwd, agentDir, { projectTrusted });
				const denyRules = forkSettings.denyRules(sm);
				const delegationDeny = evaluateSubagentDelegationDeny(denyRules, agentName, cwd);
				if (delegationDeny.blocked) {
					return {
						content: [{ type: "text", text: delegationDeny.reason ?? "Blocked by permission rule" }],
						details: undefined,
						isError: true,
					};
				}

				// 2. Reject background mode in unsupported one-shot modes (print/json)
				if (isBackground && (ctx.mode === "print" || ctx.mode === "json")) {
					return {
						content: [
							{
								type: "text",
								text: `Background subagents are not supported in one-shot "${ctx.mode}" mode because the process exits before background completion. Omit background: true to run in the foreground.`,
							},
						],
						details: undefined,
						isError: true,
					};
				}

				// 3. Validate an inline role, or resolve a saved one from the frozen catalog (discovered once if session_start was skipped)
				const resolvedDef = inlineRole
					? createInlineAgentDefinition(inlineRole)
					: resolveAgentDefinition(
							catalog ??
								discoverAgentDefinitions({
									cwd,
									agentDir,
									projectTrusted,
								}),
							agentName,
						);
				if (!resolvedDef.ok || !resolvedDef.definition) {
					return {
						content: [{ type: "text", text: resolvedDef.error ?? `Unknown subagent "${agentName}"` }],
						details: undefined,
						isError: true,
					};
				}
				const definition = resolvedDef.definition;
				// Omitted tools stay read-only until parent-authority dispatch replaces this runner.
				const requestedTools = definition.tools ?? ALLOWED_SUBAGENT_TOOLS;
				if (!isReadOnlySubagentTools(requestedTools)) {
					return {
						content: [
							{
								type: "text",
								text: !EXTENDED_SUBAGENTS_RELEASED
									? "Isolated subagent execution is not released; shell/write capabilities remain disabled."
									: "Isolated subagent execution backend is unavailable.",
							},
						],
						details: undefined,
						isError: true,
					};
				}

				// 4. Validate child read-policy snapshot
				const policyRes = createSubagentPolicySnapshot({
					cwd,
					denyRules,
					allowedTools: requestedTools,
				});
				if (!policyRes.ok || !policyRes.snapshot) {
					return {
						content: [
							{
								type: "text",
								text: `Refusing to launch subagent "${agentName}": ${policyRes.error ?? "invalid policy snapshot"}`,
							},
						],
						details: undefined,
						isError: true,
					};
				}

				// 5. Resolve spawn > role > parent model and thinking, and verify them before admission
				const spawnModel = params.model === undefined ? undefined : parseSubagentModelSpec(params.model);
				if (params.model !== undefined && !spawnModel) {
					return {
						content: [
							{
								type: "text",
								text: `Invalid subagent "model" value "${params.model}": must be "inherit" or explicit "provider/model".`,
							},
						],
						details: undefined,
						isError: true,
					};
				}
				if (
					params.thinkingLevel !== undefined &&
					params.thinkingLevel !== "inherit" &&
					!isSubagentThinkingLevel(params.thinkingLevel)
				) {
					return {
						content: [
							{
								type: "text",
								text: `Invalid subagent "thinkingLevel" value "${params.thinkingLevel}": must be "inherit" or one of ${SUBAGENT_THINKING_LEVELS.join(", ")}.`,
							},
						],
						details: undefined,
						isError: true,
					};
				}
				const parentThinkingLevel = pi.getThinkingLevel();
				const requestedModel = spawnModel ?? definition.model;
				const requestedThinkingLevel =
					params.thinkingLevel === "inherit"
						? parentThinkingLevel
						: (params.thinkingLevel ?? definition.thinkingLevel ?? parentThinkingLevel);
				const modelCheck = await resolveChildModelAndRuntime({
					agentDir,
					requestedModel,
					parentModel: ctx.model,
					requestedThinkingLevel,
					parentModelRegistry: ctx.modelRegistry,
				});
				if (!modelCheck.ok || !modelCheck.model || !modelCheck.thinkingLevel) {
					return {
						content: [
							{
								type: "text",
								text: sanitizeDiagnosticText(
									modelCheck.error ?? `Could not resolve model for subagent "${agentName}".`,
								),
							},
						],
						details: undefined,
						isError: true,
					};
				}

				if (
					runtimeGeneration !== dispatchGeneration ||
					(activeParentSessionId && activeParentSessionId !== parentSessionId) ||
					(originEntryId && !ctx.sessionManager.getBranch().some((entry) => entry.id === originEntryId))
				) {
					return {
						content: [
							{
								type: "text",
								text: "Parent session or branch changed before subagent admission; request cancelled.",
							},
						],
						details: undefined,
						isError: true,
					};
				}
				const startSnapshot = captureWorkspaceSnapshot(cwd);

				// 6. Check storage availability before launching
				const probeDir = ensureRunStorageDir(agentDir, parentSessionId, "probe_check");
				if (!probeDir.ok) {
					return {
						content: [
							{
								type: "text",
								text: `Cannot launch subagent: storage is unavailable (${probeDir.error ?? "storage check failed"}).`,
							},
						],
						details: undefined,
						isError: true,
					};
				}

				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "Subagent request was aborted before admission." }],
						details: undefined,
						isError: true,
					};
				}

				const execContext: RunExecutionContext = {
					agentDir,
					definition,
					task: taskText,
					policySnapshot: policyRes.snapshot,
					requestedModel,
					parentModel: ctx.model,
					requestedThinkingLevel,
					parentModelRegistry: ctx.modelRegistry,
					projectTrusted,
				};

				const admitRes = scheduler.admit({
					parentSessionId,
					runtimeGeneration: dispatchGeneration,
					parentTurnId: turnId,
					originToolCallId: toolCallId,
					originEntryId,
					agentName: definition.name,
					definitionSource: definition.source,
					provider: modelCheck.model.provider,
					modelId: modelCheck.model.id,
					thinkingLevel: modelCheck.thinkingLevel,
					cwd,
					taskSummary: summarizeTaskLabel(taskText),
					startSnapshot,
					deliveryMode: isBackground ? "background" : "foreground",
					// Foreground runs link to the invoking tool call's signal; background runs outlive the launch tool call
					signal: isBackground ? undefined : signal,
					context: execContext,
				});

				if (!admitRes.ok || !admitRes.handle) {
					return {
						content: [{ type: "text", text: admitRes.error ?? "Subagent admission rejected." }],
						details: undefined,
						isError: true,
					};
				}

				const { handle } = admitRes;
				writePersistedRunRecord(agentDir, handle.record);
				writeFullSubagentReport(
					agentDir,
					handle.record,
					`Run: ${handle.runId} (${definition.name})\nStatus: ${handle.record.status}\nTask: ${handle.record.taskSummary}`,
				);
				appendParentRunReference(pi, handle.record);
				refreshFooterStatus();
				notifyAgentTasksChanged();

				if (isBackground) {
					void handle.completion.then((completedRecord) => {
						const { record: persistedRecord, envelope } = finalizeAndPersistRun(
							agentDir,
							completedRecord,
							"background",
						);
						scheduleBackgroundDelivery(persistedRecord, envelope.parentText, envelope.details);
					});

					return {
						content: [
							{
								type: "text",
								text: [
									`Background subagent launched: ${handle.runId}`,
									`Agent: ${definition.name} (${modelCheck.model.provider}/${modelCheck.model.id})`,
									`Status: ${handle.record.status}`,
									"The final report will be delivered to this session branch when complete. Use `task_stop` with this run ID to cancel.",
								].join("\n"),
							},
						],
						details: {
							runId: handle.runId,
							agentName: definition.name,
							status: handle.record.status,
							complete: false,
							deliveryMode: "background",
							provider: modelCheck.model.provider,
							modelId: modelCheck.model.id,
							thinkingLevel: modelCheck.thinkingLevel,
							turnCount: 0,
							toolCallCount: 0,
							snapshotDrifted: false,
							truncated: false,
						} satisfies SubagentResultDetails,
					};
				}

				const completedRecord = await handle.completion;
				const { envelope } = finalizeAndPersistRun(agentDir, completedRecord, "foreground");

				return {
					content: [{ type: "text", text: envelope.parentText }],
					details: envelope.details,
					usage: envelope.usage,
					isError: envelope.isError,
				};
			},
		});
	};
}

const subagentsExtension: InlineExtension = {
	name: "subagents",
	factory: createSubagentsExtension(),
};
export default subagentsExtension.factory;
