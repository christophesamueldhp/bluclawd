import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type InlineExtension,
	SettingsManager,
	type ToolLoadout,
	type ToolLoadoutChanges,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { SessionMessage } from "../../daemon/ipc/protocol.ts";
import { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { runPaneSession } from "../../daemon/run-queue.ts";
import { endPane, runParent, Tmux } from "../../daemon/tmux.ts";
import { notifyAgentTasksChanged, publishAgentTasks } from "../_shared/agent-tasks.ts";
import { commandBlock } from "../_shared/command-block.ts";
import { focusedComponent, isPromptEditor } from "../_shared/focus.ts";
import { sharedRef } from "../_shared/global-state.ts";
import { pistatuslineDrawsFooter } from "../_shared/pistatusline.ts";
import { runsInPanes } from "../_shared/settings.ts";
import { STATUS_KEYS } from "../_shared/status-keys.ts";
import { publishSubagentPanel } from "../_shared/subagent-panel.ts";
import { timed } from "../_shared/timing.ts";
import {
	createRunAdmission,
	formatRunLabel,
	legacyRunRefusal,
	orchestratorTools,
	SUBAGENT_TOOL_PARAMETERS,
	subagentInvocation,
} from "./admission.ts";
import { runTaskBatch } from "./batches.ts";
import { type ChainDeps, resumeChains, runChain } from "./chains.ts";
import { collaborateAsParent } from "./collaboration.ts";
import {
	type AgentDefinitionCatalog,
	discoverAgentDefinitions,
	formatAgentRoutingDescriptions,
} from "./definitions.ts";
import type { RunEntry } from "./directory.ts";
import { createGenerations, type ParentNotice, reportToParent } from "./generations.ts";
import { registerIntegration } from "./integration.ts";
import {
	fromRunText,
	PARENT_MESSAGE_ADDRESS,
	SUBAGENT_MESSAGE_CUSTOM_TYPE,
	SUBAGENT_MESSAGE_PARAMETERS,
	SUBAGENT_MESSAGE_TOOL,
	SubagentMessageBus,
} from "./messages.ts";
import { describeSubagentModels } from "./models.ts";
import { createPanel, formatRunElapsed, SUBAGENT_PANEL_WIDGET } from "./panel.ts";
import { createParentScope, inParentScope, type ParentInboxItem } from "./parent-scope.ts";
import type { SubagentResultDetails } from "./results.ts";
import { daemonRunSlots } from "./rpc-runs.ts";
import { createRunIntervention, RUN_CONVERSATION_ENTRY } from "./run-intervention.ts";
import { messageAsRun } from "./run-messages.ts";
import { isResumableSubagentStatus, isTerminalSubagentStatus, type SubagentRunRecord } from "./runs.ts";
import {
	appendSubagentMessageRecord,
	extractReferencedRunIdsFromBranch,
	listPersistedRunRecords,
	readPersistedRunRecord,
	reconcileInterruptedRuns,
} from "./storage.ts";
import { createAgentTaskSource } from "./task-source.ts";
import { actAsRun, paneUp, RunReports } from "./tmux-runs.ts";
import { createParentScopeViews, runStatus } from "./views.ts";
import { registerWorkspaceCleanup } from "./workspace-cleanup.ts";

export const SUBAGENT_NOTIFICATION_CUSTOM_TYPE = "subagent-notification";
const SUBAGENT_REMINDER_CUSTOM_TYPE = "subagent-reminder";
const BACKGROUND_BATCH_WINDOW_MS = 40;
/** The runs' messages this process gave its orchestrator's pi, by ID: the instance a reload starts gives none again. */
const relaysGiven = sharedRef("subagentRelaysGiven", new Set<string>()).get();

/** As remote and the daemon do, so a hung tmux server cannot hold up pi. */
/** How long the panel keeps a run that failed, and its `/tasks` hint after a close. */
const ENDED_SHOWN_MS = 30_000;
/** How many open runs `subagent_status` describes at once. */
const MAX_STATUS_RUNS = 30;
/** How long opening a finished run waits for the pane its Resume runs in, before saying it waits for its turn. */
const PANE_OPEN_WAIT_MS = 5000;
const timedTmux = (): Tmux => new Tmux(undefined, undefined, { timeoutMs: 2000 });
const SUBAGENT_DESCRIPTION_LEAD = "Delegate a task to a child agent";
const RPC_RUNS_END = [
	"`subagent_stop` cancels a run's work; only `subagent_resume` continues a finished or stopped run.",
];
// Selective by design (spec #290 §13): no required role sequence, no quota, no full-history copying.
const RPC_DELEGATION = [
	`${SUBAGENT_DESCRIPTION_LEAD}: a pi of its own with a fresh context window and only the tools its role is granted. Children cannot delegate further.`,
	"",
	"Do small work yourself: a lookup, a one-file edit, or anything quicker to do than to describe. Delegate only when it helps:",
	"- Independent pieces that can run side by side: give them together as `tasks` in one call, which returns one combined report once all have finished; its manifest lists every member's status meanwhile.",
	"- Dependent steps, such as an edit, then an independent review, then a repair: give them as `chain` in one call, which runs them one after another in one worktree.",
	"- A specialized investigation or review whose intermediate output does not belong in your context.",
	"No sequence of roles is required and there is no quota: use as many runs as the work needs. Runs past the active limit wait in a queue; that limit is not a target, so there is no need to fill every slot. Review is for large or risky changes, not a default step.",
	"",
	"A run that only reads shares your checkout and needs no worktree. A run that edits works in a worktree of its own, made from your checkout as it was at the call: nothing reaches your checkout until you call `subagent_integrate` on it, or on a completed chain, with a `check` command that validates the combined result. Runs that only read may run side by side; runs that edit run one at a time unless their files are disjoint.",
	"",
	"Keep each task, and any inline role, short and self-contained: the goal, the files or area, and what to report. A brief states the objective, the output format, the boundaries and what done is. Do not paste the conversation or large file contents; name paths instead.",
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
		...RPC_DELEGATION,
		"",
		...(process.platform === "darwin"
			? []
			: [
					`Runs get no shell on ${process.platform}: general-purpose edits files without running commands, and a role naming bash is refused.`,
					"",
				]),
		...(oneShot
			? ["Background runs are unavailable in this one-shot mode: omit `background`.", ""]
			: [
					"Run in the foreground (the default) when your next step needs the result. Set `background: true` only when you have independent work to do meanwhile.",
					"",
					...RPC_RUNS_END,
					"",
				]),
		"Available subagent roles, as found from your directory (a run given a `cwd` of its own finds roles from there):",
		rolesSection,
	].join("\n");
}

