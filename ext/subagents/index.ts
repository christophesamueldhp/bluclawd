import { Type } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	type InlineExtension,
	type ToolLoadout,
	type ToolLoadoutChanges,
} from "@earendil-works/pi-coding-agent";
import { isAgentTaskId, notifyAgentTasksChanged, publishAgentTasks } from "../_shared/agent-tasks.ts";
import { STATUS_KEYS } from "../_shared/status-keys.ts";
import { type AdmissionContext, createRunAdmission, formatRunLabel, SUBAGENT_TOOL_PARAMETERS } from "./admission.ts";
import {
	type AgentDefinitionCatalog,
	discoverAgentDefinitions,
	formatAgentRoutingDescriptions,
} from "./definitions.ts";
import { createGenerations, type ParentNotice } from "./generations.ts";
import {
	formatMessageReceipt,
	PARENT_MESSAGE_ADDRESS,
	SUBAGENT_MESSAGE_CUSTOM_TYPE,
	SUBAGENT_MESSAGE_PARAMETERS,
	SUBAGENT_MESSAGE_TOOL,
	SubagentMessageBus,
	type SubagentMessageReceipt,
	subagentMessagePayload,
} from "./messages.ts";
import { createParentScope, type ParentInboxItem, type ParentScope } from "./parent-scope.ts";
import type { SubagentResultDetails } from "./results.ts";
import { describeSubagentModels, runSubagent } from "./runner.ts";
import type { SubagentRunRecord } from "./runs.ts";
import { appendSubagentMessageRecord, readPersistedRunRecord, reconcileInterruptedRuns } from "./storage.ts";
import { createAgentTaskSource } from "./task-source.ts";

export const SUBAGENT_NOTIFICATION_CUSTOM_TYPE = "subagent-notification";
const BACKGROUND_BATCH_WINDOW_MS = 40;
const SUBAGENT_DESCRIPTION_LEAD = "Delegate a task to a child agent that works in this same checkout";

export interface SubagentExtensionOptions {
	agentDir?: string;
	batchWindowMs?: number;
}

function buildBaseSubagentDescription(catalog?: AgentDefinitionCatalog, oneShot = false): string {
	const rolesSection = catalog
		? formatAgentRoutingDescriptions(catalog)
		: "- `general-purpose`: Implementation work.\n- `explorer`: Codebase exploration.\n- `reviewer`: Code review.";
	return [
		`${SUBAGENT_DESCRIPTION_LEAD}, with your tools and permission rules and a fresh context window. Children cannot delegate further.`,
		"",
		"You own the split. Give each child a distinct task over separate files or areas: there are no locks, edits are live for you and every sibling, and the last write wins. Verify the combined result yourself.",
		"",
		"When to delegate:",
		"- Independent pieces of work that can run in parallel: put their subagent calls together in one message, since calls in separate messages run one after another.",
		"- Exploration or review whose intermediate output does not belong in the main conversation.",
		"",
		"When NOT to delegate:",
		"- Single-file lookups or edits you can do directly.",
		"- Tightly coupled sequential steps where each step depends on the previous result.",
		"",
		...(oneShot ? ["Background runs are unavailable in this one-shot mode: omit `background`.", ""] : []),
		"Available subagent roles:",
		rolesSection,
	].join("\n");
}

