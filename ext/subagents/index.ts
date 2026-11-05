import { Type } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	type InlineExtension,
	type ToolLoadout,
	type ToolLoadoutChanges,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type TUI } from "@earendil-works/pi-tui";
import type { SessionMessage } from "../../daemon/ipc/protocol.ts";
import { PARENT_ENV, Tmux } from "../../daemon/tmux.ts";
import { isAgentTaskId, notifyAgentTasksChanged, publishAgentTasks } from "../_shared/agent-tasks.ts";
import { focusedComponent, isPromptEditor } from "../_shared/focus.ts";
import { pistatuslineDrawsFooter } from "../_shared/pistatusline.ts";
import { STATUS_KEYS } from "../_shared/status-keys.ts";
import { publishSubagentPanel } from "../_shared/subagent-panel.ts";
import { createRunAdmission, formatRunLabel, SUBAGENT_TOOL_PARAMETERS } from "./admission.ts";
import {
	type AgentDefinitionCatalog,
	discoverAgentDefinitions,
	formatAgentRoutingDescriptions,
} from "./definitions.ts";
import type { RunEntry } from "./directory.ts";
import { createGenerations, type ParentNotice } from "./generations.ts";
import {
	PARENT_MESSAGE_ADDRESS,
	SUBAGENT_MESSAGE_CUSTOM_TYPE,
	SUBAGENT_MESSAGE_PARAMETERS,
	SUBAGENT_MESSAGE_TOOL,
	SubagentMessageBus,
	subagentMessagePayload,
} from "./messages.ts";
import { createPanel, formatRunElapsed, SUBAGENT_PANEL_WIDGET } from "./panel.ts";
import { createParentScope, type ParentInboxItem } from "./parent-scope.ts";
import type { SubagentResultDetails } from "./results.ts";
import { messageAsRun } from "./run-messages.ts";
import { describeSubagentModels, runSubagent } from "./runner.ts";
import { isTerminalSubagentStatus } from "./runs.ts";
import { appendSubagentMessageRecord, reconcileInterruptedRuns } from "./storage.ts";
import { createAgentTaskSource } from "./task-source.ts";
import { actAsRun, RunReports, reportText, stopTurn } from "./tmux-runs.ts";
import { createTranscriptActions } from "./transcript-actions.ts";
import { createParentScopeViews } from "./views.ts";

export const SUBAGENT_NOTIFICATION_CUSTOM_TYPE = "subagent-notification";
const SUBAGENT_REMINDER_CUSTOM_TYPE = "subagent-reminder";
const BACKGROUND_BATCH_WINDOW_MS = 40;
const SUBAGENT_DESCRIPTION_LEAD = "Delegate a task to a child agent that works in this same checkout";
// Wording follows Codex's "After you delegate" block and Claude Code's harness text (docs/research/subagents-ux-and-waiting.md).
const AFTER_YOU_DELEGATE = [
	"After you delegate:",
	"- Do not redo or touch delegated work, including the files in a run's scope; work only on what does not overlap.",
	"- Do not poll `subagent_status` by reflex; check it only when a run seems stuck.",
	"- With no independent work left, end your turn and say you are waiting: the report will wake you.",
	"- Never predict or invent a pending run's result; if the user asks, say it is still running.",
];

export interface SubagentExtensionOptions {
	agentDir?: string;
	batchWindowMs?: number;
	/** The clock of the panel and the active-run reminder; Date.now when omitted. */
	now?: () => number;
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
		...(oneShot
			? ["Background runs are unavailable in this one-shot mode: omit `background`.", ""]
			: [
					"Run in the foreground (the default) when your next step needs the result. Set `background: true` only when you have independent work to do meanwhile.",
					"",
					...AFTER_YOU_DELEGATE,
					"",
				]),
		"Available subagent roles:",
		rolesSection,
	].join("\n");
}