export function createSubagentsExtension(options: SubagentExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return function subagentsFactory(pi: ExtensionAPI): void {
		const resolveAgentDir = () => options.agentDir ?? getAgentDir();
		// This pi may be a run in tmux, from before runs ran on pi's RPC (ADR-0006), that reports from its pane.
		const pane = Tmux.currentPane();
		const launchedBy = runParent();
		if (launchedBy) {
			const parent = () => runParent() ?? launchedBy;
			const run = actAsRun(pi, parent, pane);
			if (pane) messageAsRun(pi, parent, pane, run.closed);
		}
		const reports = new RunReports();
		/** The chains under way, by ID, which subagent_stop stops before their next step. */
		const chains = new Map<string, AbortController>();
		/** Aborted on a reload, which hands this instance's open runs to the next one. */
		const handOff = new AbortController();
		// What the daemon held for this session meanwhile may be lost: its runs' Reports are read from disk.
		pi.events.on("bluclawd:daemon-reconnected", () => {
			const scope = parentScope.current();
			if (scope) pullReports(scope);
		});
		pi.events.on("bluclawd:session-message", (data) => {
			const message = data as SessionMessage;
			if (message.kind === "report" || message.kind === "activity") reports.receive(message);
			// A stop or an adopt is for a run (actAsRun), never for its orchestrator.
			else if (message.kind === "message" || message.kind === "typed") fromRun(message);
		});

		let activeTurnIndex = 0;
		let catalog: AgentDefinitionCatalog | undefined;
		let unpublish: (() => void) | undefined;
		const now = options.now ?? Date.now;
		let panelTui: Pick<TUI, "requestRender" | "hasOverlay" | "terminal"> | undefined;
		let panel: ReturnType<typeof createPanel> | undefined;
		/** Whether the panel goes out as a status for pistatusline to draw below the status line; set per session. */
		let panelInStatus = false;
		/** The subagents status last set, so the panel's clock republishes only what changed. */
		let publishedStatus: string | undefined;
		let offPanelKeys: (() => void) | undefined;
		/** The orchestrator's tools as its latest request declared them. */
		let latestLoadout: ToolLoadout | undefined;

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

		/** A message or a note of what the user typed, from one of this session's open runs; another sender's is dropped. */
		const fromRun = (message: Extract<SessionMessage, { kind: "message" | "typed" }>) => {
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

		/** Whether a final run ended within the last half minute: the panel still tells of it, as Claude Code's does. */
		const lately = (record: { endedAt?: number }) => now() - (record.endedAt ?? 0) < ENDED_SHOWN_MS;
		/** A run that finished, or that the user or the model stopped, leaves the panel at once, as a closed run in tmux did. */
		const leftAtOnce = ({ status, stopSource }: { status: string; stopSource?: string }) =>
			status === "closed" || (status === "cancelled" && (stopSource === "user" || stopSource === "model"));
		/** The runs that failed or were interrupted lately: their rows stay in the panel until then, or until dismissed. */
		const endedLately = () => views.done().filter(({ record }) => !leftAtOnce(record) && lately(record));

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
				const { running: runningCount, closing: closingCount } = views.footer();
				if (runningCount + closingCount === 0) {
					publish(undefined);
				} else {
					const parts: string[] = [];
					if (runningCount > 0) parts.push(`${runningCount} subagent${runningCount === 1 ? "" : "s"}`);
					if (closingCount > 0) parts.push(`${closingCount} closing`);
					publish(ctx.ui.theme.fg("dim", parts.join(" · ")));
				}
			} catch {
				// Ignore stale UI context errors
			}
		};

		const sendToParent = (sent: readonly ParentInboxItem<ParentNotice>[]) => {
			// A run's message relayed again, after a crash or by the instance a reload started, is given to the model once.
			const given = (item: ParentInboxItem<ParentNotice>) =>
				item.kind === "message" &&
				item.message.id !== undefined &&
				(relaysGiven.has(item.message.id) || parentScope.holds(item.message.id));
			const items = sent.filter((item) => !given(item));
			if (items.length === 0) return;
			const notices = items.flatMap((item) => (item.kind === "notice" ? [item.notice.details] : []));
			const messages = items.flatMap((item) => (item.kind === "message" ? [item.message] : []));
			const texts = items.map((item) =>
				item.kind === "notice"
					? item.notice.parentText
					: fromRunText(
							"Message",
							formatRunLabel({ name: item.message.fromName, runId: item.message.from }),
							item.message.content,
						),
			);
			const combinedText =
				items.length === 1
					? texts[0]
					: [notices.length > 1 ? `[${notices.length} subagent reports]` : undefined, ...texts]
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
				for (const { id } of messages) if (id) relaysGiven.add(id);
			} catch {
				// The session was disposed during the batch window without a session_shutdown; nobody is left to tell.
			}
		};

		/** This pane, while its runs run in panes of their own: the user's `subagents.panes` may have them on pi's RPC. */
		const runPane = (): string | undefined => {
			const ctx = parentScope.context();
			if (!pane || !ctx) return undefined;
			const settings = SettingsManager.create(ctx.cwd, resolveAgentDir(), {
				projectTrusted: ctx.isProjectTrusted(),
			});
			return runsInPanes(settings) ? pane : undefined;
		};
		const slots = daemonRunSlots();
		const { scheduler, directory, messageFromParent, resumeFromParent, pullReports, retellReport } =
			createGenerations({
				agentDir: resolveAgentDir,
				bus: messageBus,
				scope: parentScope,
				pi,
				onChange: runsChanged,
				reports,
				tmux: timedTmux,
				send: (to, message) => new OrchestratorClient().send(to, message),
				handOff: handOff.signal,
				slots,
			});

		const admission = createRunAdmission({
			scheduler,
			directory,
			agentDir: resolveAgentDir,
			parentThinkingLevel: () => pi.getThinkingLevel(),
			scope: parentScope,
			pane: () => pane,
			runPane,
			tools: () => (latestLoadout ? orchestratorTools(latestLoadout) : []),
			registeredTools: () => latestLoadout?.registered.map((tool) => tool.name) ?? [],
			ensureQueue: () => slots.ensure(),
		});

		/** What a chain's driver works with: a `chain` call's, and one taken over from an earlier instance's. */
		const chainDeps: ChainDeps = {
			admission,
			nameHolder: (name) => {
				const scope = parentScope.current();
				return scope ? directory.nameHolder(scope, name)?.record : undefined;
			},
			agentDir: resolveAgentDir,
			reports,
			getRun: (runId) => scheduler.getRun(runId),
			whenFinal: (runId) => scheduler.whenFinal(runId),
			handOff: handOff.signal,
			cancel: (runId, reason) => scheduler.cancelRun(runId, "caller", reason),
			scope: parentScope,
			context: () => parentScope.context(),
			live: chains,
			notify: (first, notice) => parentScope.notify(first, notice),
		};

		/** The orchestrator is told, and goes on as it was: it still owns the work (ADR-0005). */
		const noteToOrchestrator = (text: string) =>
			pi.sendMessage(
				{ customType: SUBAGENT_MESSAGE_CUSTOM_TYPE, content: [{ type: "text", text }], display: true },
				{ deliverAs: "steer", triggerTurn: false },
			);
		const intervention = createRunIntervention({
			scheduler,
			admission,
			agentDir: resolveAgentDir,
			note: noteToOrchestrator,
		});
		pi.registerEntryRenderer<{ lines: string[] }>(RUN_CONVERSATION_ENTRY, (entry) =>
			commandBlock(entry.data?.lines ?? []),
		);

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
			onChange: runsChanged,
		});

		const taskSource = createAgentTaskSource({
			views,
			directory,
			scheduler,
			agentDir: resolveAgentDir,
		});

		/** Switches this terminal to a run's pane; opened from here, its ← comes back here, not to agent view. */
		const showRun = (name: string): void => {
			const tmux = timedTmux();
			try {
				tmux.setOpenedFromView(name, false);
			} catch {
				// Its ← may then go to agent view.
			}
			tmux.switchTo(name);
		};

		/**
		 * Opens a run of the current parent scope: one on pi's RPC shows its conversation and takes an instruction; one in
		 * tmux from before switches this terminal to its pane while it is open (ADR-0006), else shows its conversation
		 * only. Any other run is refused with a notice.
		 */
		const openRun = (runId: string, owner?: string): Promise<void> | undefined => {
			const ctx = parentScope.context();
			if (ctx?.mode !== "tui") return undefined;
			const scope = parentScope.current();
			const run = scheduler.getRun(runId);
			if (!run) {
				ctx.ui.notify(`No run ${runId} is known to this session, so it cannot be opened.`, "warning");
				return undefined;
			}
			if (!scope || !inParentScope(run, scope) || (owner !== undefined && owner !== run.parentSessionId)) {
				ctx.ui.notify("That run belongs to an earlier session and can no longer be opened.", "warning");
				return undefined;
			}
			if (run.backend === "rpc") return runPane() ? openPaneRun(run, ctx) : openRpcRun(run, ctx);
			// A run in tmux from before runs ran on pi's RPC: its pane while it is open, else its history only.
			if (!run.pane || isTerminalSubagentStatus(run.status)) {
				pi.appendEntry(RUN_CONVERSATION_ENTRY, { lines: intervention.conversation(run) });
				ctx.ui.notify(legacyRunRefusal(run), "info");
				return Promise.resolve();
			}
			try {
				showRun(run.pane);
			} catch (error) {
				ctx.ui.notify(`Could not open ${run.name ?? runId}: ${Tmux.reason(error)}`, "warning");
			}
			return Promise.resolve();
		};

		/**
		 * Opens a run from an orchestrator in a pane (ADR-0013): its generation's pane while it runs in one. A finished
		 * run resumes in a pane for the user to type in, opened once its turn in the queue comes; one still queued opens
		 * once it runs. A generation on pi's RPC, launched from no pane, has none: its conversation shows here instead.
		 */
		const openPaneRun = async (run: SubagentRunRecord, ctx: ExtensionContext): Promise<void> => {
			const label = run.name ?? run.runId;
			const tmux = timedTmux();
			const show = async (generation: number) => {
				const name = runPaneSession(run.runId, generation);
				if (!(await tmux.hasSessionAsync(name).catch(() => false))) return false;
				try {
					showRun(name);
				} catch (error) {
					ctx.ui.notify(`Could not open ${label}: ${Tmux.reason(error)}`, "warning");
				}
				return true;
			};
			if (await show(run.generation)) return;
			if (!isTerminalSubagentStatus(run.status)) {
				if (run.status === "starting")
					ctx.ui.notify(`${label} waits for its turn; open it again once it runs.`, "info");
				else await openRpcRun(run, ctx);
				return;
			}
			if (!isResumableSubagentStatus(run.status)) return openRpcRun(run, ctx);
			const resumed = await admission.resume(run, () => "", ctx, { from: "user", typed: true });
			if (!resumed.ok) {
				ctx.ui.notify(resumed.error, "warning");
				// It cannot resume now: its conversation shows here instead, as for a run with no pane.
				return openRpcRun(run, ctx);
			}
			const generation = resumed.handle.record.generation;
			for (const until = Date.now() + PANE_OPEN_WAIT_MS; Date.now() < until; ) {
				if (await show(generation)) return;
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			ctx.ui.notify(`${label} waits for its turn; open it again once it runs.`, "info");
		};

		/**
		 * A run on pi's RPC has no pane: opening it shows the user its conversation here, and asks for an instruction,
		 * which it takes at its next safe point, or resumes with once finished. Esc only looks.
		 */
		const openRpcRun = async (run: SubagentRunRecord, ctx: ExtensionContext): Promise<void> => {
			pi.appendEntry(RUN_CONVERSATION_ENTRY, { lines: intervention.conversation(run) });
			const text = (
				await ctx.ui.input(`Instruct ${run.name ?? run.runId}`, "An instruction for it; Esc only looks")
			)?.trim();
			if (!text) return;
			const result = await intervention.instruct(run, text, ctx);
			if (result.ok) ctx.ui.notify(result.text, "info");
			else ctx.ui.notify(result.error, "warning");
		};

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

			const branchEntries = ctx.sessionManager.getBranch();
			// Its open runs in tmux, from before runs ran on pi's RPC, whose pis still run, after a reload or a crash of
			// the instance that ran them: this instance takes them over (ADR-0008), and follows each until it ends or is
			// stopped, never ending one itself. Those this process runs already are left as they are. A run is on the branch
			// as tree navigation judges it, by the entry it was launched from.
			if (pane) {
				for (const run of listPersistedRunRecords(agentDir, sessionId)) {
					if (
						run.pane &&
						!isTerminalSubagentStatus(run.status) &&
						parentScope.onBranch(run.originEntryId) &&
						paneUp(timedTmux(), run.pane)
					)
						admission.adopt(run);
				}
			}
			// Its open runs on pi's RPC, whose hosts outlive any instance of the session (ADR-0008, ADR-0010): this one
			// takes each over as its run directory has it, after a reload or a crash. One whose host took it is followed
			// to its end; one that never started queues again, and starts only if this session may still start it. A
			// stop requested before stays requested, and a run off the branch is stopped, as tree navigation would.
			for (const run of listPersistedRunRecords(agentDir, sessionId)) {
				if (run.backend !== "rpc" || isTerminalSubagentStatus(run.status) || scheduler.getRun(run.runId)) continue;
				if (!admission.recover(run, ctx)) continue;
				if (run.status === "stopping") {
					scheduler.cancelRun(run.runId, run.stopSource ?? "user", run.stopReason ?? "Subagent run cancelled");
				} else if (!parentScope.onBranch(run.originEntryId)) {
					scheduler.cancelRun(
						run.runId,
						"session_invalidated",
						"Originating branch is no longer active after tree navigation",
					);
				}
			}
			// Outside tmux, this pi has no pane to take its runs in tmux over to: those still running are left so, never
			// ended silently, until the session is opened in a pane again.
			const leftRunning = pane
				? []
				: listPersistedRunRecords(agentDir, sessionId).filter(
						(run) => run.pane && !isTerminalSubagentStatus(run.status) && paneUp(timedTmux(), run.pane),
					);
			if (leftRunning.length > 0 && ctx.hasUI) {
				ctx.ui.notify(
					`subagents: ${leftRunning.map(formatRunLabel).join(", ")} still run in tmux, from before runs ran on pi's RPC, and this pi has no pane to take them over: they are left running. Open this session in agent view to stop them.`,
					"warning",
				);
			}
			// The session's runs an earlier instance left open and this one did not take over, on any branch.
			const liveIds = new Set([
				...scheduler.listActiveRuns(sessionId).map((r) => r.runId),
				...leftRunning.map((run) => run.runId),
			]);
			for (const run of reconcileInterruptedRuns(agentDir, sessionId, liveIds)) {
				if (run.status !== "closed" || !run.pane) continue;
				// Not taken over (its pi is gone, or this one has no pane to take it to): it is closed.
				endPane(timedTmux(), run.pane);
			}
			// Reopening the session lists its closed runs, which can be resumed.
			const reopened = parentScope.current();
			if (reopened) {
				for (const runId of extractReferencedRunIdsFromBranch(branchEntries)) {
					const run = scheduler.getRun(runId) ?? readPersistedRunRecord(agentDir, sessionId, runId);
					if (run && isResumableSubagentStatus(run.status)) scheduler.reopen(run, reopened.sessionEpoch);
				}
				// Reports its runs stored but could not send while it was gone.
				pullReports(reopened);
				// Its chains under way go on, their next steps admitted by this instance.
				resumeChains(chainDeps, sessionId);
				// A batch with a member still open never settled: those of its members that ended, their Reports taken by its
				// waiter, are told of one by one, as the members still open will be.
				const unsettled = new Set(scheduler.listActiveRuns(sessionId).flatMap((run) => run.batch ?? []));
				for (const run of listPersistedRunRecords(agentDir, sessionId)) {
					if (run.batch && unsettled.has(run.batch) && isTerminalSubagentStatus(run.status)) {
						retellReport({ ...run, sessionEpoch: reopened.sessionEpoch });
					}
				}
			}

			unpublish?.();
			// The panel first: publishing the tasks signals a change, and the tasks pill then reads the panel.
			const unpublishPanel = publishSubagentPanel(
				() => panel !== undefined && (views.open().length > 0 || endedLately().length > 0),
			);
			const unpublishTasks = publishAgentTasks({
				...taskSource,
				open: (id, owner) => openRun(id, owner),
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
							runs: () => views.open(),
							ended: endedLately,
							closedLately: () => views.done().some(({ record }) => leftAtOnce(record) && lately(record)),
							waitingFor: views.waitingFor,
							now,
							belowPrompt: !panelInStatus,
							changed: () => {
								refreshFooterStatus();
								tui.requestRender();
							},
							actions: {
								// The same close as /tasks'.
								close: ({ record }) =>
									taskSource.close(record.runId, { owner: record.parentSessionId, source: "user" }),
								open: ({ record }) => void openRun(record.runId),
								dismiss: ({ record }) => views.dismiss(record.runId, record.parentSessionId),
							},
						});
						panel = shown;
						// Elapsed times move on between run changes, and a run that ended leaves the panel after a while.
						let endedShown = false;
						const ticker = setInterval(() => {
							const ended = views.done().some(({ record }) => lately(record));
							if (ended !== endedShown) {
								// A failed run's row or the /tasks hint went: the tasks pill may take ↓ again.
								endedShown = ended;
								return runsChanged();
							}
							shown.sync();
							refreshFooterStatus();
							if (views.open().length > 0 || ended) tui.requestRender();
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

		// The panel's main row says whether the orchestrator is Waiting, which turns on whether it is idle.
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

		pi.on("session_shutdown", async (event) => {
			if (event.reason === "reload") {
				// The next instance of this session takes the open runs over.
				parentScope.release();
				handOff.abort();
			} else {
				// The session ends: no later step of its chains starts, whoever reopens it.
				for (const stop of chains.values()) stop.abort();
				parentScope.shutdown();
				await scheduler.waitForSettled();
			}
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

		// The orchestrator's only: a run messages through the daemon (messageAsRun), and manages no runs.
		const registerOrchestratorTool: typeof pi.registerTool = (tool) => {
			if (!launchedBy) pi.registerTool(tool);
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
				"Send a message to a working subagent by name or run ID (sub_…): it gets it at its next safe point, as information for its work. A message continues no finished subagent: subagent_resume does. The receipt says accepted, unavailable, or invalidated, never handled.",
			parameters: SUBAGENT_MESSAGE_PARAMETERS,
			execute: async (_toolCallId, params) => {
				const scope = parentScope.current();
				if (!scope) {
					return {
						content: [{ type: "text", text: "Subagent runtime is not initialized for this session." }],
						details: undefined,
						isError: true,
					};
				}
				return messageFromParent(scope, params.to.trim(), params.content);
			},
		});

		// Collaboration between independent orchestrators, which only the user opens.
		if (!launchedBy) collaborateAsParent(pi, { agentDir: resolveAgentDir });
		// Runs that edit have worktrees of their own; only the user removes one that holds changes.
		if (!launchedBy) {
			registerWorkspaceCleanup(pi, { agentDir: resolveAgentDir, scope: () => parentScope.current(), directory });
			registerIntegration(pi, {
				agentDir: resolveAgentDir,
				scope: () => parentScope.current(),
				onBranch: (entryId) => parentScope.onBranch(entryId),
				directory,
				whenFinal: (runId) => scheduler.whenFinal(runId),
			});
		}

		// A message does not continue a finished run: only a Resume does.
		registerOrchestratorTool({
			name: "subagent_resume",
			label: "Resume subagent",
			exposure: "model-only",
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
			description:
				"Resume a finished subagent by name or run ID with your next instruction: it continues in the background in its own saved session, with its earlier context, the role and permissions it was launched with (never more than you have now) and its own workspace. It keeps its model and thinking level unless you set them. Its report is delivered when it finishes. A message does not resume a finished subagent; for fresh context, launch a new one.",
			parameters: Type.Object(
				{
					agent: Type.String({ description: "The finished subagent's name or run ID (sub_…)." }),
					task: Type.String({ description: "Its next instruction, self-contained." }),
					model: Type.Optional(
						Type.String({ description: '"provider/model" from subagent_models, or "inherit" for yours.' }),
					),
					thinkingLevel: Type.Optional(Type.String({ description: 'A thinking level, or "inherit" for yours.' })),
				},
				{ additionalProperties: false },
			),
			execute: async (_toolCallId, params, _signal, _onUpdate, toolCtx) => {
				const ctx = toolCtx ?? parentScope.context();
				const scope = parentScope.current();
				if (!scope || !ctx) {
					return {
						content: [{ type: "text", text: "Subagent runtime is not initialized for this session." }],
						details: undefined,
						isError: true,
					};
				}
				const { model, thinkingLevel } = params;
				return resumeFromParent(scope, params.agent.trim(), params.task, { model, thinkingLevel }, admission, ctx);
			},
		});

		const describeProgress = ({ record: run }: RunEntry, now: number) =>
			[
				`${run.name ?? run.runId} (${run.agentName}, ${run.runId}): ${runStatus(run)}${run.backend === "rpc" ? "" : ", in tmux, from before runs ran on pi's RPC: stop it once its work is done"}`,
				`  task: ${run.taskSummary}`,
				`  elapsed: ${formatRunElapsed(run, now)}`,
			].join("\n");
		registerOrchestratorTool({
			name: "subagent_status",
			label: "Subagent status",
			exposure: "model-only",
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			description:
				"Show your open subagents: status (queued, running or stopping), task and elapsed time. Use it to judge whether a child is stuck; stop it with subagent_stop.",
			parameters: Type.Object(
				{ agent: Type.Optional(Type.String({ description: "A subagent name or run ID; omit for all." })) },
				{ additionalProperties: false },
			),
			execute: async (_toolCallId, params) => {
				const now = Date.now();
				const target = params.agent?.trim();
				const runs = target ? [views.findOpen(target)].filter((run) => run !== undefined) : views.open();
				// However many run: a batch's manifest lists each of its members.
				const listed = runs.slice(0, MAX_STATUS_RUNS);
				const unlisted = runs.length - listed.length;
				const text =
					runs.length > 0
						? [
								...listed.map((run) => describeProgress(run, now)),
								...(unlisted ? [`[${unlisted} more not listed here: name one to see it.]`] : []),
							].join("\n\n")
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

		/** Settles with the run's record once it is final; undefined once `signal` aborts first. */
		const untilFinal = (runId: string, signal: AbortSignal | undefined) =>
			new Promise<Readonly<SubagentRunRecord> | undefined>((resolve) => {
				const final = scheduler.whenFinal(runId);
				if (!final || signal?.aborted) return resolve(undefined);
				signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				void final.then(resolve);
			});
		/**
		 * Stops a run, queued or working, and waits while the call does until nothing of it runs: a stop asked for is not
		 * told as done. A run on pi's RPC is cancelled; one in tmux from before has its pi ended.
		 */
		const stopRun = async (
			run: Readonly<SubagentRunRecord>,
			signal: AbortSignal | undefined,
			reason = "Stopped by its orchestrator",
		) => {
			const label = formatRunLabel(run);
			scheduler.cancelRun(run.runId, "model", reason);
			const final = await untilFinal(run.runId, signal);
			if (run.backend !== "rpc" && final?.status === "closed") {
				return { text: `Stopped ${label}: its pi in tmux ended. ${legacyRunRefusal(final)}`, stopped: true };
			}
			if (final?.status === "cancelled") {
				return {
					text: `Stopped ${label}: its work was cancelled, and none of its processes runs any more. Its session, Reports and files are kept; only subagent_resume continues it.`,
					stopped: true,
				};
			}
			if (final?.status === "closed") {
				return {
					text: `${label} finished its work before it could be stopped; its Report: ${final.reportPath ?? "kept with the run"}.`,
					stopped: true,
				};
			}
			return {
				text: final
					? `Could not confirm ${label} stopped: ${final.errorMessage ?? final.status}.`
					: `Asked ${label} to stop; it is still stopping, and its processes may still run.`,
				stopped: false,
			};
		};
		registerOrchestratorTool({
			name: "subagent_stop",
			label: "Stop subagent",
			exposure: "model-only",
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
			description:
				'Stop a subagent by name or run ID, every member of a batch or chain by its ID (batch_… or chain_…), or every one with "all": its work is cancelled, queued or under way, and the call returns once none of its processes runs. Its session, Reports and files are kept; only subagent_resume continues it.',
			parameters: Type.Object(
				{ agent: Type.String({ description: 'A subagent name or run ID, a batch or chain ID, or "all".' }) },
				{ additionalProperties: false },
			),
			execute: async (_toolCallId, params, signal) => {
				const target = params.agent.trim();
				const run = target === "all" ? undefined : views.findOpen(target)?.record;
				const members =
					target === "all"
						? views.open()
						: run
							? []
							: views.open().filter(({ record }) => record.batch === target || record.chain === target);
				const chain = run ? undefined : chains.get(target);
				if (target === "all" || members.length > 0 || chain) {
					const kind = target === "all" ? undefined : chain ? "chain" : "batch";
					// Each member's stop is asked first, for its reason; then a chain starts no further step.
					const stopping = members.map(({ record }) =>
						stopRun(record, signal, kind ? `Its ${kind} ${target} was stopped` : undefined),
					);
					chain?.abort();
					const stopped = await Promise.all(stopping);
					const text = stopped.length
						? stopped.map((result) => result.text).join("\n")
						: chain
							? `Stopped chain ${target}: no further step of it starts.`
							: "No subagents are running.";
					return {
						content: [{ type: "text", text }],
						details: undefined,
						isError: stopped.some((result) => !result.stopped),
					};
				}
				if (!run) {
					return {
						content: [{ type: "text", text: `No running subagent "${target}".` }],
						details: undefined,
						isError: true,
					};
				}
				const { text, stopped } = await stopRun(run, signal);
				return { content: [{ type: "text", text }], details: undefined, isError: !stopped };
			},
		});

		registerOrchestratorTool({
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
				const invocation = subagentInvocation(params);
				if (!invocation.ok) {
					return { content: [{ type: "text", text: invocation.error }], details: undefined, isError: true };
				}
				const parentTurnId = `turn_${activeTurnIndex}`;
				if ("chain" in invocation) {
					return runChain(chainDeps, invocation.chain, { toolCallId, parentTurnId, signal }, ctx);
				}
				if ("tasks" in invocation) {
					const scope = parentScope.current();
					return runTaskBatch(
						{
							admission,
							nameHolder: (name) => (scope ? directory.nameHolder(scope, name)?.record : undefined),
							cancel: (runId) => scheduler.cancelRun(runId, "caller", "Its batch could not be admitted whole"),
							agentDir: resolveAgentDir,
							reports,
							getRun: (runId) => scheduler.getRun(runId),
							notify: (member, notice) => parentScope.notify(member, notice),
						},
						invocation.tasks,
						{ toolCallId, parentTurnId, signal },
						ctx,
					);
				}
				const admitRes = await admission.launch({ toolCallId, parentTurnId, params: invocation.run, signal }, ctx);
				if (!admitRes.ok) {
					return {
						content: [{ type: "text", text: admitRes.error }],
						details: undefined,
						isError: true,
					};
				}

				const { handle } = admitRes;

				if (params.background !== true) {
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
											: `Cancelling ${name}: its work was asked to stop, and it is ${run?.status ?? "stopping"}. Its session and Reports are kept; only subagent_resume continues it.`,
								},
							],
							details,
							isError: true,
						};
					const { parentText, truncated } = reportToParent(resolveAgentDir(), handle.record, report);
					return { content: [{ type: "text", text: parentText }], details: { ...details, truncated } };
				}

				// Its Report arrives as a notice once it has finished.
				return {
					content: [
						{
							type: "text",
							text: [
								`Background subagent launched: ${handle.record.name} (${handle.runId})`,
								`Agent: ${handle.record.agentName} (${handle.record.provider}/${handle.record.modelId})`,
								`Status: ${handle.record.status}`,
								"Its report arrives here once it has finished; its process then ends by itself: there is nothing to close.",
								// Wording follows Codex's "After you delegate" block and Claude Code's harness text (docs/research/subagents-ux-and-waiting.md).
								`While ${handle.record.name} runs, do not redo or touch its work, including the files in its scope, and do not poll \`subagent_status\` by reflex. With no independent work left, end your turn and say you are waiting for ${handle.record.name}: its report will wake you. Never predict or invent its result; if the user asks, say it is still running.`,
								"Its progress does not wake you; its findings, questions and blockers reach you as messages.",
							].join("\n"),
						},
					],
					details: {
						runId: handle.runId,
						agentName: handle.record.agentName,
						status: handle.record.status,
						deliveryMode: "background",
						provider: handle.record.provider,
						modelId: handle.record.modelId,
						thinkingLevel: handle.record.thinkingLevel,
						truncated: false,
					} satisfies SubagentResultDetails,
				};
			},
		});
	};
}

const subagentsExtension: InlineExtension = {
	name: "subagents",
	factory: createSubagentsExtension(),
};
export default timed("subagents", subagentsExtension.factory);
