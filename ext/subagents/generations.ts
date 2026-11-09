import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionMessage } from "../../daemon/ipc/protocol.ts";
import { createRunAddressing } from "./addressing.ts";
import { formatRunLabel, type RunExecutionContext } from "./admission.ts";
import { createRunDirectory } from "./directory.ts";
import {
	fromRunText,
	PARENT_MESSAGE_ADDRESS,
	SUBAGENT_MESSAGE_CUSTOM_TYPE,
	type SubagentMessageBus,
} from "./messages.ts";
import { inParentScope, type ParentScope, type ParentScopeChecks, type ScopedRun } from "./parent-scope.ts";
import { buildSubagentResultEnvelope, MAX_PARENT_REPORT_BYTES, type SubagentResultDetails } from "./results.ts";
import { isTerminalSubagentStatus, type SubagentRunRecord, SubagentRunScheduler } from "./runs.ts";
import {
	appendParentRunReference,
	getSubagentsRootDir,
	readRunReports,
	recordRunSessionUsage,
	writeFullSubagentReport,
	writePersistedRunRecord,
} from "./storage.ts";
import { executeTmuxRun, type RunReports, sendToRun, type TmuxRunDeps } from "./tmux-runs.ts";

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
}

/** A run's Report as the orchestrator is told of it. */
const noticeOf = (record: Readonly<SubagentRunRecord>, text: string): ParentNotice => ({
	parentText: fromRunText("Report", formatRunLabel(record), text),
	details: buildSubagentResultEnvelope(record, MAX_PARENT_REPORT_BYTES).details,
});

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
		// A run is never cancelled: ending it closes its pi and keeps its session.
		stoppedAs: "closed",
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
			// A run taken over after a reload was recorded when it launched.
			if (!params.record.generation && !execCtx.launch.pane) recordLaunch(params.record);
			const { runId } = params.record;
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
			try {
				return await executeTmuxRun(params, execCtx.launch, {
					tmux: deps.tmux(),
					reports: deps.reports,
					handOff: deps.handOff,
					notify: (report) => {
						const record = scheduler.getRun(runId);
						if (!record) return;
						deps.scope.notify(record, noticeOf(record, report.text));
					},
					usage: (sessionId, totals) => recordRunSessionUsage(deps.agentDir(), params.record, sessionId, totals),
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
				join(getSubagentsRootDir(agentDir), run.parentSessionId, run.runId),
				run.lastDeliveredSeq ?? 0,
			);
			if (stored.length === 0) continue;
			if (!isTerminalSubagentStatus(run.status)) {
				if (run.pane)
					for (const report of stored)
						deps.reports.receive({ type: "session_message", kind: "report", from: run.pane, ...report });
				continue;
			}
			for (const report of stored) deps.scope.notify(run, noticeOf(run, report.text));
			const lastDeliveredSeq = stored[stored.length - 1].seq;
			scheduler.markDelivered(run.runId, lastDeliveredSeq);
			writePersistedRunRecord(agentDir, { ...run, lastDeliveredSeq });
		}
	};

	const directory = createRunDirectory({ scheduler, agentDir: deps.agentDir });
	const { messageFromParent } = createRunAddressing({ directory, bus: deps.bus });

	return { scheduler, directory, messageFromParent, pullReports };
}
