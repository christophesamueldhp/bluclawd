import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionMessage } from "../../daemon/ipc/protocol.ts";
import { createRunAddressing } from "./addressing.ts";
import type { RunExecutionContext } from "./admission.ts";
import { createRunDirectory } from "./directory.ts";
import { PARENT_MESSAGE_ADDRESS, type SubagentMessageBus } from "./messages.ts";
import type { ParentScopeChecks, ScopedRun } from "./parent-scope.ts";
import { buildSubagentResultEnvelope, MAX_PARENT_REPORT_BYTES, type SubagentResultDetails } from "./results.ts";
import { isTerminalSubagentStatus, type SubagentRunRecord, SubagentRunScheduler } from "./runs.ts";
import {
	appendParentRunReference,
	recordRunSessionUsage,
	writeFullSubagentReport,
	writePersistedRunRecord,
} from "./storage.ts";
import { executeTmuxRun, type RunReports, reportText, type TmuxRunDeps } from "./tmux-runs.ts";

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
	pi: Pick<ExtensionAPI, "appendEntry">;
	/** A run changed state. */
	onChange: () => void;
	/** Where the Reports of runs arrive. */
	reports: RunReports;
	/** The tmux server runs start in, as it is when a run starts. */
	tmux: () => TmuxRunDeps["tmux"];
	/** Sends a message to another session through the daemon. */
	send: (pane: string, message: SessionMessage) => Promise<void>;
}

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
		stoppedAs: () => "closed",
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
			if (!params.record.generation) recordLaunch(params.record);
			const execCtx = params.context;
			if (!execCtx) throw new Error("Subagent run has no execution context.");
			const { runId } = params.record;
			const { parent } = execCtx.launch;
			// The orchestrator's messages reach the run's pi through the daemon, as a message from another session.
			deps.bus.register(runId, {
				scope: { parentSessionId: params.record.parentSessionId, sessionEpoch: params.record.sessionEpoch },
				deliver: async (message) => {
					if (message.from !== PARENT_MESSAGE_ADDRESS) throw new Error("type to it in its own session");
					const pane = scheduler.getRun(runId)?.pane;
					if (!pane) throw new Error("its pi has not started");
					await deps.send(pane, {
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
					notify: (report) => {
						const record = scheduler.getRun(runId);
						if (!record) return;
						deps.scope.notify(record, {
							parentText: reportText(record.name ?? runId, report.text),
							details: buildSubagentResultEnvelope(record, MAX_PARENT_REPORT_BYTES).details,
						});
					},
					usage: (sessionId, totals) => recordRunSessionUsage(deps.agentDir(), params.record, sessionId, totals),
					// For the user, not the model: the prompt is answered in the run's own session.
					needsInput: (dialog) => {
						const record = scheduler.getRun(runId);
						if (!record || !deps.scope.inScope(record)) return;
						try {
							deps.scope
								.context()
								?.ui.notify(
									`Subagent ${record.name ?? runId} needs input${dialog ? `: ${dialog}` : ""}. Open it to answer.`,
									"warning",
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

	const directory = createRunDirectory({ scheduler, agentDir: deps.agentDir });
	const { messageFromParent } = createRunAddressing({ directory, bus: deps.bus });

	return { scheduler, directory, messageFromParent };
}
