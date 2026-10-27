import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
	getAgentDir,
	type InlineExtension,
	SettingsManager,
	type ToolDefinition,
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
import { evaluateSubagentDelegationDeny } from "../permissions/policy.ts";
import {
	type AgentDefinitionCatalog,
	createInlineAgentDefinition,
	discoverAgentDefinitions,
	formatAgentRoutingDescriptions,
	isSubagentThinkingLevel,
	parseSubagentModelSpec,
	resolveAgentDefinition,
	SUBAGENT_THINKING_LEVELS,
	type SubagentModelSpec,
} from "./definitions.ts";
import {
	PARENT_MESSAGE_ADDRESS,
	SUBAGENT_MESSAGE_TOOL,
	SubagentMessageBus,
	type SubagentMessageReceipt,
	type SubagentMessageScope,
	subagentMessagePayload,
} from "./messages.ts";
import { buildSubagentResultEnvelope, MAX_PARENT_REPORT_BYTES, type SubagentResultDetails } from "./results.ts";
import {
	captureWorkspaceSnapshot,
	createParentToolProxies,
	describeSubagentModels,
	resolveChildModelAndRuntime,
	runSubagent,
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
	appendSubagentMessageRecord,
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
const SUBAGENT_DESCRIPTION_LEAD = "Delegate a task to a child agent that works in this same checkout";
/** Pi built-in extensions a child runs itself, over its own copies of the orchestrator's tools. */
const CHILD_BUILTIN_EXTENSIONS = ["codemode", "tool_search"];

export interface SubagentExtensionOptions {
	agentDir?: string;
	batchWindowMs?: number;
}

function buildBaseSubagentDescription(catalog?: AgentDefinitionCatalog): string {
	const rolesSection = catalog
		? formatAgentRoutingDescriptions(catalog)
		: "- `general-purpose`: Implementation work.\n- `explorer`: Codebase exploration.\n- `reviewer`: Code review.";
	return [
		`${SUBAGENT_DESCRIPTION_LEAD}, with your tools and permission rules and a fresh context window. Children cannot delegate further.`,
		"",
		"You own the split. Give each child a distinct task over separate files or areas: there are no locks, edits are live for you and every sibling, and the last write wins. Verify the combined result yourself.",
		"",
		"When to delegate:",
		"- Independent pieces of work that can run in parallel.",
		"- Exploration or review whose intermediate output does not belong in the main conversation.",
		"",
		"When NOT to delegate:",
		"- Single-file lookups or edits you can do directly.",
		"- Tightly coupled sequential steps where each step depends on the previous result.",
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
		let latestLoadout: ToolLoadout | undefined;
		/** Runs whose launch tool result the parent has emitted; the SDK no longer attributes their nested usage. */
		const emittedLaunchResults = new Set<string>();

		// Batching queue for background completion notices per (sessionId, generation)
		let pendingNotices: Array<{
			record: Readonly<SubagentRunRecord>;
			parentText: string;
			details: SubagentResultDetails;
		}> = [];
		let batchTimer: ReturnType<typeof setTimeout> | undefined;
		const messageBus = new SubagentMessageBus((record, senderScope) =>
			appendSubagentMessageRecord(resolveAgentDir(), senderScope.parentSessionId, { ...record, at: Date.now() }),
		);

		const messageParameters = Type.Object(
			{
				to: Type.String({ description: 'Recipient: a subagent run ID (sub_…) or "parent" for the orchestrator.' }),
				content: Type.String({ description: "Message text." }),
			},
			{ additionalProperties: false },
		);
		const formatReceipt = (receipt: SubagentMessageReceipt) => ({
			content: [
				{
					type: "text" as const,
					text:
						receipt.status === "accepted"
							? `Message ${receipt.seq} accepted for delivery (not yet handled).`
							: `Message ${receipt.seq} ${receipt.status}: ${receipt.reason ?? ""}`,
				},
			],
			details: receipt,
			isError: receipt.status !== "accepted",
		});
		const createChildMessageTool = (address: string, scope: SubagentMessageScope): ToolDefinition =>
			defineTool({
				name: SUBAGENT_MESSAGE_TOOL,
				label: "Message agent",
				description: `Send a short message to the orchestrator ("parent") or a sibling subagent run ID while you work. Your run ID is ${address}. An unknown recipient's receipt lists who is reachable. Delivery is not a reply; keep working.`,
				parameters: messageParameters,
				execute: async (_toolCallId, params) =>
					formatReceipt(await messageBus.send({ address, scope }, params.to.trim(), params.content)),
			});

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
			parent: ExtensionToolContext;
			loadout: ToolLoadout;
			proxiedToolNames: readonly string[];
			activeToolNames: readonly string[];
			builtinExtensions: readonly string[];
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
			onFinalize: async (settledRecord) => {
				const agentDir = resolveAgentDir();
				const record: SubagentRunRecord = structuredClone(settledRecord);
				const reportRes = writeFullSubagentReport(
					agentDir,
					record,
					buildSubagentResultEnvelope(record, MAX_PARENT_REPORT_BYTES).fullReportText,
				);
				if (!reportRes.ok || !reportRes.reportPath) {
					throw new Error(reportRes.error ?? "full report was not persisted");
				}
				record.reportPath = reportRes.reportPath;
				if (record.deliveryMode === "foreground") {
					record.foregroundUsageAttributed = true;
				} else {
					record.backgroundDeliveryAttempted = true;
					recordBackgroundUsageInLedger(agentDir, record);
				}
				const recordRes = writePersistedRunRecord(agentDir, record);
				if (!recordRes.ok) throw new Error(recordRes.error ?? "run record was not persisted");
				if (isOwnedAndValid(record, false)) {
					appendParentRunReference(pi, record);
				}
				return record;
			},
			executeRun: async (params) => {
				const execCtx = params.context as RunExecutionContext;
				const storage = ensureRunStorageDir(execCtx.agentDir, params.record.parentSessionId, params.record.runId);
				if (!storage.ok || !storage.runDir) throw new Error(storage.error ?? "Subagent storage is unavailable.");
				const { runId } = params.record;
				const scope = {
					parentSessionId: params.record.parentSessionId,
					runtimeGeneration: params.record.runtimeGeneration,
				};
				// Messages sent while the child session is still being created wait for it, or fail if it never starts.
				let resolveSession!: (session: AgentSession) => void;
				let rejectSession!: (err: Error) => void;
				const sessionReady = new Promise<AgentSession>((resolve, reject) => {
					resolveSession = resolve;
					rejectSession = reject;
				});
				sessionReady.catch(() => {});
				messageBus.register(runId, {
					scope,
					deliver: async (message) => {
						if (scheduler.getRun(runId)?.status === "stopping") throw new Error("it is stopping");
						const childSession = await sessionReady;
						// A message never starts a turn on its own; it waits for the child's next safe boundary.
						await childSession.sendCustomMessage(subagentMessagePayload(message), {
							deliverAs: "steer",
							triggerTurn: false,
						});
					},
				});
				// Nested usage is folded into the launch tool result until it is emitted; later usage is counted here.
				const parentTools = createParentToolProxies(
					execCtx.parent,
					execCtx.loadout,
					execCtx.proxiedToolNames,
					(usage) => {
						if (emittedLaunchResults.has(runId)) params.controller.recordUsage(usage);
					},
				);
				try {
					return await runSubagent({
						...params,
						agentDir: execCtx.agentDir,
						definition: execCtx.definition,
						task: execCtx.task,
						requestedModel: execCtx.requestedModel,
						parentModel: execCtx.parentModel,
						requestedThinkingLevel: execCtx.requestedThinkingLevel,
						parentModelRegistry: execCtx.parentModelRegistry,
						projectTrusted: execCtx.projectTrusted,
						childSessionDir: storage.runDir,
						childTools: [...parentTools, createChildMessageTool(runId, scope)],
						activeToolNames: [...execCtx.activeToolNames, SUBAGENT_MESSAGE_TOOL],
						builtinExtensions: execCtx.builtinExtensions,
						onChildSessionCreated: (session) => {
							session.subscribe((event) => {
								if (event.type === "agent_end") messageBus.unregister(runId, "has finished");
							});
							resolveSession(session);
						},
					});
				} finally {
					rejectSession(new Error("it ended before it could receive messages"));
					messageBus.unregister(runId, "has finished");
					emittedLaunchResults.delete(runId);
				}
			},
		});

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

		const registerParentEndpoint = () => {
			if (!activeParentSessionId) return;
			const scope = { parentSessionId: activeParentSessionId, runtimeGeneration };
			messageBus.register(PARENT_MESSAGE_ADDRESS, {
				scope,
				deliver: async (message) => {
					deliverOrHold(() => {
						if (!activeCtx || runtimeGeneration !== scope.runtimeGeneration) return;
						if (activeParentSessionId !== scope.parentSessionId) return;
						// Like background completion notices, a child's message wakes an idle orchestrator.
						pi.sendMessage(subagentMessagePayload(message), { deliverAs: "steer", triggerTurn: true });
					});
				},
			});
		};

		const invalidateCurrentSessionRuns = (reason: string) => {
			runtimeGeneration++;
			// Children of the old generation now get "invalidated" when they message the orchestrator.
			registerParentEndpoint();
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

		const runLaunchedBy = (toolCallId: string) =>
			scheduler.listActiveRuns(activeParentSessionId).find((run) => run.originToolCallId === toolCallId);

		pi.on("message_start", async (event) => {
			if (event.message.role !== "toolResult") return;
			const run = runLaunchedBy(event.message.toolCallId);
			if (run) emittedLaunchResults.add(run.runId);
		});

		// A child's tool calls arrive here as nested calls of the tool call that launched it.
		pi.on("tool_call", async (event) => {
			if (!event.parentToolCallId || event.toolName !== "task_stop") return undefined;
			if (!runLaunchedBy(event.parentToolCallId)) return undefined;
			const input = event.input as { task_id?: unknown; shell_id?: unknown };
			const id = String(input.task_id ?? input.shell_id ?? "").trim();
			if (!scheduler.getRun(id) && !id.startsWith("sub_")) return undefined;
			return { block: true, reason: "Subagents cannot stop agent runs; message the orchestrator instead." };
		});

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
				subagentTools.some((t) => !t.description?.startsWith(SUBAGENT_DESCRIPTION_LEAD));
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
			registerParentEndpoint();
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
			messageBus.unregister(PARENT_MESSAGE_ADDRESS, "has shut down");
			await scheduler.waitForSettled();
			unpublishTasks?.();
			unpublishTasks = undefined;
			activeCtx = undefined;
		});

		pi.registerTool({
			name: SUBAGENT_MESSAGE_TOOL,
			label: "Message agent",
			exposure: "model-only",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
			description:
				"Send a message to a running subagent by run ID (sub_…). It reaches the child at its next safe point without starting a new turn; the receipt says accepted, unavailable, or invalidated, never handled.",
			parameters: messageParameters,
			execute: async (_toolCallId, params) => {
				if (!activeParentSessionId) {
					return {
						content: [{ type: "text", text: "Subagent runtime is not initialized for this session." }],
						details: undefined,
						isError: true,
					};
				}
				const scope = { parentSessionId: activeParentSessionId, runtimeGeneration };
				return formatReceipt(
					await messageBus.send({ address: PARENT_MESSAGE_ADDRESS, scope }, params.to.trim(), params.content),
				);
			},
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
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
			description: buildBaseSubagentDescription(),
			prepareLoadout: (loadout: ToolLoadout): ToolLoadoutChanges | undefined => {
				latestLoadout = loadout;
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

				// 4. Give the child the orchestrator's callable tools, narrowed by the role's tool list
				if (!toolCtx || !latestLoadout) {
					return {
						content: [{ type: "text", text: "Subagent dispatch needs the orchestrator's live tool context." }],
						details: undefined,
						isError: true,
					};
				}
				const loadout = latestLoadout;
				const declaredNames = new Set(loadout.declared.map((tool) => tool.name));
				const callableNames = loadout.callable.map((tool) => tool.name);
				const builtinNames = CHILD_BUILTIN_EXTENSIONS.filter((name) => declaredNames.has(name));
				const availableNames = [...callableNames, ...builtinNames];
				const unknownTools = definition.tools?.filter((name) => !availableNames.includes(name)) ?? [];
				if (unknownTools.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: `Subagent role "${definition.name}" names tools the orchestrator cannot give a child: ${unknownTools.join(", ")}. Available: ${availableNames.join(", ") || "none"}.`,
							},
						],
						details: undefined,
						isError: true,
					};
				}
				const selectedNames = definition.tools ?? availableNames;

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
					parent: toolCtx,
					loadout,
					proxiedToolNames: callableNames.filter((name) => selectedNames.includes(name)),
					activeToolNames: selectedNames.filter((name) => declaredNames.has(name)),
					builtinExtensions: builtinNames.filter((name) => selectedNames.includes(name)),
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
						const envelope = buildSubagentResultEnvelope(completedRecord, MAX_PARENT_REPORT_BYTES);
						scheduleBackgroundDelivery(completedRecord, envelope.parentText, envelope.details);
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
				const envelope = buildSubagentResultEnvelope(completedRecord, MAX_PARENT_REPORT_BYTES);

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
