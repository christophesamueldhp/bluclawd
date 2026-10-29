import { randomUUID } from "node:crypto";
import { AGENT_TASK_ID_PREFIX } from "../_shared/agent-tasks.ts";
import type { AgentDefinitionSource } from "./definitions.ts";
import {
	createEmptySubagentUsage,
	createGenerationUsage,
	type GenerationUsage,
	type SubagentUsageTotals,
	type UsageAttribution,
} from "./usage.ts";

export type SubagentDeliveryMode = "foreground" | "background";

export type SubagentLifecycleStatus =
	| "starting"
	| "running"
	| "stopping"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export type SubagentTerminalStatus = "completed" | "failed" | "cancelled" | "interrupted";

export type SubagentStopSource = "caller" | "user" | "model" | "remote" | "session_invalidated";

export interface WorkspaceSnapshot {
	readonly headCommit: string | null;
	readonly dirty: boolean;
	readonly statusDigest: string;
}

export interface SubagentRunRecord {
	runId: string;
	parentSessionId: string;
	sessionEpoch: number;
	parentTurnId: string;
	originToolCallId: string;
	originEntryId?: string;
	/** Unique among the parent's live runs; absent on older records. */
	name?: string;
	/** How many times the orchestrator resumed this run after it completed; absent before the first resume. */
	generation?: number;
	childSessionId?: string;
	transcriptPath?: string;
	reportPath?: string;
	agentName: string;
	definitionSource: AgentDefinitionSource;
	provider: string;
	modelId: string;
	thinkingLevel: string;
	cwd: string;
	taskSummary: string;
	startSnapshot: WorkspaceSnapshot;
	endSnapshot?: WorkspaceSnapshot;
	snapshotDrifted: boolean;
	admittedAt: number;
	startedAt?: number;
	endedAt?: number;
	deliveryMode: SubagentDeliveryMode;
	status: SubagentLifecycleStatus;
	stopReason?: string;
	stopSource?: SubagentStopSource;
	errorMessage?: string;
	complete: boolean;
	turnCount: number;
	toolCallCount: number;
	/** Finished child tool executions observed by the runtime, per tool; absent on older records. */
	toolExecutions?: Record<string, { ok: number; error: number }>;
	usage: SubagentUsageTotals;
	/** Where the generation's usage went; set when it settles. */
	usageAttribution?: UsageAttribution;
	backgroundDeliveryAttempted: boolean;
	lastProgressText?: string;
	/** The child's latest model turn or tool call; absent on older records. */
	lastActivity?: { kind: "turn" | "tool"; detail?: string; at: number };
	/** When the child last sent an agent message. */
	lastMessageAt?: number;
	summaryText?: string;
}

export interface SubagentRunController {
	markRunning(childSessionId?: string, thinkingLevel?: string): void;
	recordTurn(): void;
	recordToolCall(toolName?: string): void;
	recordToolExecution(toolName: string, isError: boolean): void;
	recordUsage(delta: Partial<SubagentUsageTotals>): void;
	/** Usage reported by an orchestrator tool the child ran. */
	recordNestedUsage(delta: Partial<SubagentUsageTotals>): void;
	updateProgress(text: string): void;
}

export interface SubagentRunnerExecuteParams {
	readonly record: Readonly<SubagentRunRecord>;
	readonly signal: AbortSignal;
	readonly controller: SubagentRunController;
}

export interface SubagentRunnerOutcome {
	status: SubagentTerminalStatus;
	complete: boolean;
	summaryText: string;
	stopReason?: string;
	errorMessage?: string;
	childSessionId?: string;
	transcriptPath?: string;
	reportPath?: string;
	endSnapshot?: WorkspaceSnapshot;
}

export interface AdmitSubagentRunRequest<C = unknown> {
	parentSessionId: string;
	sessionEpoch: number;
	parentTurnId: string;
	originToolCallId: string;
	originEntryId?: string;
	name?: string;
	agentName: string;
	definitionSource: AgentDefinitionSource;
	provider: string;
	modelId: string;
	thinkingLevel: string;
	cwd: string;
	taskSummary?: string;
	startSnapshot?: WorkspaceSnapshot;
	deliveryMode: SubagentDeliveryMode;
	signal?: AbortSignal;
	context?: C;
}

export interface AdmittedSubagentHandle {
	readonly runId: string;
	readonly record: Readonly<SubagentRunRecord>;
	readonly completion: Promise<Readonly<SubagentRunRecord>>;
}

export interface AdmitSubagentRunResult {
	readonly ok: boolean;
	readonly handle?: AdmittedSubagentHandle;
	readonly error?: string;
}

