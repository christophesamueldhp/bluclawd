import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { OrchestratorClient } from "../../daemon/orchestrator-client.ts";
import { Tmux } from "../../daemon/tmux.ts";
import { createRunAddressing } from "./addressing.ts";
import type { RunExecutionContext } from "./admission.ts";
import { createRunDirectory } from "./directory.ts";
import {
	formatMessageReceipt,
	PARENT_MESSAGE_ADDRESS,
	SUBAGENT_MESSAGE_PARAMETERS,
	SUBAGENT_MESSAGE_TOOL,
	type SubagentMessageBus,
	subagentMessagePayload,
} from "./messages.ts";
import type { ParentScope, ParentScopeChecks, ScopedRun } from "./parent-scope.ts";
import {
	type BuiltSubagentResultEnvelope,
	buildSubagentResultEnvelope,
	MAX_PARENT_REPORT_BYTES,
	type SubagentResultDetails,
} from "./results.ts";
import { type ChildSession, createParentToolProxies, type RunSubagentOptions } from "./runner.ts";
import {
	type AdmittedSubagentHandle,
	isTerminalSubagentStatus,
	type SubagentRunnerOutcome,
	type SubagentRunRecord,
	SubagentRunScheduler,
} from "./runs.ts";
import {
	appendParentRunReference,
	ensureRunStorageDir,
	recordBackgroundUsageInLedger,
	recordRunSessionUsage,
	writeFullSubagentReport,
	writePersistedRunRecord,
} from "./storage.ts";
import { executeTmuxRun, type RunReports, reportText } from "./tmux-runs.ts";
import { createRunTranscripts } from "./transcripts.ts";

export const SUBAGENT_ROSTER_TOOL = "subagent_roster";

/** A finished background run, as the orchestrator is told about it. */
export interface ParentNotice {
	parentText: string;
	details: SubagentResultDetails;
}

export interface GenerationDeps {
	agentDir: () => string;
	/** Runs one generation's child session; `runSubagent` outside tests. */
	runner: (options: RunSubagentOptions) => Promise<SubagentRunnerOutcome>;
	bus: SubagentMessageBus;
	scope: ParentScopeChecks & {
		context(): ExtensionContext | undefined;
		notify(run: ScopedRun, notice: ParentNotice): void;
	};
	/** `sendMessage` notes a user's message to the orchestrator. */
	pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">;
	/** Settles once every launch in flight has been admitted (#99). */
	launchesSettled: () => Promise<void>;
	/** A run changed state. */
	onChange: () => void;
	/** Where the Reports of runs in tmux arrive. */
	reports: RunReports;
}

function withRoster(task: string, roster: readonly string[]): string {
	if (roster.length === 0) return task;
	return [
		task,
		"",
		"## Agents working now",
		...roster,
		`Coordinate with them through subagent_message; ${SUBAGENT_ROSTER_TOOL} shows the current list.`,
	].join("\n");
}