export function createSubagentsExtension(options: SubagentExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return function subagentsFactory(pi: ExtensionAPI): void {
		const resolveAgentDir = () => options.agentDir ?? getAgentDir();
		// Runs are pi sessions of their own (ADR-0006): this pi may be one, and launches them from its pane.
		const pane = Tmux.currentPane();
		const runParent = process.env[PARENT_ENV];
		if (runParent) actAsRun(pi, runParent, pane);
		if (runParent && pane) messageAsRun(pi, runParent, pane);
		const reports = new RunReports();
		pi.events.on("bluclawd:session-message", (data) => {
			const message = data as SessionMessage;
			if (message.kind === "report") reports.receive(message);
			else fromRun(message);
		});

		let activeTurnIndex = 0;
		let catalog: AgentDefinitionCatalog | undefined;
		let unpublish: (() => void) | undefined;
		let latestLoadout: ToolLoadout | undefined;
		const now = options.now ?? Date.now;
		let panelTui: Pick<TUI, "requestRender" | "hasOverlay" | "terminal"> | undefined;
		let panel: ReturnType<typeof createPanel> | undefined;
		/** Whether the panel goes out as a status for pistatusline to draw below the status line; set per session. */
		let panelInStatus = false;
		/** The subagents status last set, so the panel's clock republishes only what changed. */
		let publishedStatus: string | undefined;
		let offPanelKeys: (() => void) | undefined;
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

		const messageBus = new SubagentMessageBus(
			(record, senderScope) =>
				appendSubagentMessageRecord(resolveAgentDir(), senderScope.parentSessionId, { ...record, at: Date.now() }),
			{ find: (scope, to) => directory.find(scope, to), reachable: (scope) => directory.reachable(scope) },
		);
		/** Redraws what shows the runs after any of them changed. */
		const runsChanged = () => {
			panel?.sync();
			refreshFooterStatus();
			panelTui?.requestRender();
			notifyAgentTasksChanged();
		};
		const parentScope = createParentScope<ParentNotice>({
			bus: messageBus,
			cancelRuns: (where, reason) => scheduler.cancelRuns(where, reason),
			send: (items) => sendToParent(items),
			onChange: runsChanged,
			batchWindowMs: options.batchWindowMs ?? BACKGROUND_BATCH_WINDOW_MS,
		});
		const senderRole = (address: string) => scheduler.getRun(address)?.agentName;

		/** A message or a note of what the user typed, from one of this session's open runs; another sender's is dropped. */
		const fromRun = (message: SessionMessage) => {
			const scope = parentScope.current();
			const run = scope && directory.list(scope).find(({ record }) => record.pane === message.from)?.record;
			if (!scope || !run) return;
			if (message.kind === "message") {
				void messageBus.send({ address: run.runId, scope }, PARENT_MESSAGE_ADDRESS, message.text);
				return;
			}
			// The orchestrator still owns the work, so it is told, but not woken (ADR-0005).
			pi.sendMessage(
				{
					customType: SUBAGENT_MESSAGE_CUSTOM_TYPE,
					content: [
						{
							type: "text",
							text: `The user typed to run ${formatRunLabel(run)} in its own session: ${message.text}`,
						},
					],
					display: true,
					details: message,
				},
				{ deliverAs: "steer", triggerTurn: false },
			);
		};

		const refreshFooterStatus = () => {
			try {
				const ctx = parentScope.context();
				if (!ctx?.hasUI) return;
				const publish = (text: string | undefined) => {
					if (text === publishedStatus) return;
					publishedStatus = text;
					ctx.ui.setStatus(STATUS_KEYS.subagents, text);
				};
				const lines = panelInStatus && panel && panelTui ? panel.lines(panelTui.terminal.columns) : [];
				// The line break makes it a block of its own, below the chips.
				if (lines.length > 0) return publish(`${lines.join("\n")}\n`);
				const { running: runningCount, stopping: stoppingCount } = views.footer();
				if (runningCount + stoppingCount === 0) {
					publish(undefined);
				} else {
					const parts: string[] = [];
					if (runningCount > 0) parts.push(`${runningCount} subagent${runningCount === 1 ? "" : "s"}`);
					if (stoppingCount > 0) parts.push(`${stoppingCount} stopping`);
					publish(ctx.ui.theme.fg("dim", parts.join(" · ")));
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

		const { scheduler, directory, deliver, messageFromParent, messageFromUser, transcripts } = createGenerations({
			agentDir: resolveAgentDir,
			runner: runSubagent,
			bus: messageBus,
			scope: parentScope,
			pi,
			launchesSettled: () => launchesSettled,
			onChange: runsChanged,
			reports,
		});

		const admission = createRunAdmission({
			scheduler,
			directory,
			agentDir: resolveAgentDir,
			catalog: () => catalog,
			loadout: () => latestLoadout,
			parentThinkingLevel: () => pi.getThinkingLevel(),
			scope: parentScope,
			// The in-process runner still runs any launch outside tmux.
			pane: () => pane,
		});

		const views = createParentScopeViews({
			scheduler,
			directory,
			agentDir: resolveAgentDir,
			scope: () => parentScope.current(),
			idle: () => {
				try {
					return parentScope.context()?.isIdle() ?? false;
				} catch {
					return false;
				}
			},
			now,
			onChange: runsChanged,
		});

		const taskSource = createAgentTaskSource({
			views,
			directory,
			scheduler,
			agentDir: resolveAgentDir,
		});

		const { openTranscript } = createTranscriptActions({
			scope: parentScope,
			scheduler,
			transcripts,
			messageFromUser,
			admission,
		});

		/**
		 * Opening a closed run of this scope, from `/tasks`, resumes it with no message: its pi reopens on its session
		 * for the user to type in. Undefined for any other run.
		 */
		const resumeClosed = (runId: string, owner?: string): Promise<void> | undefined => {
			const run = scheduler.getRun(runId);
			const ctx = parentScope.context();
			if (!pane || !ctx || run?.status !== "closed" || (owner !== undefined && owner !== run.parentSessionId)) {
				return undefined;
			}
			return admission.resume(run, run.originToolCallId, undefined, ctx).then((resumed) => {
				if (!resumed.ok) return ctx.ui.notify(resumed.error, "warning");
				const reopened = scheduler.getRun(runId)?.pane;
				try {
					// The user's own key asked for it, so the terminal moves to the run.
					if (reopened) new Tmux().switchTo(reopened);
				} catch {
					// No terminal shows this pane.
				}
			});
		};

		pi.on("message_start", async (event) => {
			if (event.message.role !== "toolResult") return;
			const run = views.launchedBy(event.message.toolCallId);
			if (run) scheduler.launchResultEmitted(run.runId);
		});

		// A child's tool calls arrive here as nested calls of the tool call that launched it.
		pi.on("tool_call", async (event) => {
			if (!event.parentToolCallId || event.toolName !== "task_stop") return undefined;
			if (!views.launchedBy(event.parentToolCallId)) return undefined;
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

			unpublish?.();
			// The panel first: publishing the tasks signals a change, and the tasks pill then reads the panel.
			const unpublishPanel = publishSubagentPanel(() => panel !== undefined && views.panel().length > 0);
			const unpublishTasks = publishAgentTasks({
				...taskSource,
				open: (id, owner) => resumeClosed(id, owner) ?? openTranscript(id, owner),
			});
			unpublish = () => {
				unpublishTasks();
				unpublishPanel();
			};
			// pi clears the statuses for a new session; pistatusline is looked up once per session.
			publishedStatus = undefined;
			panelInStatus = ctx.mode === "tui" && pistatuslineDrawsFooter(pi, agentDir);
			refreshFooterStatus();
			if (ctx.mode === "tui") {
				// Always mounted, as the panel's hold on the TUI and its focus. It renders nothing while there are no
				// runs to show, nor under pistatusline, which draws the panel from the status below the status line.
				ctx.ui.setWidget(
					SUBAGENT_PANEL_WIDGET,
					(tui, theme) => {
						panelTui = tui;
						const shown = createPanel({
							tui,
							theme,
							runs: views.panel,
							waitingFor: views.waitingFor,
							now,
							belowPrompt: !panelInStatus,
							changed: () => {
								refreshFooterStatus();
								tui.requestRender();
							},
							actions: {
								// The same stop as /tasks', so no report wakes the orchestrator.
								stop: ({ record }) =>
									taskSource.stop(record.runId, { owner: record.parentSessionId, source: "user" }),
								dismiss: ({ record }) => views.dismiss("panel", record.runId),
								open: ({ record }) => void openTranscript(record.runId),
							},
						});
						panel = shown;
						// Elapsed times move on between run changes, and a succeeded run leaves.
						const ticker = setInterval(() => {
							shown.sync();
							refreshFooterStatus();
							if (views.panel().length > 0) tui.requestRender();
						}, 1000);
						ticker.unref?.();
						return Object.assign(shown, {
							dispose: () => {
								clearInterval(ticker);
								if (panel === shown) panel = undefined;
							},
						});
					},
					{ placement: "belowEditor" },
				);
				offPanelKeys?.();
				offPanelKeys = ctx.ui.onTerminalInput((data) => {
					// ↓ on an empty prompt; a prompt browsing history is never empty, so history keeps its ↓.
					if (isKeyRelease(data) || !matchesKey(data, "down") || ctx.ui.getEditorText() !== "") return undefined;
					if (!isPromptEditor(focusedComponent(panelTui))) return undefined;
					if (panelTui?.hasOverlay()) return undefined;
					return panel?.focus() ? { consume: true } : undefined;
				});
			}
		});

		pi.on("turn_start", async () => {
			activeTurnIndex++;
		});

		// The panel's title says whether the orchestrator is Waiting, which turns on whether it is idle.
		pi.on("agent_start", () => refreshFooterStatus());
		pi.on("agent_settled", () => refreshFooterStatus());

		// Added to each request rather than stored, so a compaction cannot drop it.
		pi.on("context", async (event) => {
			const runs = views.awaited();
			if (runs.length === 0) return undefined;
			const at = now();
			const lines = runs.map(
				({ record: run }) =>
					`- ${run.name ?? run.runId}: ${run.deliveryMode}, ${formatRunElapsed(run, at)} elapsed`,
			);
			const text = [
				"Subagents still active; their reports arrive on their own, so do not redo their work or poll for them:",
				...lines,
			].join("\n");
			return {
				messages: [
					...event.messages,
					{
						role: "custom",
						customType: SUBAGENT_REMINDER_CUSTOM_TYPE,
						content: [{ type: "text", text }],
						display: false,
						timestamp: at,
					},
				],
			};
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
			unpublish?.();
			unpublish = undefined;
			offPanelKeys?.();
			offPanelKeys = undefined;
			try {
				parentScope.context()?.ui.setWidget(SUBAGENT_PANEL_WIDGET, undefined);
			} catch {
				// Ignore stale UI context errors
			}
			panelTui = undefined;
			parentScope.detach();
		});

		// The orchestrator's only: a run messages through the daemon (messageAsRun), and launches nothing.
		const registerOrchestratorTool: typeof pi.registerTool = (tool) => {
			if (!runParent) pi.registerTool(tool);
		};
		registerOrchestratorTool({
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
				"Send a message to a subagent by name or run ID (sub_…). A working child gets it at its next safe point; an idle one that is still open takes a turn on it. A completed or closed child resumes in the background with its earlier context and the message as its next instruction. The receipt says accepted, unavailable, or invalidated, never handled.",
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
				return messageFromParent(scope, params.to.trim(), params.content, toolCallId, admission, ctx);
			},
		});

		const ago = (at: number | undefined, now: number) =>
			at === undefined ? "never" : `${Math.round((now - at) / 1000)}s ago`;
		const describeProgress = ({ record: run }: RunEntry, now: number) => {
			const activity = run.lastActivity
				? `${run.lastActivity.kind === "tool" ? `tool ${run.lastActivity.detail ?? "?"}` : "model turn"} ${ago(run.lastActivity.at, now)}`
				: "none yet";
			return [
				`${run.name ?? run.runId} (${run.agentName}, ${run.runId}): ${run.status}`,
				`  task: ${run.taskSummary}`,
				`  turns: ${run.turnCount}, tool calls: ${run.toolCallCount}, elapsed: ${formatRunElapsed(run, now)}`,
				`  last activity: ${activity}; last message: ${ago(run.lastMessageAt, now)}`,
			].join("\n");
		};
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
				const runs = target ? [views.findOpen(target)].filter((run) => run !== undefined) : views.open();
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
				'Stop the turn in progress of a subagent by name or run ID, or of every subagent with "all", as Esc does: the run stays open and takes messages. To end a run, use subagent_close.',
			parameters: Type.Object(
				{ agent: Type.String({ description: 'A subagent name or run ID, or "all".' }) },
				{ additionalProperties: false },
			),
			execute: async (_toolCallId, params) => {
				const target = params.agent.trim();
				// A run in tmux has its turn stopped; one in process is cancelled.
				if (target === "all" && pane) {
					const stopped = views.open().filter(({ record }) => record.pane && stopTurn(record.pane)).length;
					return {
						content: [
							{ type: "text", text: `Stopped the turn of ${stopped} subagent${stopped === 1 ? "" : "s"}.` },
						],
						details: undefined,
					};
				}
				if (target === "all") {
					const stopped = taskSource.stopAll({ source: "model" });
					return {
						content: [{ type: "text", text: `Stopped ${stopped} subagent${stopped === 1 ? "" : "s"}.` }],
						details: undefined,
					};
				}
				const run = views.findOpen(target)?.record;
				if (run?.pane) {
					const label = `${run.name ?? run.runId}'s turn (${run.runId})`;
					const stopped = stopTurn(run.pane);
					return {
						content: [
							{
								type: "text",
								text: stopped
									? `Stopped ${label}. It stays open and takes messages.`
									: `Could not stop ${label}: its pi is gone.`,
							},
						],
						details: undefined,
						isError: !stopped,
					};
				}
				const stopped = run !== undefined && taskSource.stop(run.runId, { source: "model" }).ok;
				return {
					content: [
						{
							type: "text",
							text: stopped
								? `Stopping ${run.name ?? run.runId} (${run.runId}).`
								: run
									? `${run.name ?? run.runId} (${run.runId}) has finished its last turn; there is nothing to stop.`
									: `No running subagent "${target}".`,
						},
					],
					details: undefined,
					isError: !stopped,
				};
			},
		});

		pi.registerTool({
			name: "subagent_close",
			label: "Close subagent",
			exposure: "model-only",
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
			description:
				"Close an open subagent by name or run ID: its pi ends at once, without asking it, and its session is kept. Close a run once its work is done; subagent_message resumes a closed run with its earlier context.",
			parameters: Type.Object(
				{ agent: Type.String({ description: "A subagent name or run ID." }) },
				{ additionalProperties: false },
			),
			execute: async (_toolCallId, params) => {
				const target = params.agent.trim();
				const run = views.findOpen(target)?.record;
				const closed = run !== undefined && taskSource.stop(run.runId, { source: "model" }).ok;
				const label = run && `${run.name ?? run.runId} (${run.runId})`;
				return {
					content: [
						{
							type: "text",
							text: closed
								? `Closed ${label}.${run.pane ? " Its session is kept: a message resumes it." : ""}`
								: run
									? `${label} is ending already.`
									: `No open subagent "${target}".`,
						},
					],
					details: undefined,
					isError: !closed,
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

		// A run cannot launch runs of its own: delegation stays one level deep.
		registerOrchestratorTool({
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

				if (pane && !isBackground) {
					const name = handle.record.name ?? handle.runId;
					// Waits until the run reports, the call is aborted, or the run ends first.
					const ended = new AbortController();
					void scheduler.whenFinal(handle.runId)?.then(() => ended.abort());
					const report = await reports.next(
						handle.runId,
						signal ? AbortSignal.any([signal, ended.signal]) : ended.signal,
					);
					const run = scheduler.getRun(handle.runId);
					const details = { runId: handle.runId, name, pane: run?.pane, agentName: handle.record.agentName };
					if (!report)
						return {
							content: [
								{
									type: "text",
									text:
										run && isTerminalSubagentStatus(run.status)
											? `${name} ended before it reported: ${run.errorMessage ?? run.stopReason ?? run.status}.`
											: `Stopped waiting for ${name}'s report; it stays open in its own session.`,
								},
							],
							details,
							isError: true,
						};
					return { content: [{ type: "text", text: reportText(name, report.text) }], details };
				}

				if (isBackground) {
					// A run in tmux delivers its own Reports, after each of its turns.
					if (!pane) void deliver(handle);

					return {
						content: [
							{
								type: "text",
								text: [
									`Background subagent launched: ${handle.record.name} (${handle.runId})`,
									`Agent: ${handle.record.agentName} (${handle.record.provider}/${handle.record.modelId})`,
									`Status: ${handle.record.status}`,
									pane
										? "It stays open, and its report arrives here each time it finishes a turn."
										: "The final report will be delivered to this session branch when complete. Use `task_stop` with this run ID to cancel.",
									`While ${handle.record.name} runs, do not redo or touch its work, including the files in its scope, and do not poll \`subagent_status\` by reflex. With no independent work left, end your turn and say you are waiting for ${handle.record.name}: its report will wake you. Never predict or invent its result; if the user asks, say it is still running.`,
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