export interface SubagentRunSchedulerOptions<C = unknown> {
	now?: () => number;
	onStateChange?: (record: Readonly<SubagentRunRecord>) => void;
	/** Durably stores a settled run before it turns terminal; a throw fails the run. */
	onFinalize?: (record: Readonly<SubagentRunRecord>) => Promise<Readonly<SubagentRunRecord>>;
	executeRun: (params: SubagentRunnerExecuteParams & { context?: C }) => Promise<SubagentRunnerOutcome>;
}

const TERMINAL_STATES = new Set<SubagentLifecycleStatus>(["completed", "failed", "cancelled", "interrupted"]);

export function isTerminalSubagentStatus(status: SubagentLifecycleStatus): status is SubagentTerminalStatus {
	return TERMINAL_STATES.has(status);
}

interface InternalManagedRun<C> {
	record: SubagentRunRecord;
	usage: GenerationUsage;
	abortController: AbortController;
	callerSignal?: AbortSignal;
	callerAbortListener?: () => void;
	pendingTerminalStatus?: SubagentTerminalStatus;
	pendingStopReason?: string;
	pendingStopSource?: SubagentStopSource;
	resolveCompletion: (record: Readonly<SubagentRunRecord>) => void;
	completionPromise: Promise<Readonly<SubagentRunRecord>>;
	disposed: boolean;
	finalizing: boolean;
	context?: C;
}

export class SubagentRunScheduler<C = unknown> {
	private readonly now: () => number;
	private readonly onStateChange?: (record: Readonly<SubagentRunRecord>) => void;
	private readonly onFinalize?: (record: Readonly<SubagentRunRecord>) => Promise<Readonly<SubagentRunRecord>>;
	private readonly executeRun: (
		params: SubagentRunnerExecuteParams & { context?: C },
	) => Promise<SubagentRunnerOutcome>;

	private readonly runs = new Map<string, InternalManagedRun<C>>();

	constructor(options: SubagentRunSchedulerOptions<C>) {
		this.now = options.now ?? (() => Date.now());
		this.onStateChange = options.onStateChange;
		this.onFinalize = options.onFinalize;
		this.executeRun = options.executeRun;
	}

	getRun(runId: string): Readonly<SubagentRunRecord> | undefined {
		const managed = this.runs.get(runId);
		return managed ? structuredClone(managed.record) : undefined;
	}

	/** The context a run was admitted or last resumed with. */
	getContext(runId: string): C | undefined {
		return this.runs.get(runId)?.context;
	}

	recordMessageSent(runId: string): void {
		const managed = this.runs.get(runId);
		if (managed && !isTerminalSubagentStatus(managed.record.status)) managed.record.lastMessageAt = this.now();
	}

	listRuns(): Readonly<SubagentRunRecord>[] {
		return Array.from(this.runs.values()).map((m) => structuredClone(m.record));
	}

	listActiveRuns(parentSessionId?: string): Readonly<SubagentRunRecord>[] {
		const out: Readonly<SubagentRunRecord>[] = [];
		for (const managed of this.runs.values()) {
			if (parentSessionId && managed.record.parentSessionId !== parentSessionId) continue;
			if (!isTerminalSubagentStatus(managed.record.status)) {
				out.push(structuredClone(managed.record));
			}
		}
		return out;
	}

	admit(request: AdmitSubagentRunRequest<C>): AdmitSubagentRunResult {
		if (request.signal?.aborted) {
			return {
				ok: false,
				error: "Subagent request was aborted before admission.",
			};
		}

		const admittedAt = this.now();
		const runId = `${AGENT_TASK_ID_PREFIX}${randomUUID()}`;

		const record: SubagentRunRecord = {
			runId,
			parentSessionId: request.parentSessionId,
			sessionEpoch: request.sessionEpoch,
			parentTurnId: request.parentTurnId,
			originToolCallId: request.originToolCallId,
			originEntryId: request.originEntryId,
			name: request.name,
			agentName: request.agentName,
			definitionSource: request.definitionSource,
			provider: request.provider,
			modelId: request.modelId,
			thinkingLevel: request.thinkingLevel,
			cwd: request.cwd,
			taskSummary: request.taskSummary ?? "",
			startSnapshot: request.startSnapshot ?? {
				headCommit: null,
				dirty: false,
				statusDigest: "",
			},
			snapshotDrifted: false,
			admittedAt,
			deliveryMode: request.deliveryMode,
			status: "starting",
			complete: false,
			turnCount: 0,
			toolCallCount: 0,
			usage: createEmptySubagentUsage(),
			backgroundDeliveryAttempted: false,
		};

		let resolveCompletion!: (rec: Readonly<SubagentRunRecord>) => void;
		const completionPromise = new Promise<Readonly<SubagentRunRecord>>((res) => {
			resolveCompletion = res;
		});

		const managed: InternalManagedRun<C> = {
			record,
			usage: createGenerationUsage({ kind: request.deliveryMode }),
			abortController: new AbortController(),
			callerSignal: request.signal,
			resolveCompletion,
			completionPromise,
			disposed: false,
			finalizing: false,
			context: request.context,
		};

		if (request.signal) {
			const onCallerAbort = () => {
				this.cancelRun(runId, "caller", "Cancelled by parent tool signal");
			};
			managed.callerAbortListener = onCallerAbort;
			request.signal.addEventListener("abort", onCallerAbort, { once: true });
		}

		this.runs.set(runId, managed);

		this.startManagedRun(managed);

		return {
			ok: true,
			handle: {
				runId,
				record: structuredClone(managed.record),
				completion: completionPromise,
			},
		};
	}

