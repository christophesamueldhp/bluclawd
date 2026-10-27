import { randomUUID } from "node:crypto";
import type { AgentDefinitionSource } from "./definitions.ts";

export const SUBAGENT_ID_PREFIX = "sub_";

export type SubagentDeliveryMode = "foreground" | "background";

// queued, timed_out, budget_exceeded and the deadline/budget stop sources only occur in legacy persisted records.
export type SubagentLifecycleStatus =
	| "queued"
	| "starting"
	| "running"
	| "stopping"
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "budget_exceeded"
	| "interrupted";

export type SubagentTerminalStatus =
	| "completed"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "budget_exceeded"
	| "interrupted";

export type SubagentStopSource = "caller" | "user" | "model" | "remote" | "deadline" | "budget" | "session_invalidated";

export interface WorkspaceSnapshot {
	readonly headCommit: string | null;
	readonly dirty: boolean;
	readonly statusDigest: string;
}

export interface SubagentUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	hasUnknownCost: boolean;
}

export interface SubagentRunRecord {
	runId: string;
	parentSessionId: string;
	runtimeGeneration: number;
	parentTurnId: string;
	originToolCallId: string;
	originEntryId?: string;
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
	usage: SubagentUsageTotals;
	foregroundUsageAttributed: boolean;
	backgroundDeliveryAttempted: boolean;
	lastProgressText?: string;
	summaryText?: string;
}

export interface SubagentRunController {
	markRunning(childSessionId?: string): void;
	recordTurn(): void;
	recordToolCall(): void;
	recordUsage(delta: Partial<SubagentUsageTotals>): void;
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
	usage?: SubagentUsageTotals;
}

export interface AdmitSubagentRunRequest {
	parentSessionId: string;
	runtimeGeneration: number;
	parentTurnId: string;
	originToolCallId: string;
	originEntryId?: string;
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
	context?: unknown;
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

export interface SubagentRunSchedulerOptions {
	now?: () => number;
	onStateChange?: (record: Readonly<SubagentRunRecord>) => void;
	executeRun: (params: SubagentRunnerExecuteParams & { context?: unknown }) => Promise<SubagentRunnerOutcome>;
}

const TERMINAL_STATES = new Set<SubagentLifecycleStatus>([
	"completed",
	"failed",
	"cancelled",
	"timed_out",
	"budget_exceeded",
	"interrupted",
]);

export function isTerminalSubagentStatus(status: SubagentLifecycleStatus): status is SubagentTerminalStatus {
	return TERMINAL_STATES.has(status);
}

export function isSubagentTaskId(id: string): boolean {
	return typeof id === "string" && /^sub_[A-Za-z0-9_-]+$/.test(id);
}

export function createEmptySubagentUsage(): SubagentUsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
		hasUnknownCost: false,
	};
}

export function addSubagentUsage(target: SubagentUsageTotals, delta: Partial<SubagentUsageTotals>): void {
	const input = delta.input ?? 0;
	const output = delta.output ?? 0;
	const cacheRead = delta.cacheRead ?? 0;
	const cacheWrite = delta.cacheWrite ?? 0;
	const totalTokens = delta.totalTokens ?? input + output + cacheRead + cacheWrite;

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;

	if (delta.cost) {
		target.cost.input += delta.cost.input ?? 0;
		target.cost.output += delta.cost.output ?? 0;
		target.cost.cacheRead += delta.cost.cacheRead ?? 0;
		target.cost.cacheWrite += delta.cost.cacheWrite ?? 0;
		target.cost.total += delta.cost.total ?? 0;
	}
	if (delta.hasUnknownCost) {
		target.hasUnknownCost = true;
	}
}

interface InternalManagedRun {
	record: SubagentRunRecord;
	abortController: AbortController;
	callerSignal?: AbortSignal;
	callerAbortListener?: () => void;
	pendingTerminalStatus?: SubagentTerminalStatus;
	pendingStopReason?: string;
	pendingStopSource?: SubagentStopSource;
	resolveCompletion: (record: Readonly<SubagentRunRecord>) => void;
	completionPromise: Promise<Readonly<SubagentRunRecord>>;
	disposed: boolean;
	context?: unknown;
}

export class SubagentRunScheduler {
	private readonly now: () => number;
	private readonly onStateChange?: (record: Readonly<SubagentRunRecord>) => void;
	private readonly executeRun: (
		params: SubagentRunnerExecuteParams & { context?: unknown },
	) => Promise<SubagentRunnerOutcome>;

	private readonly runs = new Map<string, InternalManagedRun>();

	constructor(options: SubagentRunSchedulerOptions) {
		this.now = options.now ?? (() => Date.now());
		this.onStateChange = options.onStateChange;
		this.executeRun = options.executeRun;
	}