/** Persists and delivers each generation of a run; the scheduler it owns decides the transitions. */
export function createGenerations(deps: GenerationDeps) {
	const senderRole = (address: string) => scheduler.getRun(address)?.agentName;
	const transcripts = createRunTranscripts();

	/** The agents a child of the scope can message now, one line each, for its prompt or roster query. */
	const describeRoster = (scope: ParentScope, self: string, includeSelf: boolean): string[] =>
		directory
			.reachable(scope)
			.map((entry) => entry.record)
			.filter((run) => includeSelf || run.runId !== self)
			.map(
				(run) =>
					`- ${run.name ?? run.runId} (${run.agentName}, ${run.runId}, ${run.status}): ${run.taskSummary}${run.runId === self ? " (you)" : ""}`,
			);

	const createChildRosterTool = (address: string, scope: ParentScope): ToolDefinition =>
		defineTool({
			name: SUBAGENT_ROSTER_TOOL,
			label: "List agents",
			description:
				'List the agents running now: the orchestrator ("parent") and every subagent with its name, role, run ID, status and task.',
			parameters: Type.Object({}, { additionalProperties: false }),
			execute: async () => {
				const others = describeRoster(scope, address, true);
				return {
					content: [
						{
							type: "text",
							text: ["- parent: the orchestrator", ...others].join("\n"),
						},
					],
					details: undefined,
				};
			},
		});

	const createChildMessageTool = (address: string, name: string | undefined, scope: ParentScope): ToolDefinition =>
		defineTool({
			name: SUBAGENT_MESSAGE_TOOL,
			label: "Message agent",
			description: `Send a short message to the orchestrator ("parent") or a sibling by name or run ID while you work. You are ${name ? `${name} (${address})` : address}. ${SUBAGENT_ROSTER_TOOL} lists who is running. Delivery is not a reply; keep working.`,
			parameters: SUBAGENT_MESSAGE_PARAMETERS,
			execute: async (_toolCallId, params) => {
				const receipt = await deps.bus.send({ address, scope }, params.to.trim(), params.content);
				if (receipt.status === "accepted") scheduler.recordMessageSent(address);
				return formatMessageReceipt(receipt);
			},
		});

	/** A first generation's start: a stub report until its first progress, and its reference on the branch. */
	const recordLaunch = (record: Readonly<SubagentRunRecord>) => {
		writeFullSubagentReport(
			deps.agentDir(),
			record,
			`Run: ${record.runId} (${record.agentName})\nStatus: ${record.status}\nTask: ${record.taskSummary}`,
		);
		appendParentRunReference(deps.pi, record);
	};

	const scheduler = new SubagentRunScheduler<RunExecutionContext>({
		// A run in tmux is never cancelled: ending it closes its pi and keeps its session.
		stoppedAs: (context) => (context?.runtime === "tmux" ? "closed" : "cancelled"),
		onStateChange: (record) => {
			// The finalizer already stored a terminal record durably.
			if (!isTerminalSubagentStatus(record.status)) {
				const agentDir = deps.agentDir();
				writePersistedRunRecord(agentDir, record);
				if (record.lastProgressText) {
					writeFullSubagentReport(
						agentDir,
						record,
						`Run: ${record.runId} (${record.agentName})\nStatus: ${record.status}\n\n${record.lastProgressText}`,
					);
				}
			}
			transcripts.changed(record.runId);
			deps.onChange();
		},
		onFinalize: async (settledRecord) => {
			const agentDir = deps.agentDir();
			const record: SubagentRunRecord = structuredClone(settledRecord);
			const reportRes = writeFullSubagentReport(
				agentDir,
				record,
				buildSubagentResultEnvelope(record, MAX_PARENT_REPORT_BYTES).fullReportText,
			);
			if (!reportRes.ok) throw new Error(reportRes.error);
			record.reportPath = reportRes.reportPath;
			if (record.deliveryMode === "background") record.backgroundDeliveryAttempted = true;
			// A run in tmux counts its usage in its own session, which its Reports carry to the ledger.
			if (record.usageAttribution === "ledger" && scheduler.getContext(record.runId)?.runtime !== "tmux")
				recordBackgroundUsageInLedger(agentDir, record);
			const recordRes = writePersistedRunRecord(agentDir, record);
			if (!recordRes.ok) throw new Error(recordRes.error);
			if (deps.scope.inScope(record)) {
				appendParentRunReference(deps.pi, record);
			}
			return record;
		},
		executeRun: async (params) => {
			if (!params.record.generation) recordLaunch(params.record);
			const execCtx = params.context;
			if (!execCtx) throw new Error("Subagent run has no execution context.");
			if (execCtx.runtime === "tmux") {
				const { runId } = params.record;
				const { parent } = execCtx.launch;
				// The orchestrator's messages reach the run's pi through the daemon, as a message from another session.
				deps.bus.register(runId, {
					scope: { parentSessionId: params.record.parentSessionId, sessionEpoch: params.record.sessionEpoch },
					deliver: async (message) => {
						// The user types to a run in its own session, which tells the orchestrator itself.
						if (message.from !== PARENT_MESSAGE_ADDRESS) throw new Error("type to it in its own session");
						const pane = scheduler.getRun(runId)?.pane;
						if (!pane) throw new Error("its pi has not started");
						await new OrchestratorClient().send(pane, {
							type: "session_message",
							kind: "message",
							from: parent,
							name: deps.scope.context()?.sessionManager.getSessionName(),
							text: message.content,
						});
					},
				});
				try {
					return await executeTmuxRun(params, execCtx.launch, {
						tmux: new Tmux(),
						reports: deps.reports,
						notify: (report) => {
							const record = scheduler.getRun(runId);
							if (!record) return;
							deps.scope.notify(record, {
								parentText: reportText(record.name ?? runId, report.text),
								details: buildSubagentResultEnvelope(record, MAX_PARENT_REPORT_BYTES).details,
							});
						},
						usage: (totals) => recordRunSessionUsage(deps.agentDir(), params.record, totals),
					});
				} finally {
					deps.bus.unregister(runId, "has been closed");
				}
			}
			const storage = ensureRunStorageDir(execCtx.agentDir, params.record.parentSessionId, params.record.runId);
			if (!storage.ok) throw new Error(storage.error);
			const { runId } = params.record;
			const scope = {
				parentSessionId: params.record.parentSessionId,
				sessionEpoch: params.record.sessionEpoch,
			};
			// Messages sent while the child session is still being created wait for it, or fail if it never starts.
			let resolveSession!: (session: ChildSession) => void;
			let rejectSession!: (err: Error) => void;
			const sessionReady = new Promise<ChildSession>((resolve, reject) => {
				resolveSession = resolve;
				rejectSession = reject;
			});
			sessionReady.catch(() => {});
			deps.bus.register(runId, {
				scope,
				deliver: async (message) => {
					const childSession = await sessionReady;
					// A message never starts a turn on its own; it waits for the child's next safe boundary.
					await childSession.sendCustomMessage(subagentMessagePayload(message, senderRole(message.from)), {
						deliverAs: "steer",
						triggerTurn: false,
					});
				},
			});
			const reportedHosts = new Set<string>();
			const parentTools = createParentToolProxies(
				execCtx.parent,
				execCtx.parentTools,
				(usage) => params.controller.recordNestedUsage(usage),
				{
					name: params.record.name ?? runId,
					reportNetworkDenied: (target, suspects) => {
						if (reportedHosts.has(target)) return;
						reportedHosts.add(target);
						const whose = suspects.length > 1 ? `one of ${suspects.join(", ")}'s commands` : "my command";
						void deps.bus.send(
							{ address: runId, scope },
							PARENT_MESSAGE_ADDRESS,
							`[sandbox] Network access to ${target} for ${whose} was denied without asking the user, because subagents cannot ask. Run the command yourself (the user will be asked), or change the task.`,
						);
					},
				},
			);
			try {
				await deps.launchesSettled();
				return await deps.runner({
					...params,
					agentDir: execCtx.agentDir,
					definition: execCtx.definition,
					task: execCtx.resume
						? execCtx.resume.prompt
						: withRoster(execCtx.task, describeRoster(scope, runId, false)),
					resumeSessionFile: execCtx.resume?.transcriptPath,
					childModel: execCtx.childModel,
					projectTrusted: execCtx.projectTrusted,
					childSessionDir: storage.runDir,
					childTools: [
						...parentTools,
						createChildMessageTool(runId, params.record.name, scope),
						createChildRosterTool(runId, scope),
					],
					activeToolNames: [...execCtx.activeToolNames, SUBAGENT_MESSAGE_TOOL, SUBAGENT_ROSTER_TOOL],
					builtinExtensions: execCtx.builtinExtensions,
					onChildSessionCreated: (session) => {
						session.subscribe((event) => {
							if (event.type === "agent_end" && !event.willRetry) params.controller.markFinishing();
						});
						transcripts.attach(runId, session);
						resolveSession(session);
					},
				});
			} finally {
				transcripts.detach(runId);
				params.controller.markFinishing();
				rejectSession(new Error("it ended before it could receive messages"));
				deps.bus.unregister(runId, "has finished");
			}
		},
	});

	const directory = createRunDirectory({ scheduler, agentDir: deps.agentDir });

	/**
	 * Resolves with a generation's envelope once it is final. A background or resumed generation is also sent to
	 * the orchestrator as a notice, unless the user, the phone or a session change stopped it.
	 */
	const deliver = async (
		handle: AdmittedSubagentHandle,
		resumedByUser = false,
	): Promise<BuiltSubagentResultEnvelope> => {
		const record = await handle.completion;
		const envelope = buildSubagentResultEnvelope(record, MAX_PARENT_REPORT_BYTES);
		if (
			record.deliveryMode === "background" &&
			record.stopSource !== "user" &&
			record.stopSource !== "remote" &&
			record.stopSource !== "session_invalidated"
		) {
			const parentText = resumedByUser
				? `[Resumed by the user from its transcript; this generation answers the user's message.]\n\n${envelope.parentText}`
				: envelope.parentText;
			deps.scope.notify(record, { parentText, details: envelope.details });
		}
		return envelope;
	};
	const { messageFromParent, messageFromUser } = createRunAddressing({
		scheduler,
		directory,
		bus: deps.bus,
		scope: deps.scope,
		pi: deps.pi,
		deliver,
	});

	return { scheduler, directory, deliver, messageFromParent, messageFromUser, transcripts };
}
