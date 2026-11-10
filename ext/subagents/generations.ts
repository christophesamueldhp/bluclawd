import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionMessage, SessionUsage } from "../../daemon/ipc/protocol.ts";
import { createRunAddressing } from "./addressing.ts";
import { formatRunLabel, type RunExecutionContext } from "./admission.ts";
import { createRunDirectory } from "./directory.ts";
import {
	capReport,
	fromRunText,
	PARENT_MESSAGE_ADDRESS,
	SUBAGENT_MESSAGE_CUSTOM_TYPE,
	type SubagentMessageBus,
} from "./messages.ts";
import { inParentScope, type ParentScope, type ParentScopeChecks, type ScopedRun } from "./parent-scope.ts";
import { buildSubagentResultEnvelope, MAX_PARENT_REPORT_BYTES, type SubagentResultDetails } from "./results.ts";
import { executeRpcRun, type RunSlots } from "./rpc-runs.ts";
import { postToRun, whenGiven } from "./run-mailbox.ts";
import { type RpcRunSender, rpcRunMessageText } from "./run-messages.ts";
import { isTerminalSubagentStatus, type SubagentRunRecord, SubagentRunScheduler } from "./runs.ts";
import {
	appendParentRunReference,
	readRunReports,
	recordRunSessionUsage,
	storedRunReportTextPath,
	subagentReportPath,
	subagentRunDir,
	writeFullSubagentReport,
	writePersistedRunRecord,
} from "./storage.ts";
import { executeTmuxRun, type RunReports, sendToRun, storedReport, type TmuxRunDeps } from "./tmux-runs.ts";

/** How long a message's sender waits for the run's host to give it to its pi; a queued run's waits in its inbox. */
const GIVE_WAIT_MS = 5000;

/** A Report no foreground launch took, as the orchestrator is told about it. */
export interface ParentNotice {
	parentText: string;
	details: SubagentResultDetails;
}

export interface GenerationDeps {
	agentDir: () => string;
	bus: SubagentMessageBus;
	scope: ParentScopeChecks & {
		context(): ExtensionContext | undefined;
		notify(run: ScopedRun, notice: ParentNotice): void;
	};
	pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">;
	/** A run changed state. */
	onChange: () => void;
	/** Where the Reports of runs arrive. */
	reports: RunReports;
	/** The tmux server runs start in, as it is when a run starts. */
	tmux: () => TmuxRunDeps["tmux"];
	/** Sends a message to another session through the daemon. */
	send: (pane: string, message: SessionMessage) => Promise<void>;
	/** Aborted when this orchestrator hands its open runs over to the next instance of its session (a reload). */
	handOff: AbortSignal;
	/** The daemon's queue, where runs on pi's RPC take their turn. */
	slots: RunSlots;
}

/** A run's Report as the orchestrator's model is given it, capped, as a tool result or a notice. */
export function reportToParent(
	agentDir: string,
	record: Readonly<SubagentRunRecord>,
	report: { text: string; seq?: number },
): { parentText: string; truncated: boolean } {
	const capped = capReport(report.text, () => {
		const runDir = subagentRunDir(agentDir, record.parentSessionId, record.runId);
		const stored = report.seq === undefined ? undefined : storedRunReportTextPath(runDir, report.seq);
		// An older run stored no text file, and keeps only its latest Report in report.md.
		return stored && existsSync(stored) ? stored : subagentReportPath(agentDir, record.parentSessionId, record.runId);
	});
	return { parentText: fromRunText("Report", formatRunLabel(record), capped.text), truncated: capped.truncated };
}

/** A run's Report as the orchestrator is told of it. */
const noticeOf = (
	agentDir: string,
	record: Readonly<SubagentRunRecord>,
	report: { text: string; seq?: number },
): ParentNotice => {
	const { parentText, truncated } = reportToParent(agentDir, record, report);
	return {
		parentText,
		details: { ...buildSubagentResultEnvelope(record, MAX_PARENT_REPORT_BYTES).details, truncated },
	};
};

