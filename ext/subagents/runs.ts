import { randomUUID } from "node:crypto";
import type { AgentDefinitionSource } from "./definitions.ts";
import { MAX_SUBAGENT_TURNS } from "./definitions.ts";

export const SUBAGENT_ID_PREFIX = "sub_";
export const MAX_ACTIVE_SUBAGENTS = 2;
export const MAX_QUEUED_SUBAGENTS = 4;
export const DEFAULT_SUBAGENT_DEADLINE_MS = 5 * 60 * 1000;
export const MAX_SUBAGENT_TOOL_CALLS = 40;
export const MAX_SUBAGENT_REPORTED_TOKENS = 100_000;
export const MAX_PARENT_TURN_RUNS = 6;
export const MAX_PARENT_TURN_TOKENS = 300_000;
export const MAX_REPEATED_IDENTICAL_CALLS = 3;
export const MAX_REPEATED_POLICY_DENIALS = 3;

export type SubagentDeliveryMode = "foreground" | "background";

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
	deadlineAt: number;
	deliveryMode: SubagentDeliveryMode;
	status: SubagentLifecycleStatus;
	stopReason?: string;
	stopSource?: SubagentStopSource;
	errorMessage?: string;
	complete: boolean;
	turnCount: number;
	toolCallCount: number;
	repeatedCallCount: number;
	repeatedDenialCount: number;
	usage: SubagentUsageTotals;
	foregroundUsageAttributed: boolean;
	backgroundDeliveryAttempted: boolean;
	lastProgressText?: string;
	summaryText?: string;
}

