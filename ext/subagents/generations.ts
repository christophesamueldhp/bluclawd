import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionMessage, SessionUsage } from "../../daemon/ipc/protocol.ts";
import { hostAllowed } from "../sandbox/runtime.ts";
import { createRunAddressing } from "./addressing.ts";
import type { RunExecutionContext } from "./admission.ts";
import type { BatchResultDetails } from "./batches.ts";
import type { ChainResultDetails } from "./chains.ts";
import { createRunDirectory } from "./directory.ts";
import {
	PARENT_MESSAGE_ADDRESS,
	type RpcRunSender,
	type RunReports,
	rpcRunMessageText,
	SUBAGENT_MESSAGE_CUSTOM_TYPE,
	type SubagentMessageBus,
} from "./messages.ts";
import { inParentScope, type ParentScope, type ParentScopeChecks, type ScopedRun } from "./parent-scope.ts";
import { buildSubagentResultEnvelope, MAX_PARENT_REPORT_BYTES, type SubagentResultDetails } from "./results.ts";
import { executeRpcRun, type RunSlots } from "./rpc-runs.ts";
import { NETWORK_ACCESS, type RunApprovalAnswer, type RunApprovalRequest } from "./run-approvals.ts";
import { generationReport } from "./run-evidence.ts";
import { userInstructionNote } from "./run-intervention.ts";
import { postToRun, whenGiven } from "./run-mailbox.ts";
import { formatRunLabel, isTerminalSubagentStatus, type SubagentRunRecord, SubagentRunScheduler } from "./runs.ts";
import { reportToParent } from "./settling.ts";
import {
	appendParentRunReference,
	readRunReports,
	recordRunSessionUsage,
	subagentRunDir,
	writeFullSubagentReport,
	writePersistedRunRecord,
} from "./storage.ts";
import { executeTmuxRun, sendToRun, storedReport, type TmuxRunDeps } from "./tmux-runs.ts";

const GIVE_WAIT_MS = 5000;

export interface ParentNotice {
	parentText: string;
	details: SubagentResultDetails | BatchResultDetails | ChainResultDetails;
}

export interface GenerationDeps {
	agentDir: () => string;
	bus: SubagentMessageBus;
	scope: ParentScopeChecks & {
		context(): ExtensionContext | undefined;
		notify(run: ScopedRun, notice: ParentNotice): void;
		holds(id: string): boolean;
	};
	pi: Pick<ExtensionAPI, "appendEntry" | "sendMessage">;
	onChange: () => void;
	reports: RunReports;
	tmux: () => TmuxRunDeps["tmux"];
	send: (pane: string, message: SessionMessage) => Promise<void>;
	handOff: AbortSignal;
	slots: RunSlots;
}

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