	/**
	 * Runs a completed run again under the same identity, in the background. Its usage starts from zero so
	 * the earlier generation's usage, already attributed, is never counted twice.
	 */
	resume(runId: string, context: C): AdmitSubagentRunResult {
		const managed = this.runs.get(runId);
		if (!managed) return { ok: false, error: "Subagent run is unknown." };
		if (managed.record.status !== "completed") {
			return { ok: false, error: `Subagent run is ${managed.record.status}; only a completed run can be resumed.` };
		}
		let resolveCompletion!: (rec: Readonly<SubagentRunRecord>) => void;
		const completionPromise = new Promise<Readonly<SubagentRunRecord>>((res) => {
			resolveCompletion = res;
		});
		Object.assign(managed, {
			record: {
				...managed.record,
				endedAt: undefined,
				endSnapshot: undefined,
				stopReason: undefined,
				stopSource: undefined,
				errorMessage: undefined,
				summaryText: undefined,
				generation: (managed.record.generation ?? 0) + 1,
				status: "starting",
				complete: false,
				deliveryMode: "background",
				usage: createEmptySubagentUsage(),
				usageAttribution: undefined,
				backgroundDeliveryAttempted: false,
			} satisfies SubagentRunRecord,
			usage: createGenerationUsage({ kind: "resume" }),
			abortController: new AbortController(),
			callerSignal: undefined,
			callerAbortListener: undefined,
			pendingTerminalStatus: undefined,
			pendingStopReason: undefined,
			pendingStopSource: undefined,
			resolveCompletion,
			completionPromise,
			disposed: false,
			finalizing: false,
			context,
		});
		this.startManagedRun(managed);
		return { ok: true, handle: { runId, record: structuredClone(managed.record), completion: completionPromise } };
	}

	/** The tool result that launched this run reached the orchestrator's conversation. */
	launchResultEmitted(runId: string): void {
		this.runs.get(runId)?.usage.launchResultEmitted();
	}

	cancelRun(runId: string, source: SubagentStopSource = "user", reason = "Subagent run cancelled"): boolean {
		const managed = this.runs.get(runId);
		if (!managed || isTerminalSubagentStatus(managed.record.status)) {
			return false;
		}
		this.triggerStop(managed, source, reason);
		return true;
	}

	/** Cancels every live run `where` selects, as invalidated by the parent session. */
	cancelRuns(where: (record: Readonly<SubagentRunRecord>) => boolean, reason: string): void {
		for (const managed of this.runs.values()) {
			if (!isTerminalSubagentStatus(managed.record.status) && where(managed.record)) {
				this.triggerStop(managed, "session_invalidated", reason);
			}
		}
	}

	private startManagedRun(managed: InternalManagedRun<C>): void {
		managed.record.startedAt = this.now();
		this.emitChange(managed);

		// A resume reuses `managed`, so a controller from an earlier generation must not touch the new one.
		const generation = managed.record.generation;
		const inactive = () =>
			managed.record.generation !== generation || isTerminalSubagentStatus(managed.record.status);
		const controller: SubagentRunController = {
			markRunning: (childSessionId?: string, thinkingLevel?: string) => {
				if (inactive() || managed.record.status === "stopping") return;
				if (childSessionId) managed.record.childSessionId = childSessionId;
				if (thinkingLevel) managed.record.thinkingLevel = thinkingLevel;
				managed.record.status = "running";
				this.emitChange(managed);
			},
			recordTurn: () => {
				if (inactive()) return;
				managed.record.turnCount++;
				managed.record.lastActivity = { kind: "turn", at: this.now() };
			},
			recordToolCall: (toolName?: string) => {
				if (inactive()) return;
				managed.record.toolCallCount++;
				managed.record.lastActivity = { kind: "tool", detail: toolName, at: this.now() };
			},
			recordToolExecution: (toolName: string, isError: boolean) => {
				if (inactive()) return;
				managed.record.toolExecutions ??= {};
				managed.record.toolExecutions[toolName] ??= { ok: 0, error: 0 };
				const counts = managed.record.toolExecutions[toolName];
				if (isError) counts.error++;
				else counts.ok++;
			},
			recordUsage: (delta: Partial<SubagentUsageTotals>) => {
				if (inactive()) return;
				managed.usage.addTurn(delta);
				managed.record.usage = managed.usage.totals;
			},
			recordNestedUsage: (delta: Partial<SubagentUsageTotals>) => {
				if (inactive()) return;
				managed.usage.addNested(delta);
				managed.record.usage = managed.usage.totals;
			},
			updateProgress: (text: string) => {
				if (inactive()) return;
				managed.record.lastProgressText = text;
				this.emitChange(managed);
			},
		};

		void (async () => {
			try {
				const outcome = await this.executeRun({
					record: structuredClone(managed.record),
					signal: managed.abortController.signal,
					controller,
					context: managed.context,
				});
				await this.finalizeManagedRun(managed, outcome);
			} catch (err) {
				await this.finalizeManagedRun(managed, {
					status: managed.pendingTerminalStatus ?? "failed",
					complete: false,
					summaryText: managed.record.summaryText ?? "",
					errorMessage: err instanceof Error ? err.message : String(err),
					stopReason: managed.pendingStopReason,
				});
			}
		})();
	}

