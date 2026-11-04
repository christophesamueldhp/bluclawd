import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type AdmissionContext, formatRunLabel, type RunAdmission, type RunExecutionContext } from "./admission.ts";
import { createRunDirectory } from "./directory.ts";
import {
	formatMessageReceipt,
	PARENT_MESSAGE_ADDRESS,
	SUBAGENT_MESSAGE_PARAMETERS,
	SUBAGENT_MESSAGE_TOOL,
	type SubagentMessageBus,
	type SubagentMessageReceipt,
	subagentMessagePayload,
	USER_MESSAGE_ADDRESS,
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
	writeFullSubagentReport,
	writePersistedRunRecord,
} from "./storage.ts";
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
	scope: ParentScopeChecks & { notify(run: ScopedRun, notice: ParentNotice): void };
	pi: Pick<ExtensionAPI, "appendEntry">;
	/** Settles once every launch in flight has been admitted (#99). */
	launchesSettled: () => Promise<void>;
	/** A run changed state. */
	onChange: () => void;
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
			if (record.usageAttribution === "ledger") recordBackgroundUsageInLedger(agentDir, record);
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
							if (event.type === "agent_end") directory.endTurn(runId);
						});
						transcripts.attach(runId, session);
						resolveSession(session);
					},
				});
			} finally {
				transcripts.detach(runId);
				directory.endTurn(runId);
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
	const deliver = async (handle: AdmittedSubagentHandle): Promise<BuiltSubagentResultEnvelope> => {
		const record = await handle.completion;
		const envelope = buildSubagentResultEnvelope(record, MAX_PARENT_REPORT_BYTES);
		if (
			record.deliveryMode === "background" &&
			record.stopSource !== "user" &&
			record.stopSource !== "remote" &&
			record.stopSource !== "session_invalidated"
		) {
			deps.scope.notify(record, { parentText: envelope.parentText, details: envelope.details });
		}
		return envelope;
	};

	const resumeRun = async (
		run: Readonly<SubagentRunRecord>,
		toolCallId: string,
		content: string,
		scope: ParentScope,
		admission: Pick<RunAdmission, "resume">,
		ctx: AdmissionContext,
	) => {
		let receipt: SubagentMessageReceipt | undefined;
		const resumed = await admission.resume(
			run,
			toolCallId,
			() => {
				receipt = deps.bus.accept({ address: PARENT_MESSAGE_ADDRESS, scope }, run.runId, run.name);
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

	/**
	 * A message from the orchestrator. A final run resumes, or is refused with the reason it cannot; a finishing
	 * one is waited for until it is final first. A message to any other run goes through the bus.
	 */
	const messageFromParent = async (
		scope: ParentScope,
		to: string,
		content: string,
		toolCallId: string,
		admission: Pick<RunAdmission, "resume">,
		ctx: AdmissionContext | undefined,
	) => {
		let found = directory.find(scope, to);
		if (found?.state === "finishing") {
			await scheduler.whenFinal(found.record.runId);
			found = directory.get(found.record.runId);
		}
		if (found?.state === "finished" && ctx)
			return resumeRun(found.record, toolCallId, content, scope, admission, ctx);
		return formatMessageReceipt(await deps.bus.send({ address: PARENT_MESSAGE_ADDRESS, scope }, to, content));
	};

	/**
	 * A message the user typed in a run's transcript. A running run takes it at its next safe point, through the
	 * bus like the orchestrator's; a final run is refused with the reason, once a finishing one is final.
	 */
	const messageFromUser = async (
		scope: ParentScope,
		runId: string,
		content: string,
	): Promise<SubagentMessageReceipt> => {
		let found = directory.get(runId);
		if (found?.state === "finishing") {
			await scheduler.whenFinal(runId);
			found = directory.get(runId);
		}
		if (found?.state !== "finished") return deps.bus.send({ address: USER_MESSAGE_ADDRESS, scope }, runId, content);
		const { record } = found;
		const label = record.name ?? record.runId;
		// Resuming a completed run from its transcript (#160) belongs here.
		const reason =
			record.status === "completed"
				? `${label} has finished; resuming it from its transcript is not available yet.`
				: record.status === "cancelled"
					? `${label} was stopped and cannot take messages.`
					: `${label} ${record.status === "failed" ? "failed" : "was interrupted"} and cannot take messages.`;
		return { status: "unavailable", seq: 0, to: runId, toName: record.name, reason };
	};

	return { scheduler, directory, deliver, messageFromParent, messageFromUser, transcripts };
}