/** Persists each generation of a run and routes its messages; the scheduler it owns decides the transitions. */
export function createGenerations(deps: GenerationDeps) {
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
			const recordRes = writePersistedRunRecord(agentDir, record);
			if (!recordRes.ok) throw new Error(recordRes.error);
			if (deps.scope.inScope(record)) {
				appendParentRunReference(deps.pi, record);
			}
			return record;
		},
		executeRun: async (params) => {
			const execCtx = params.context;
			if (!execCtx) throw new Error("Subagent run has no execution context.");
			const { runId } = params.record;
			const notify = (report: { text: string; seq?: number }) => {
				const record = scheduler.getRun(runId);
				if (!record) return;
				deps.scope.notify(record, noticeOf(deps.agentDir(), record, report));
			};
			const usage = (sessionId: string, totals: SessionUsage) =>
				recordRunSessionUsage(deps.agentDir(), params.record, sessionId, totals);
			if ("rpc" in execCtx) {
				if (!params.record.generation) recordLaunch(params.record);
				const scope = { parentSessionId: params.record.parentSessionId, sessionEpoch: params.record.sessionEpoch };
				// Posted to the run's inbox, which its host gives its pi at its next safe point, until the run settles.
				deps.bus.register(runId, {
					scope,
					deliver: async (message) => {
						const record = scheduler.getRun(runId) ?? params.record;
						const sender: RpcRunSender =
							message.from === PARENT_MESSAGE_ADDRESS
								? { kind: "orchestrator" }
								: { kind: "sibling", label: formatRunLabel({ name: message.fromName, runId: message.from }) };
						const text = rpcRunMessageText(sender, record, message.content);
						const posted = postToRun(execCtx.rpc.runDir, record.generation, text);
						if (!posted.accepted) throw new Error("has finished");
						// Accepted once posted; the sender goes on once its pi has it, or its host is slow to take it.
						if (record.status === "running") {
							await whenGiven(execCtx.rpc.runDir, record.generation, posted.id, GIVE_WAIT_MS);
						}
					},
				});
				try {
					return await executeRpcRun(params, execCtx.rpc, {
						reports: deps.reports,
						handOff: deps.handOff,
						slots: deps.slots,
						notify,
						notStarted: (reason) => {
							const record = scheduler.getRun(runId);
							if (!record) return;
							deps.scope.notify(record, {
								parentText: `Subagent ${formatRunLabel(record)} did not start: ${reason}`,
								details: {
									...buildSubagentResultEnvelope(record, MAX_PARENT_REPORT_BYTES).details,
									truncated: false,
								},
							});
						},
						usage,
						// Sent as the run, in the scope it was admitted in: a stale one is refused, and kept on record.
						relay: (message) => {
							const generation = scheduler.getRun(runId)?.generation ?? params.record.generation;
							const kind = message.kind[0].toUpperCase() + message.kind.slice(1);
							void deps.bus.send(
								{ address: runId, scope },
								message.to,
								`${kind} (generation ${generation}): ${message.content}`,
							);
						},
					});
				} finally {
					deps.bus.unregister(runId, "has been closed");
				}
			}
			// A run taken over, after a reload or a crash, was recorded when it launched.
			if (!params.record.generation && !execCtx.launch.pane) recordLaunch(params.record);
			const { parent } = execCtx.launch;
			// The orchestrator's messages reach the run's pi through the daemon, as a message from another session.
			deps.bus.register(runId, {
				scope: { parentSessionId: params.record.parentSessionId, sessionEpoch: params.record.sessionEpoch },
				deliver: async (message) => {
					if (message.from !== PARENT_MESSAGE_ADDRESS) throw new Error("type to it in its own session");
					const pane = scheduler.getRun(runId)?.pane;
					if (!pane) throw new Error("its pi has not started");
					await sendToRun(deps.send, pane, {
						type: "session_message",
						kind: "message",
						from: parent,
						name: deps.scope.context()?.sessionManager.getSessionName(),
						text: message.content,
					});
				},
			});
			// Taken over, perhaps from a pane that is gone: the run is told where to report from now on. Should it not
			// hear, its Reports are read from disk once its pane ends.
			if (execCtx.launch.pane) {
				const adopt: SessionMessage = {
					type: "session_message",
					kind: "adopt",
					from: parent,
					sessionId: params.record.parentSessionId,
				};
				sendToRun(deps.send, execCtx.launch.pane, adopt).catch(() => {});
			}
			try {
				return await executeTmuxRun(params, execCtx.launch, {
					tmux: deps.tmux(),
					reports: deps.reports,
					handOff: deps.handOff,
					notify,
					usage,
					// Kept in the orchestrator's session for the user, who answers in the run's own: it starts no turn.
					needsInput: (dialog) => {
						const record = scheduler.getRun(runId);
						if (!record || !deps.scope.inScope(record)) return;
						const text = `Subagent ${formatRunLabel(record)} needs input${dialog ? `: ${dialog}` : ""}. Open it to answer.`;
						try {
							deps.pi.sendMessage(
								{ customType: SUBAGENT_MESSAGE_CUSTOM_TYPE, content: [{ type: "text", text }], display: true },
								{ deliverAs: "steer", triggerTurn: false },
							);
						} catch {
							// The orchestrator's session was replaced meanwhile.
						}
					},
				});
			} finally {
				deps.bus.unregister(runId, "has been closed");
			}
		},
	});

	/**
	 * Tells the orchestrator of the Reports the scope's runs stored but could not send it, as after the daemon was down.
	 * An open run's go through its own listener, which drops what it was told already.
	 */
	const pullReports = (scope: ParentScope) => {
		const agentDir = deps.agentDir();
		for (const run of scheduler.listRuns()) {
			if (!inParentScope(run, scope)) continue;
			const stored = readRunReports(
				subagentRunDir(agentDir, run.parentSessionId, run.runId),
				run.lastDeliveredSeq ?? 0,
			);
			if (stored.length === 0) continue;
			if (!isTerminalSubagentStatus(run.status)) {
				const { pane } = run;
				if (pane) for (const report of stored) deps.reports.receive(storedReport(pane, report));
				continue;
			}
			// Stored before the orchestrator is told: a crash between the two loses it rather than tell it twice.
			const lastDeliveredSeq = stored[stored.length - 1].seq;
			scheduler.markDelivered(run.runId, lastDeliveredSeq);
			writePersistedRunRecord(agentDir, { ...run, lastDeliveredSeq });
			for (const report of stored) deps.scope.notify(run, noticeOf(agentDir, run, report));
		}
	};

	const directory = createRunDirectory({ scheduler, agentDir: deps.agentDir });
	const { messageFromParent, resumeFromParent } = createRunAddressing({ directory, bus: deps.bus });

	return { scheduler, directory, messageFromParent, resumeFromParent, pullReports };
}