	private triggerStop(managed: InternalManagedRun<C>, source: SubagentStopSource, reason: string): void {
		if (managed.finalizing || isTerminalSubagentStatus(managed.record.status)) {
			return;
		}
		if (!managed.pendingTerminalStatus) {
			managed.pendingTerminalStatus = "cancelled";
			managed.pendingStopSource = source;
			managed.pendingStopReason = reason;
			managed.record.stopSource = source;
			managed.record.stopReason = reason;
		}

		if (managed.record.status !== "stopping") {
			managed.record.status = "stopping";
			this.emitChange(managed);
		}
		if (!managed.abortController.signal.aborted) {
			managed.abortController.abort(new Error(reason));
		}
	}

	private async finalizeManagedRun(managed: InternalManagedRun<C>, outcome: SubagentRunnerOutcome): Promise<void> {
		if (managed.finalizing || isTerminalSubagentStatus(managed.record.status)) {
			return;
		}
		managed.finalizing = true;

		const finalStatus: SubagentTerminalStatus = managed.pendingTerminalStatus ?? outcome.status;
		managed.record.endedAt = this.now();
		managed.record.complete = finalStatus === "completed" ? outcome.complete : false;
		managed.record.summaryText = outcome.summaryText;
		if (outcome.childSessionId) managed.record.childSessionId = outcome.childSessionId;
		if (outcome.transcriptPath) managed.record.transcriptPath = outcome.transcriptPath;
		if (outcome.reportPath) managed.record.reportPath = outcome.reportPath;
		if (outcome.endSnapshot) {
			managed.record.endSnapshot = outcome.endSnapshot;
			managed.record.snapshotDrifted =
				managed.record.startSnapshot.headCommit !== outcome.endSnapshot.headCommit ||
				managed.record.startSnapshot.statusDigest !== outcome.endSnapshot.statusDigest;
		}
		if (outcome.stopReason && !managed.record.stopReason) {
			managed.record.stopReason = outcome.stopReason;
		}
		if (outcome.errorMessage) {
			managed.record.errorMessage = outcome.errorMessage;
		}
		managed.record.usageAttribution = managed.usage.settle();

		let finalized: SubagentRunRecord = { ...structuredClone(managed.record), status: finalStatus };
		if (this.onFinalize) {
			try {
				finalized = structuredClone(await this.onFinalize(finalized));
			} catch (err) {
				finalized = {
					...finalized,
					status: "failed",
					complete: false,
					errorMessage: `Run finalization failed: ${err instanceof Error ? err.message : String(err)}`,
				};
				// Store the failure the same way so nothing durable still reads as a success.
				try {
					finalized = structuredClone(await this.onFinalize(finalized));
				} catch {
					// Storage is unusable; the failure stays visible in memory.
				}
			}
		}
		managed.record = finalized;

		this.disposeManagedResources(managed);
		this.emitChange(managed);
		managed.resolveCompletion(structuredClone(managed.record));
	}

	/** Resolves once every run this scheduler owns has settled and been stored. */
	async waitForSettled(): Promise<void> {
		await Promise.all(Array.from(this.runs.values(), (managed) => managed.completionPromise));
	}

	private disposeManagedResources(managed: InternalManagedRun<C>): void {
		if (managed.disposed) return;
		managed.disposed = true;
		if (managed.callerSignal && managed.callerAbortListener) {
			managed.callerSignal.removeEventListener("abort", managed.callerAbortListener);
			managed.callerAbortListener = undefined;
		}
	}

	private emitChange(managed: InternalManagedRun<C>): void {
		try {
			this.onStateChange?.(structuredClone(managed.record));
		} catch {
			// Listener errors must never break scheduler state transitions
		}
	}
}