export interface SubagentRunController {
	markRunning(childSessionId?: string): void;
	recordTurn(): void;
	recordToolCall(toolName: string, args: unknown): void;
	recordPolicyDenial(reason: string): void;
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
	maxTurns?: number;
	maxToolCalls?: number;
	maxReportedTokens?: number;
	deadlineMs?: number;
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
	maxActive?: number;
	maxQueued?: number;
	defaultDeadlineMs?: number;
	maxTurnsCeiling?: number;
	maxToolCallsCeiling?: number;
	maxReportedTokensCeiling?: number;
	maxParentTurnRuns?: number;
	maxParentTurnTokens?: number;
	maxRepeatedIdenticalCalls?: number;
	maxRepeatedPolicyDenials?: number;
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

function canonicalizeArgs(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalizeArgs(item)).join(",")}]`;
	}
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeArgs(obj[k])}`).join(",")}}`;
}

interface InternalManagedRun {
	record: SubagentRunRecord;
	maxTurns: number;
	maxToolCalls: number;
	maxReportedTokens: number;
	abortController: AbortController;
	callerSignal?: AbortSignal;
	callerAbortListener?: () => void;
	deadlineTimer?: ReturnType<typeof setTimeout>;
	pendingTerminalStatus?: SubagentTerminalStatus;
	pendingStopReason?: string;
	pendingStopSource?: SubagentStopSource;
	lastCallSignature?: string;
	consecutiveSignatureCount: number;
	signatureCounts: Map<string, number>;
	resolveCompletion: (record: Readonly<SubagentRunRecord>) => void;
	completionPromise: Promise<Readonly<SubagentRunRecord>>;
	activeSlotOccupied: boolean;
	disposed: boolean;
	context?: unknown;
}

export class SubagentRunScheduler {
	private readonly maxActive: number;
	private readonly maxQueued: number;
	private readonly defaultDeadlineMs: number;
	private readonly maxTurnsCeiling: number;
	private readonly maxToolCallsCeiling: number;
	private readonly maxReportedTokensCeiling: number;
	private readonly maxParentTurnRuns: number;
	private readonly maxParentTurnTokens: number;
	private readonly maxRepeatedIdenticalCalls: number;
	private readonly maxRepeatedPolicyDenials: number;
	private readonly now: () => number;
	private readonly onStateChange?: (record: Readonly<SubagentRunRecord>) => void;
	private readonly executeRun: (
		params: SubagentRunnerExecuteParams & { context?: unknown },
	) => Promise<SubagentRunnerOutcome>;

	private readonly runs = new Map<string, InternalManagedRun>();
	private readonly queue: string[] = [];
	private activeSlotCount = 0;

	private currentTurnKey: string | undefined;
	private currentTurnRunCount = 0;
	private currentTurnTokens = 0;

	constructor(options: SubagentRunSchedulerOptions) {
		this.maxActive = options.maxActive ?? MAX_ACTIVE_SUBAGENTS;
		this.maxQueued = options.maxQueued ?? MAX_QUEUED_SUBAGENTS;
		this.defaultDeadlineMs = options.defaultDeadlineMs ?? DEFAULT_SUBAGENT_DEADLINE_MS;
		this.maxTurnsCeiling = options.maxTurnsCeiling ?? MAX_SUBAGENT_TURNS;
		this.maxToolCallsCeiling = options.maxToolCallsCeiling ?? MAX_SUBAGENT_TOOL_CALLS;
		this.maxReportedTokensCeiling = options.maxReportedTokensCeiling ?? MAX_SUBAGENT_REPORTED_TOKENS;
		this.maxParentTurnRuns = options.maxParentTurnRuns ?? MAX_PARENT_TURN_RUNS;
		this.maxParentTurnTokens = options.maxParentTurnTokens ?? MAX_PARENT_TURN_TOKENS;
		this.maxRepeatedIdenticalCalls = options.maxRepeatedIdenticalCalls ?? MAX_REPEATED_IDENTICAL_CALLS;
		this.maxRepeatedPolicyDenials = options.maxRepeatedPolicyDenials ?? MAX_REPEATED_POLICY_DENIALS;
		this.now = options.now ?? (() => Date.now());
		this.onStateChange = options.onStateChange;
		this.executeRun = options.executeRun;
	}

	getActiveCount(): number {
		return this.activeSlotCount;
	}

	getQueuedCount(): number {
		return this.queue.length;
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

		// Track per-turn parent delegation budget (soft-stopped before admission)
		const turnKey = `${request.parentSessionId}:${request.runtimeGeneration}:${request.parentTurnId}`;
		if (this.currentTurnKey !== turnKey) {
			this.currentTurnKey = turnKey;
			this.currentTurnRunCount = 0;
			this.currentTurnTokens = 0;
		}
		if (this.currentTurnRunCount >= this.maxParentTurnRuns) {
			return {
				ok: false,
				error: `Parent delegation budget exceeded for this turn (maximum ${this.maxParentTurnRuns} child runs per parent turn). Synthesize existing findings or perform remaining lookups directly.`,
			};
		}
		if (this.currentTurnTokens >= this.maxParentTurnTokens) {
			return {
				ok: false,
				error: `Parent delegation budget exceeded for this turn (${this.currentTurnTokens} cumulative child tokens >= ${this.maxParentTurnTokens} limit). Synthesize existing findings directly.`,
			};
		}

		// Enforce active + queue bounds synchronously before async startup
		const shouldQueue = this.activeSlotCount >= this.maxActive || this.queue.length > 0;
		if (shouldQueue && this.queue.length >= this.maxQueued) {
			return {
				ok: false,
				error: `Subagent queue is full (${this.maxActive} active, ${this.maxQueued} queued). Wait for existing subagent runs to finish before launching more.`,
			};
		}

		this.currentTurnRunCount++;

		const admittedAt = this.now();
		const deadlineMs = Math.max(1, request.deadlineMs ?? this.defaultDeadlineMs);
		const runId = `${SUBAGENT_ID_PREFIX}${randomUUID()}`;
		const maxTurns = Math.min(this.maxTurnsCeiling, Math.max(1, request.maxTurns ?? this.maxTurnsCeiling));
		const maxToolCalls = Math.min(
			this.maxToolCallsCeiling,
			Math.max(1, request.maxToolCalls ?? this.maxToolCallsCeiling),
		);
		const maxReportedTokens = Math.min(
			this.maxReportedTokensCeiling,
			Math.max(1, request.maxReportedTokens ?? this.maxReportedTokensCeiling),
		);

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
			deadlineAt: admittedAt + deadlineMs,
			deliveryMode: request.deliveryMode,
			status: "queued",
			complete: false,
			turnCount: 0,
			toolCallCount: 0,
			repeatedCallCount: 0,
			repeatedDenialCount: 0,
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
			maxTurns,
			maxToolCalls,
			maxReportedTokens,
			abortController: new AbortController(),
			callerSignal: request.signal,
			consecutiveSignatureCount: 0,
			signatureCounts: new Map(),
			resolveCompletion,
			completionPromise,
			activeSlotOccupied: false,
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

		managed.deadlineTimer = setTimeout(() => {
			this.triggerStop(managed, "timed_out", "deadline", `Subagent run exceeded ${deadlineMs}ms deadline`);
		}, deadlineMs);

		this.runs.set(runId, managed);

		if (shouldQueue) {
			this.queue.push(runId);
			this.emitChange(managed);
		} else {
			this.startManagedRun(managed);
		}

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
		this.triggerStop(managed, "cancelled", source, reason);
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
				this.triggerStop(managed, "cancelled", source, reason);
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
				this.triggerStop(managed, "cancelled", "session_invalidated", reason);
				cancelled.push(managed.record.runId);
			}
		}
		return cancelled;
	}

	private startManagedRun(managed: InternalManagedRun): void {
		if (isTerminalSubagentStatus(managed.record.status)) {
			return;
		}
		if (managed.pendingTerminalStatus) {
			this.finalizeManagedRun(managed, {
				status: managed.pendingTerminalStatus,
				complete: false,
				summaryText: managed.record.summaryText ?? "",
				stopReason: managed.pendingStopReason,
			});
			return;
		}

		managed.activeSlotOccupied = true;
		this.activeSlotCount++;
		managed.record.status = "starting";
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
				if (managed.record.turnCount > managed.maxTurns) {
					this.triggerStop(managed, "budget_exceeded", "budget", `Turn limit (${managed.maxTurns}) exceeded`);
				}
			},
			recordToolCall: (toolName: string, args: unknown) => {
				if (isTerminalSubagentStatus(managed.record.status)) return;
				managed.record.toolCallCount++;
				const sig = `${toolName}:${canonicalizeArgs(args)}`;
				if (managed.lastCallSignature === sig) {
					managed.consecutiveSignatureCount++;
				} else {
					managed.lastCallSignature = sig;
					managed.consecutiveSignatureCount = 1;
				}
				const totalSameCall = (managed.signatureCounts.get(sig) ?? 0) + 1;
				managed.signatureCounts.set(sig, totalSameCall);
				managed.record.repeatedCallCount = Math.max(
					managed.record.repeatedCallCount,
					managed.consecutiveSignatureCount,
					totalSameCall,
				);

				if (managed.record.toolCallCount > managed.maxToolCalls) {
					this.triggerStop(
						managed,
						"budget_exceeded",
						"budget",
						`Tool call limit (${managed.maxToolCalls}) exceeded`,
					);
					return;
				}
				if (
					managed.consecutiveSignatureCount >= this.maxRepeatedIdenticalCalls ||
					totalSameCall >= this.maxRepeatedIdenticalCalls
				) {
					this.triggerStop(
						managed,
						"budget_exceeded",
						"budget",
						`Stopped repetitive identical tool call loop (${toolName} repeated ${totalSameCall} times)`,
					);
				}
			},
			recordPolicyDenial: (reason: string) => {
				if (isTerminalSubagentStatus(managed.record.status)) return;
				managed.record.repeatedDenialCount++;
				if (managed.record.repeatedDenialCount >= this.maxRepeatedPolicyDenials) {
					this.triggerStop(
						managed,
						"budget_exceeded",
						"budget",
						`Stopped after ${managed.record.repeatedDenialCount} repeated permission denials (last: ${reason})`,
					);
				}
			},
			recordUsage: (delta: Partial<SubagentUsageTotals>) => {
				if (isTerminalSubagentStatus(managed.record.status)) return;
				const prevTokens = managed.record.usage.totalTokens;
				addSubagentUsage(managed.record.usage, delta);
				const addedTokens = Math.max(0, managed.record.usage.totalTokens - prevTokens);
				const runTurnKey = `${managed.record.parentSessionId}:${managed.record.runtimeGeneration}:${managed.record.parentTurnId}`;
				if (this.currentTurnKey === runTurnKey) {
					this.currentTurnTokens += addedTokens;
				}
				if (managed.record.usage.totalTokens > managed.maxReportedTokens) {
					this.triggerStop(
						managed,
						"budget_exceeded",
						"budget",
						`Token budget (${managed.maxReportedTokens}) exceeded (${managed.record.usage.totalTokens} tokens)`,
					);
				}
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

	private triggerStop(
		managed: InternalManagedRun,
		terminalStatus: "cancelled" | "timed_out" | "budget_exceeded",
		source: SubagentStopSource,
		reason: string,
	): void {
		if (isTerminalSubagentStatus(managed.record.status)) {
			return;
		}
		if (!managed.pendingTerminalStatus) {
			managed.pendingTerminalStatus = terminalStatus;
			managed.pendingStopSource = source;
			managed.pendingStopReason = reason;
			managed.record.stopSource = source;
			managed.record.stopReason = reason;
		}

		// If still queued, remove from FIFO queue and finalize immediately without starting
		if (managed.record.status === "queued") {
			const idx = this.queue.indexOf(managed.record.runId);
			if (idx !== -1) {
				this.queue.splice(idx, 1);
			}
			managed.record.status = "stopping";
			this.emitChange(managed);
			this.finalizeManagedRun(managed, {
				status: managed.pendingTerminalStatus,
				complete: false,
				summaryText: "",
				stopReason: managed.pendingStopReason,
			});
			return;
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
			const prevTokens = managed.record.usage.totalTokens;
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
			const deltaTokens = Math.max(0, managed.record.usage.totalTokens - prevTokens);
			const runTurnKey = `${managed.record.parentSessionId}:${managed.record.runtimeGeneration}:${managed.record.parentTurnId}`;
			if (this.currentTurnKey === runTurnKey) {
				this.currentTurnTokens += deltaTokens;
			}
		}

		this.disposeManagedResources(managed);
		this.emitChange(managed);
		managed.resolveCompletion(structuredClone(managed.record));
		this.pumpQueue();
	}

	private disposeManagedResources(managed: InternalManagedRun): void {
		if (managed.disposed) return;
		managed.disposed = true;
		if (managed.deadlineTimer !== undefined) {
			clearTimeout(managed.deadlineTimer);
			managed.deadlineTimer = undefined;
		}
		if (managed.callerSignal && managed.callerAbortListener) {
			managed.callerSignal.removeEventListener("abort", managed.callerAbortListener);
			managed.callerAbortListener = undefined;
		}
		if (managed.activeSlotOccupied) {
			managed.activeSlotOccupied = false;
			this.activeSlotCount = Math.max(0, this.activeSlotCount - 1);
		}
	}

	private pumpQueue(): void {
		while (this.activeSlotCount < this.maxActive && this.queue.length > 0) {
			const nextId = this.queue.shift();
			if (!nextId) break;
			const nextManaged = this.runs.get(nextId);
			if (!nextManaged || isTerminalSubagentStatus(nextManaged.record.status)) {
				continue;
			}
			this.startManagedRun(nextManaged);
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