export function createGenerations(deps: GenerationDeps) {
	const recordLaunch = (record: Readonly<SubagentRunRecord>) => {
		writeFullSubagentReport(
			deps.agentDir(),
			record,
			`Run: ${record.runId} (${record.agentName})\nStatus: ${record.status}\nTask: ${record.taskSummary}`,
		);
		appendParentRunReference(deps.pi, record);
	};

	const allowed = new Set<string>();
	let lastDialogSettled: Promise<unknown> = Promise.resolve();
	const approve = (runId: string, request: RunApprovalRequest, signal: AbortSignal): Promise<RunApprovalAnswer> => {
		const answer = lastDialogSettled.then(async (): Promise<RunApprovalAnswer> => {
			const record = scheduler.getRun(runId);
			if (!record || signal.aborted || !deps.scope.inScope(record)) return "blocked";
			const key = JSON.stringify([record.parentSessionId, record.sessionEpoch, request.action, request.target]);
			if (allowed.has(key)) return "allow";
			const alreadyAllowedForSession = request.action === NETWORK_ACCESS && hostAllowed(request.target);
			if (alreadyAllowedForSession) return "allow";
			const ctx = deps.scope.context();
			if (!ctx?.hasUI) return "blocked";
			const yes = await ctx.ui.confirm(
				`Subagent ${formatRunLabel(record)}, generation ${record.generation}, asks for approval`,
				`${request.action} ${request.target}\n\nYes holds for every run of this session that asks the same.`,
				{ signal },
			);
			if (signal.aborted) return "blocked";
			if (yes) allowed.add(key);
			const leftScope = !deps.scope.inScope(record);
			if (leftScope) return "blocked";
			return yes ? "allow" : "deny";
		});
		lastDialogSettled = answer.catch(() => {});
		return answer;
	};

	const scheduler = new SubagentRunScheduler<RunExecutionContext>({
		onStateChange: (record) => {
			const finalizerStoredIt = isTerminalSubagentStatus(record.status);
			if (!finalizerStoredIt) {
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
			const note = (text: (record: Readonly<SubagentRunRecord>) => string) => {
				const record = scheduler.getRun(runId);
				if (!record || !deps.scope.inScope(record)) return;
				try {
					deps.pi.sendMessage(
						{
							customType: SUBAGENT_MESSAGE_CUSTOM_TYPE,
							content: [{ type: "text", text: text(record) }],
							display: true,
						},
						{ deliverAs: "steer", triggerTurn: false },
					);
				} catch {
					// The orchestrator's session was replaced meanwhile.
				}
			};
			const usage = (sessionId: string, totals: SessionUsage) =>
				recordRunSessionUsage(deps.agentDir(), params.record, sessionId, totals);
			if ("rpc" in execCtx) {
				const firstLaunch = !params.record.generation && !execCtx.rpc.recovered;
				if (firstLaunch) recordLaunch(params.record);
				const scope = { parentSessionId: params.record.parentSessionId, sessionEpoch: params.record.sessionEpoch };
				deps.bus.register(runId, {
					scope,
					deliver: async (message) => {
						const record = scheduler.getRun(runId) ?? params.record;
						const sender: RpcRunSender =
							message.from === PARENT_MESSAGE_ADDRESS
								? { kind: "orchestrator" }
								: { kind: "sibling", label: formatRunLabel({ name: message.fromName, runId: message.from }) };
						const text = rpcRunMessageText(sender, record, message.content);
						const posted = postToRun(execCtx.rpc.runDir, record.generation, text, message.id);
						if (!posted.accepted) throw new Error("has finished");
						if (record.status === "running") {
							await whenGiven(execCtx.rpc.runDir, record.generation, posted.id, GIVE_WAIT_MS);
						}
					},
				});
				const tell = (what: string) => {
					const record = scheduler.getRun(runId);
					if (!record) return;
					deps.scope.notify(record, {
						parentText: `Subagent ${formatRunLabel(record)} ${what}`,
						details: {
							...buildSubagentResultEnvelope(record, MAX_PARENT_REPORT_BYTES).details,
							truncated: false,
						},
					});
				};
				try {
					return await executeRpcRun(params, execCtx.rpc, {
						reports: deps.reports,
						handOff: deps.handOff,
						slots: deps.slots,
						notify,
						notStarted: (reason) => tell(`did not start: ${reason}`),
						lost: (reason) => tell(`ended while its orchestrator's session was gone: ${reason}`),
						usage,
						relay: (message) => {
							const generation: number = scheduler.getRun(runId)?.generation ?? params.record.generation;
							const kind = message.kind[0].toUpperCase() + message.kind.slice(1);
							const id: string = `${runId}/${generation}/${message.seq}`;
							let siblingKeptIt = false;
							void deps.bus
								.send(
									{ address: runId, scope },
									message.to,
									`${kind} (generation ${generation}): ${message.content}`,
									id,
								)
								.then((receipt) => {
									siblingKeptIt = receipt.to !== PARENT_MESSAGE_ADDRESS;
								});
							const holdsOrSiblingKept = (): boolean => siblingKeptIt || deps.scope.holds(id);
							return holdsOrSiblingKept;
						},
						typed: (text) => note((record) => userInstructionNote(record, text)),
						approve: (request, signal) => approve(runId, request, signal),
					});
				} finally {
					deps.bus.unregister(runId, "has been closed");
				}
			}
			const { parent, pane } = execCtx.launch;
			deps.bus.register(runId, {
				scope: { parentSessionId: params.record.parentSessionId, sessionEpoch: params.record.sessionEpoch },
				deliver: async (message) => {
					if (message.from !== PARENT_MESSAGE_ADDRESS) throw new Error("type to it in its own session");
					await sendToRun(deps.send, pane, {
						type: "session_message",
						kind: "message",
						from: parent,
						name: deps.scope.context()?.sessionManager.getSessionName(),
						text: message.content,
					});
				},
			});
			const adopt: SessionMessage = {
				type: "session_message",
				kind: "adopt",
				from: parent,
				sessionId: params.record.parentSessionId,
			};
			sendToRun(deps.send, pane, adopt).catch(() => {});
			try {
				return await executeTmuxRun(params, execCtx.launch, {
					tmux: deps.tmux(),
					reports: deps.reports,
					handOff: deps.handOff,
					notify,
					usage,
					needsInput: (dialog) =>
						note(
							(record) =>
								`Subagent ${formatRunLabel(record)} needs input${dialog ? `: ${dialog}` : ""}. Open it to answer.`,
						),
				});
			} finally {
				deps.bus.unregister(runId, "has been closed");
			}
		},
	});

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
			markDeliveredThenTell(agentDir, run, stored);
		}
	};

	const markDeliveredThenTell = (
		agentDir: string,
		run: Readonly<SubagentRunRecord>,
		stored: ReturnType<typeof readRunReports>,
	) => {
		const lastDeliveredSeq = stored[stored.length - 1].seq;
		scheduler.markDelivered(run.runId, lastDeliveredSeq);
		writePersistedRunRecord(agentDir, { ...run, lastDeliveredSeq });
		for (const report of stored) deps.scope.notify(run, noticeOf(agentDir, run, report));
	};

	const directory = createRunDirectory({ scheduler, agentDir: deps.agentDir });
	const { messageFromParent, resumeFromParent } = createRunAddressing({ directory, bus: deps.bus });

	const retellReport = (run: Readonly<SubagentRunRecord>) => {
		const agentDir = deps.agentDir();
		const report = generationReport(subagentRunDir(agentDir, run.parentSessionId, run.runId), run.generation);
		if (report) deps.scope.notify(run, noticeOf(agentDir, run, report));
	};

	return { scheduler, directory, messageFromParent, resumeFromParent, pullReports, retellReport };
}