	getRun(runId: string): Readonly<SubagentRunRecord> | undefined {
		const managed = this.runs.get(runId);
		return managed ? structuredClone(managed.record) : undefined;
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

	admit(request: AdmitSubagentRunRequest): AdmitSubagentRunResult {
		if (request.signal?.aborted) {
			return {
				ok: false,
				error: "Subagent request was aborted before admission.",
			};
		}

		const admittedAt = this.now();
		const runId = `${SUBAGENT_ID_PREFIX}${randomUUID()}`;

		const record: SubagentRunRecord = {
			runId,
			parentSessionId: request.parentSessionId,
			runtimeGeneration: request.runtimeGeneration,
			parentTurnId: request.parentTurnId,
			originToolCallId: request.originToolCallId,
			originEntryId: request.originEntryId,
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
			foregroundUsageAttributed: false,
			backgroundDeliveryAttempted: false,
		};

		let resolveCompletion!: (rec: Readonly<SubagentRunRecord>) => void;
		const completionPromise = new Promise<Readonly<SubagentRunRecord>>((res) => {
			resolveCompletion = res;
		});

		const managed: InternalManagedRun = {
			record,
			abortController: new AbortController(),
			callerSignal: request.signal,
			resolveCompletion,
			completionPromise,
			disposed: false,
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

	cancelRun(runId: string, source: SubagentStopSource = "user", reason = "Subagent run cancelled"): boolean {
		const managed = this.runs.get(runId);
		if (!managed || isTerminalSubagentStatus(managed.record.status)) {
			return false;
		}
		this.triggerStop(managed, source, reason);
		return true;
	}

	cancelRunsForSession(
		parentSessionId: string,
		source: SubagentStopSource = "session_invalidated",
		reason = "Parent session changed or shut down",
	): string[] {
		const cancelled: string[] = [];
		for (const managed of this.runs.values()) {
			if (managed.record.parentSessionId === parentSessionId && !isTerminalSubagentStatus(managed.record.status)) {
				this.triggerStop(managed, source, reason);
				cancelled.push(managed.record.runId);
			}
		}
		return cancelled;
	}

	cancelRunsNotOnBranch(
		parentSessionId: string,
		activeEntryIds: ReadonlySet<string>,
		reason = "Originating branch is no longer active",
	): string[] {
		const cancelled: string[] = [];
		for (const managed of this.runs.values()) {
			if (managed.record.parentSessionId !== parentSessionId) continue;
			if (isTerminalSubagentStatus(managed.record.status)) continue;
			if (managed.record.originEntryId && !activeEntryIds.has(managed.record.originEntryId)) {
				this.triggerStop(managed, "session_invalidated", reason);
				cancelled.push(managed.record.runId);
			}
		}
		return cancelled;
	}

	private startManagedRun(managed: InternalManagedRun): void {
		managed.record.startedAt = this.now();
		this.emitChange(managed);

		const controller: SubagentRunController = {
			markRunning: (childSessionId?: string) => {
				if (isTerminalSubagentStatus(managed.record.status) || managed.record.status === "stopping") return;
				if (childSessionId) managed.record.childSessionId = childSessionId;
				managed.record.status = "running";
				this.emitChange(managed);
			},
			recordTurn: () => {
				if (isTerminalSubagentStatus(managed.record.status)) return;
				managed.record.turnCount++;
			},
			recordToolCall: () => {
				if (isTerminalSubagentStatus(managed.record.status)) return;
				managed.record.toolCallCount++;
			},
			recordUsage: (delta: Partial<SubagentUsageTotals>) => {
				if (isTerminalSubagentStatus(managed.record.status)) return;
				addSubagentUsage(managed.record.usage, delta);
			},
			updateProgress: (text: string) => {
				if (isTerminalSubagentStatus(managed.record.status)) return;
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
				this.finalizeManagedRun(managed, outcome);
			} catch (err) {
				this.finalizeManagedRun(managed, {
					status: managed.pendingTerminalStatus ?? "failed",
					complete: false,
					summaryText: managed.record.summaryText ?? "",
					errorMessage: err instanceof Error ? err.message : String(err),
					stopReason: managed.pendingStopReason,
				});
			}
		})();
	}

	private triggerStop(managed: InternalManagedRun, source: SubagentStopSource, reason: string): void {
		if (isTerminalSubagentStatus(managed.record.status)) {
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

	private finalizeManagedRun(managed: InternalManagedRun, outcome: SubagentRunnerOutcome): void {
		if (isTerminalSubagentStatus(managed.record.status)) {
			return;
		}

		const finalStatus: SubagentTerminalStatus = managed.pendingTerminalStatus ?? outcome.status;
		managed.record.status = finalStatus;
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
		if (outcome.usage) {
			addSubagentUsage(managed.record.usage, {
				input: Math.max(0, outcome.usage.input - managed.record.usage.input),
				output: Math.max(0, outcome.usage.output - managed.record.usage.output),
				cacheRead: Math.max(0, outcome.usage.cacheRead - managed.record.usage.cacheRead),
				cacheWrite: Math.max(0, outcome.usage.cacheWrite - managed.record.usage.cacheWrite),
				totalTokens: Math.max(0, outcome.usage.totalTokens - managed.record.usage.totalTokens),
				cost: {
					input: Math.max(0, outcome.usage.cost.input - managed.record.usage.cost.input),
					output: Math.max(0, outcome.usage.cost.output - managed.record.usage.cost.output),
					cacheRead: Math.max(0, outcome.usage.cost.cacheRead - managed.record.usage.cost.cacheRead),
					cacheWrite: Math.max(0, outcome.usage.cost.cacheWrite - managed.record.usage.cost.cacheWrite),
					total: Math.max(0, outcome.usage.cost.total - managed.record.usage.cost.total),
				},
				hasUnknownCost: outcome.usage.hasUnknownCost,
			});
		}

		this.disposeManagedResources(managed);
		this.emitChange(managed);
		managed.resolveCompletion(structuredClone(managed.record));
	}

	private disposeManagedResources(managed: InternalManagedRun): void {
		if (managed.disposed) return;
		managed.disposed = true;
		if (managed.callerSignal && managed.callerAbortListener) {
			managed.callerSignal.removeEventListener("abort", managed.callerAbortListener);
			managed.callerAbortListener = undefined;
		}
	}

	private emitChange(managed: InternalManagedRun): void {
		try {
			this.onStateChange?.(structuredClone(managed.record));
		} catch {
			// Listener errors must never break scheduler state transitions
		}
	}
}