export function createSubagentsExtension(options: SubagentExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return function subagentsFactory(pi: ExtensionAPI): void {
		const resolveAgentDir = () => options.agentDir ?? getAgentDir();

		let activeTurnIndex = 0;
		let catalog: AgentDefinitionCatalog | undefined;
		let unpublishTasks: (() => void) | undefined;
		let latestLoadout: ToolLoadout | undefined;
		// Subagent calls in one message start executing together; a child waits for every launch in flight to be
		// admitted, so each sibling is registered for messages before any of them takes a turn.
		let launchesInFlight = 0;
		let launchesSettled = Promise.resolve();
		let settleLaunches = () => {};
		const beginLaunch = () => {
			if (launchesInFlight++ === 0) {
				launchesSettled = new Promise((resolve) => {
					settleLaunches = resolve;
				});
			}
			return () => {
				if (--launchesInFlight === 0) settleLaunches();
			};
		};

		const messageBus = new SubagentMessageBus((record, senderScope) =>
			appendSubagentMessageRecord(resolveAgentDir(), senderScope.parentSessionId, { ...record, at: Date.now() }),
		);
		const parentScope = createParentScope<ParentNotice>({
			bus: messageBus,
			cancelRuns: (where, reason) => scheduler.cancelRuns(where, reason),
			send: (items) => sendToParent(items),
			onChange: () => {
				refreshFooterStatus();
				notifyAgentTasksChanged();
			},
			batchWindowMs: options.batchWindowMs ?? BACKGROUND_BATCH_WINDOW_MS,
		});
		const activeSessionId = () => parentScope.current()?.parentSessionId;

		const senderRole = (address: string) => scheduler.getRun(address)?.agentName;

		const refreshFooterStatus = () => {
			try {
				const ctx = parentScope.context();
				if (!ctx?.hasUI) return;
				const activeRuns = scheduler.listActiveRuns(activeSessionId());
				if (activeRuns.length === 0) {
					ctx.ui.setStatus(STATUS_KEYS.subagents, undefined);
				} else {
					const runningCount = activeRuns.filter((r) => r.status === "running" || r.status === "starting").length;
					const stoppingCount = activeRuns.filter((r) => r.status === "stopping").length;
					const parts: string[] = [];
					if (runningCount > 0) parts.push(`${runningCount} subagent${runningCount === 1 ? "" : "s"}`);
					if (stoppingCount > 0) parts.push(`${stoppingCount} stopping`);
					ctx.ui.setStatus(STATUS_KEYS.subagents, ctx.ui.theme.fg("dim", parts.join(" · ")));
				}
			} catch {
				// Ignore stale UI context errors
			}
		};

		const sendToParent = (items: readonly ParentInboxItem<ParentNotice>[]) => {
			const notices = items.flatMap((item) => (item.kind === "notice" ? [item.notice.details] : []));
			const messages = items.flatMap((item) => (item.kind === "message" ? [item.message] : []));
			const texts = items.map((item) =>
				item.kind === "notice"
					? item.notice.parentText
					: subagentMessagePayload(item.message, senderRole(item.message.from)).content[0].text,
			);
			const combinedText =
				items.length === 1
					? texts[0]
					: [notices.length > 1 ? `[${notices.length} background subagents finished]` : undefined, ...texts]
							.filter((text) => text !== undefined)
							.join("\n\n---\n\n");

			// One message wakes an idle orchestrator once, or steers a busy one at its next boundary.
			try {
				pi.sendMessage(
					{
						customType: notices.length > 0 ? SUBAGENT_NOTIFICATION_CUSTOM_TYPE : SUBAGENT_MESSAGE_CUSTOM_TYPE,
						content: [{ type: "text", text: combinedText }],
						display: true,
						details: items.length === 1 ? (notices[0] ?? messages[0]) : { runs: notices, messages },
					},
					{
						deliverAs: "steer",
						triggerTurn: true,
					},
				);
			} catch {
				// The session was disposed during the batch window without a session_shutdown; nobody is left to tell.
			}
		};

		const { scheduler, deliver } = createGenerations({
			agentDir: resolveAgentDir,
			runner: runSubagent,
			bus: messageBus,
			scope: parentScope,
			pi,
			launchesSettled: () => launchesSettled,
			onChange: () => {
				refreshFooterStatus();
				notifyAgentTasksChanged();
			},
		});

		const admission = createRunAdmission({
			scheduler,
			agentDir: resolveAgentDir,
			catalog: () => catalog,
			loadout: () => latestLoadout,
			parentThinkingLevel: () => pi.getThinkingLevel(),
			scope: parentScope,
		});

		const taskSource = createAgentTaskSource({
			scheduler,
			agentDir: resolveAgentDir,
			activeParentSessionId: activeSessionId,
		});

		// A resumed generation runs under the message call that resumed it, not the first launch.
		const runLaunchedBy = (toolCallId: string) =>
			scheduler
				.listActiveRuns(activeSessionId())
				.find(
					(run) => (scheduler.getContext(run.runId)?.resume?.toolCallId ?? run.originToolCallId) === toolCallId,
				);

		pi.on("message_start", async (event) => {
			if (event.message.role !== "toolResult") return;
			const run = runLaunchedBy(event.message.toolCallId);
			if (run) scheduler.launchResultEmitted(run.runId);
		});

		// A child's tool calls arrive here as nested calls of the tool call that launched it.
		pi.on("tool_call", async (event) => {
			if (!event.parentToolCallId || event.toolName !== "task_stop") return undefined;
			if (!runLaunchedBy(event.parentToolCallId)) return undefined;
			const input = event.input as { task_id?: unknown; shell_id?: unknown };
			const id = String(input.task_id ?? input.shell_id ?? "").trim();
			if (!scheduler.getRun(id) && !isAgentTaskId(id)) return undefined;
			return { block: true, reason: "Subagents cannot stop agent runs; message the orchestrator instead." };
		});

		pi.on("session_start", async (event, ctx) => {
			parentScope.enter(ctx, `Session replaced (${event.reason})`);
			const sessionId = ctx.sessionManager.getSessionId();
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
			const liveIds = new Set(scheduler.listActiveRuns(sessionId).map((r) => r.runId));
			reconcileInterruptedRuns(agentDir, sessionId, branchEntries, liveIds);

			unpublishTasks?.();
			unpublishTasks = publishAgentTasks(taskSource);
			refreshFooterStatus();
		});

		pi.on("turn_start", async () => {
			activeTurnIndex++;
		});

		pi.on("session_before_switch", async () => {
			parentScope.invalidate("Parent session switching");
			return undefined;
		});

		pi.on("session_before_fork", async () => {
			parentScope.invalidate("Parent session forking");
			return undefined;
		});

		pi.on("session_tree", async (_event, ctx) => {
			parentScope.navigate(ctx);
		});

		pi.on("session_shutdown", async () => {
			parentScope.shutdown();
			await scheduler.waitForSettled();
			unpublishTasks?.();
			unpublishTasks = undefined;
			parentScope.detach();
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
				"Send a message to a subagent by name or run ID (sub_…). A running child gets it at its next safe point without a new turn. A completed child resumes in the background with its earlier context and the message as its next instruction. The receipt says accepted, unavailable, or invalidated, never handled.",
			parameters: SUBAGENT_MESSAGE_PARAMETERS,
			execute: async (toolCallId, params, _signal, _onUpdate, toolCtx) => {
				const ctx = toolCtx ?? parentScope.context();
				const scope = parentScope.current();
				if (!scope) {
					return {
						content: [{ type: "text", text: "Subagent runtime is not initialized for this session." }],
						details: undefined,
						isError: true,
					};
				}
				const to = params.to.trim();
				const finished = findFinishedRun(to);
				if (finished && ctx) return resumeRun(finished, toolCallId, params.content, scope, ctx);
				return formatMessageReceipt(
					await messageBus.send({ address: PARENT_MESSAGE_ADDRESS, scope }, to, params.content),
				);
			},
		});

		/** A run of this session that ended and is no longer reachable under the given name or run ID. */
		const findFinishedRun = (target: string): Readonly<SubagentRunRecord> | undefined => {
			const sessionId = activeSessionId();
			if (!sessionId) return undefined;
			const live = scheduler.listActiveRuns(sessionId);
			if (live.some((run) => run.runId === target || run.name === target)) return undefined;
			const known = scheduler
				.listRuns()
				.filter((run) => run.parentSessionId === sessionId && (run.runId === target || run.name === target))
				.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
			// A reload replaces this extension, so a run from before it is only on disk.
			return known ?? readPersistedRunRecord(resolveAgentDir(), sessionId, target);
		};

		const resumeRun = async (
			run: Readonly<SubagentRunRecord>,
			toolCallId: string,
			content: string,
			scope: ParentScope,
			ctx: AdmissionContext,
		) => {
			let receipt: SubagentMessageReceipt | undefined;
			const resumed = await admission.resume(
				run,
				toolCallId,
				() => {
					receipt = messageBus.accept({ address: PARENT_MESSAGE_ADDRESS, scope }, run.runId, run.name);
					return subagentMessagePayload({
						seq: receipt.seq,
						from: PARENT_MESSAGE_ADDRESS,
						to: run.runId,
						toName: run.name,
						content,
					}).content[0].text;
				},
				ctx,
			);
			if (!resumed.ok) {
				return formatMessageReceipt({
					status: resumed.refusal ?? "unavailable",
					seq: 0,
					to: run.runId,
					toName: run.name,
					reason: resumed.error,
				});
			}
			// A resume is admitted only after buildPrompt ran, so the receipt is set.
			const accepted = receipt!;
			const label = formatRunLabel(run);
			void deliver(resumed.handle);
			return {
				...formatMessageReceipt(accepted),
				content: [
					{
						type: "text" as const,
						text: `Message ${accepted.seq} accepted: resuming ${label} in the background with its earlier context. Its report will be delivered when it finishes.`,
					},
				],
			};
		};

		const ago = (at: number | undefined, now: number) =>
			at === undefined ? "never" : `${Math.round((now - at) / 1000)}s ago`;
		const describeProgress = (run: Readonly<SubagentRunRecord>, now: number) => {
			const activity = run.lastActivity
				? `${run.lastActivity.kind === "tool" ? `tool ${run.lastActivity.detail ?? "?"}` : "model turn"} ${ago(run.lastActivity.at, now)}`
				: "none yet";
			return [
				`${run.name ?? run.runId} (${run.agentName}, ${run.runId}): ${run.status}`,
				`  task: ${run.taskSummary}`,
				`  turns: ${run.turnCount}, tool calls: ${run.toolCallCount}, elapsed: ${ago(run.startedAt ?? run.admittedAt, now).replace(" ago", "")}`,
				`  last activity: ${activity}; last message: ${ago(run.lastMessageAt, now)}`,
			].join("\n");
		};
		const findOwnedRun = (target: string) =>
			scheduler.listActiveRuns(activeSessionId()).find((run) => run.runId === target || run.name === target);

		pi.registerTool({
			name: "subagent_status",
			label: "Subagent status",
			exposure: "model-only",
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			description:
				"Show the progress of your running subagents: status, turns, tool calls, elapsed time, last activity and last message. Use it to judge whether a child is still productive; stop one with subagent_stop.",
			parameters: Type.Object(
				{ agent: Type.Optional(Type.String({ description: "A subagent name or run ID; omit for all." })) },
				{ additionalProperties: false },
			),
			execute: async (_toolCallId, params) => {
				const now = Date.now();
				const target = params.agent?.trim();
				const runs = target
					? [findOwnedRun(target)].filter((run) => run !== undefined)
					: scheduler.listActiveRuns(activeSessionId());
				const text =
					runs.length > 0
						? runs.map((run) => describeProgress(run, now)).join("\n\n")
						: target
							? `No running subagent "${target}".`
							: "No subagents are running.";
				return {
					content: [{ type: "text", text }],
					details: undefined,
					isError: target !== undefined && runs.length === 0,
				};
			},
		});

		pi.registerTool({
			name: "subagent_stop",
			label: "Stop subagent",
			exposure: "model-only",
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
			description:
				'Stop a running subagent by name or run ID, or every running subagent with "all". A stopped child cannot be resumed.',
			parameters: Type.Object(
				{ agent: Type.String({ description: 'A subagent name or run ID, or "all".' }) },
				{ additionalProperties: false },
			),
			execute: async (_toolCallId, params) => {
				const target = params.agent.trim();
				if (target === "all") {
					const stopped = taskSource.stopAll({ source: "model" });
					return {
						content: [{ type: "text", text: `Stopped ${stopped} subagent${stopped === 1 ? "" : "s"}.` }],
						details: undefined,
					};
				}
				const run = findOwnedRun(target);
				const stopped = run !== undefined && taskSource.stop(run.runId, { source: "model" }).ok;
				return {
					content: [
						{
							type: "text",
							text: stopped
								? `Stopping ${run.name ?? run.runId} (${run.runId}).`
								: `No running subagent "${target}".`,
						},
					],
					details: undefined,
					isError: !stopped,
				};
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
				const ctx = toolCtx ?? parentScope.context();
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
				const mode = parentScope.context()?.mode;
				return {
					descriptions: {
						subagent: buildBaseSubagentDescription(catalog, mode === "print" || mode === "json"),
					},
				};
			},
			parameters: SUBAGENT_TOOL_PARAMETERS,
			execute: async (toolCallId, params, signal, _onUpdate, toolCtx) => {
				const ctx = toolCtx ?? parentScope.context();
				if (!ctx) {
					return {
						content: [{ type: "text", text: "Subagent runtime is not initialized for this session." }],
						details: undefined,
						isError: true,
					};
				}

				const endLaunch = beginLaunch();
				const admitRes = await admission
					.launch({ toolCallId, parentTurnId: `turn_${activeTurnIndex}`, params, signal }, ctx)
					.finally(endLaunch);
				if (!admitRes.ok) {
					return {
						content: [{ type: "text", text: admitRes.error }],
						details: undefined,
						isError: true,
					};
				}

				const { handle } = admitRes;
				const isBackground = params.background === true;

				if (isBackground) {
					void deliver(handle);

					return {
						content: [
							{
								type: "text",
								text: [
									`Background subagent launched: ${handle.record.name} (${handle.runId})`,
									`Agent: ${handle.record.agentName} (${handle.record.provider}/${handle.record.modelId})`,
									`Status: ${handle.record.status}`,
									"The final report will be delivered to this session branch when complete. Use `task_stop` with this run ID to cancel.",
								].join("\n"),
							},
						],
						details: {
							runId: handle.runId,
							agentName: handle.record.agentName,
							status: handle.record.status,
							complete: false,
							deliveryMode: "background",
							provider: handle.record.provider,
							modelId: handle.record.modelId,
							thinkingLevel: handle.record.thinkingLevel,
							turnCount: 0,
							toolCallCount: 0,
							snapshotDrifted: false,
							truncated: false,
						} satisfies SubagentResultDetails,
					};
				}

				const envelope = await deliver(handle);

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
