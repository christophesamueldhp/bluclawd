import { randomUUID } from "node:crypto";
import type { AgentActivity } from "../../daemon/activity.ts";
import type { SessionUsage } from "../../daemon/ipc/protocol.ts";
import { AGENT_TASK_ID_PREFIX } from "../_shared/agent-tasks.ts";
import type { AgentDefinitionSource } from "./definitions.ts";
import { createEmptySubagentUsage } from "./usage.ts";

export type SubagentDeliveryMode = "foreground" | "background";

export type SubagentLifecycleStatus =
	| "starting"
	| "running"
	| "stopping"
	| "failed"
	| "interrupted"
	| "closed"
	| "cancelled";

export type SubagentTerminalStatus = "failed" | "interrupted" | "closed" | "cancelled";

export type SubagentStopSource = "caller" | "user" | "model" | "remote" | "session_invalidated";

export type RunKind = "pane" | "rpc" | "legacy";
export type LatestGenerationKind = Exclude<RunKind, "legacy">;
export const RUNS_ON_ITS_OWN_PI = "rpc";

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
	name?: string;
	generation: number;
	pane?: string;
	backend?: typeof RUNS_ON_ITS_OWN_PI;
	kind?: LatestGenerationKind;
	activity?: AgentActivity;
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
	admittedAt: number;
	startedAt?: number;
	endedAt?: number;
	deliveryMode: SubagentDeliveryMode;
	batch?: string;
	chain?: string;
	status: SubagentLifecycleStatus;
	stopReason?: string;
	stopSource?: SubagentStopSource;
	errorMessage?: string;
	usage: SessionUsage;
	backgroundDeliveryAttempted: boolean;
	lastDeliveredSeq?: number;
	lastProgressText?: string;
	summaryText?: string;
}

export interface SubagentRunController {
	markRunning(): void;
	recordPane(pane: string): void;
	updateActivity(activity: AgentActivity): void;
	updateUsage(totals: SessionUsage): void;
	updateProgress(text: string): void;
	markDelivered(seq: number): void;
}

export type PiSettlement = { status: "completed" } | { status: "failed" | "stopped"; error: string };

export const settledWithoutError = (settlement: PiSettlement): settlement is { status: "completed" } =>
	settlement.status === "completed";

export interface SubagentRunExecuteParams {
	readonly record: Readonly<SubagentRunRecord>;
	readonly signal: AbortSignal;
	readonly controller: SubagentRunController;
}

export interface SubagentRunOutcome {
	status: SubagentTerminalStatus;
	summaryText: string;
	stopReason?: string;
	errorMessage?: string;
	transcriptPath?: string;
	reportPath?: string;
}

export interface AdmitSubagentRunRequest<C = unknown> {
	runId?: string;
	parentSessionId: string;
	sessionEpoch: number;
	parentTurnId: string;
	originToolCallId: string;
	originEntryId?: string;
	name?: string;
	backend?: typeof RUNS_ON_ITS_OWN_PI;
	kind?: LatestGenerationKind;
	agentName: string;
	definitionSource: AgentDefinitionSource;
	provider: string;
	modelId: string;
	thinkingLevel: string;
	cwd: string;
	taskSummary?: string;
	startSnapshot?: WorkspaceSnapshot;
	deliveryMode: SubagentDeliveryMode;
	batch?: string;
	chain?: string;
	signal?: AbortSignal;
	context?: C;
}

export interface AdmittedSubagentHandle {
	readonly runId: string;
	readonly record: Readonly<SubagentRunRecord>;
	readonly completion: Promise<Readonly<SubagentRunRecord>>;
}

export type AdmitSubagentRunResult =
	| { readonly ok: true; readonly handle: AdmittedSubagentHandle }
	| { readonly ok: false; readonly error: string };

export interface SubagentRunSchedulerOptions<C = unknown> {
	now?: () => number;
	onStateChange?: (record: Readonly<SubagentRunRecord>) => void;
	onFinalize?: (record: Readonly<SubagentRunRecord>) => Promise<Readonly<SubagentRunRecord>>;
	executeRun: (params: SubagentRunExecuteParams & { context?: C }) => Promise<SubagentRunOutcome>;
}

export function createRunId(): string {
	return `${AGENT_TASK_ID_PREFIX}${randomUUID()}`;
}

export const handedOff = (): Promise<never> => new Promise<never>(() => {});

export function bestEffort(attempt: () => void): boolean {
	try {
		attempt();
		return true;
	} catch {
		return false;
	}
}

export async function bestEffortAsync(attempt: () => Promise<void>): Promise<boolean> {
	try {
		await attempt();
		return true;
	} catch {
		return false;
	}
}

export function tryTmux<T>(call: () => T): T | undefined {
	try {
		return call();
	} catch {
		return undefined;
	}
}

export function formatRunLabel(run: Pick<SubagentRunRecord, "name" | "runId">): string {
	return run.name ? `"${run.name}" (${run.runId})` : `"${run.runId}"`;
}

export function isLegacyRun(run: Pick<SubagentRunRecord, "backend">): boolean {
	return run.backend !== RUNS_ON_ITS_OWN_PI;
}

const TERMINAL_STATES = new Set<SubagentLifecycleStatus>(["failed", "interrupted", "closed", "cancelled"]);

export function isResumableSubagentStatus(status: SubagentLifecycleStatus): boolean {
	return status === "closed" || status === "cancelled";
}

export function isTerminalSubagentStatus(status: SubagentLifecycleStatus): status is SubagentTerminalStatus {
	return TERMINAL_STATES.has(status);
}

interface InternalManagedRun<C> {
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
	finalizing: boolean;
	context?: C;
}

export class SubagentRunScheduler<C = unknown> {
	private readonly now: () => number;
	private readonly onStateChange?: (record: Readonly<SubagentRunRecord>) => void;
	private readonly onFinalize?: (record: Readonly<SubagentRunRecord>) => Promise<Readonly<SubagentRunRecord>>;
	private readonly executeRun: (params: SubagentRunExecuteParams & { context?: C }) => Promise<SubagentRunOutcome>;

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

	getContext(runId: string): C | undefined {
		return this.runs.get(runId)?.context;
	}

	whenFinal(runId: string): Promise<Readonly<SubagentRunRecord>> | undefined {
		return this.runs.get(runId)?.completionPromise;
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
		const runId = request.runId ?? createRunId();

		const record: SubagentRunRecord = {
			runId,
			parentSessionId: request.parentSessionId,
			sessionEpoch: request.sessionEpoch,
			parentTurnId: request.parentTurnId,
			originToolCallId: request.originToolCallId,
			originEntryId: request.originEntryId,
			name: request.name,
			...(request.backend ? { backend: request.backend } : {}),
			...(request.kind ? { kind: request.kind } : {}),
			generation: 0,
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
			admittedAt,
			deliveryMode: request.deliveryMode,
			...(request.batch ? { batch: request.batch } : {}),
			...(request.chain ? { chain: request.chain } : {}),
			status: "starting",
			usage: createEmptySubagentUsage(),
			backgroundDeliveryAttempted: false,
		};

		let resolveCompletion!: (rec: Readonly<SubagentRunRecord>) => void;
		const completionPromise = new Promise<Readonly<SubagentRunRecord>>((res) => {
			resolveCompletion = res;
		});

		const managed: InternalManagedRun<C> = {
			record,
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

	resume(
		runId: string,
		context: C,
		stored?: Readonly<SubagentRunRecord>,
		admitted?: Pick<SubagentRunRecord, "provider" | "modelId" | "thinkingLevel" | "kind">,
	): AdmitSubagentRunResult {
		if (!this.runs.has(runId) && stored?.runId === runId && isResumableSubagentStatus(stored.status)) {
			this.adopt(stored);
		}
		const managed = this.runs.get(runId);
		if (!managed) return { ok: false, error: "Subagent run is unknown." };
		if (!isResumableSubagentStatus(managed.record.status)) {
			return {
				ok: false,
				error: `Subagent run is ${managed.record.status}; only a closed or cancelled run can be resumed.`,
			};
		}
		let resolveCompletion!: (rec: Readonly<SubagentRunRecord>) => void;
		const completionPromise = new Promise<Readonly<SubagentRunRecord>>((res) => {
			resolveCompletion = res;
		});
		Object.assign(managed, {
			record: {
				...managed.record,
				...admitted,
				startedAt: undefined,
				endedAt: undefined,
				stopReason: undefined,
				stopSource: undefined,
				errorMessage: undefined,
				summaryText: undefined,
				lastProgressText: undefined,
				generation: managed.record.generation + 1,
				status: "starting",
				deliveryMode: "background",
				activity: undefined,
				backgroundDeliveryAttempted: false,
			} satisfies SubagentRunRecord,
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

	takeOver(stored: Readonly<SubagentRunRecord>, context: C): void {
		if (this.runs.has(stored.runId)) return;
		let resolveCompletion!: (rec: Readonly<SubagentRunRecord>) => void;
		const completionPromise = new Promise<Readonly<SubagentRunRecord>>((res) => {
			resolveCompletion = res;
		});
		const managed: InternalManagedRun<C> = {
			record: { ...(structuredClone(stored) as SubagentRunRecord), deliveryMode: "background" },
			abortController: new AbortController(),
			resolveCompletion,
			completionPromise,
			disposed: false,
			finalizing: false,
			context,
		};
		this.runs.set(stored.runId, managed);
		this.startManagedRun(managed);
	}

	reopen(run: Readonly<SubagentRunRecord>, sessionEpoch: number): void {
		const managed = this.runs.get(run.runId);
		if (managed && !isTerminalSubagentStatus(managed.record.status)) return;
		if (managed) managed.record.sessionEpoch = sessionEpoch;
		else this.adopt({ ...run, sessionEpoch });
	}

	private adopt(stored: Readonly<SubagentRunRecord>): void {
		const record = structuredClone(stored) as SubagentRunRecord;
		this.runs.set(record.runId, {
			record,
			abortController: new AbortController(),
			resolveCompletion: () => {},
			completionPromise: Promise.resolve(structuredClone(record)),
			disposed: true,
			finalizing: false,
		});
	}

	markDelivered(runId: string, seq: number): void {
		const managed = this.runs.get(runId);
		if (managed && seq > (managed.record.lastDeliveredSeq ?? 0)) managed.record.lastDeliveredSeq = seq;
	}

	cancelRun(runId: string, source: SubagentStopSource = "user", reason = "Subagent run cancelled"): boolean {
		const managed = this.runs.get(runId);
		if (!managed || isTerminalSubagentStatus(managed.record.status)) {
			return false;
		}
		this.triggerStop(managed, source, reason);
		return true;
	}

	cancelRuns(where: (record: Readonly<SubagentRunRecord>) => boolean, reason: string): void {
		for (const managed of this.runs.values()) {
			if (!isTerminalSubagentStatus(managed.record.status) && where(managed.record)) {
				this.triggerStop(managed, "session_invalidated", reason);
			}
		}
	}

	private startManagedRun(managed: InternalManagedRun<C>): void {
		managed.record.startedAt ??= this.now();
		this.emitChange(managed);

		const generation = managed.record.generation;
		const inactive = () =>
			managed.record.generation !== generation || isTerminalSubagentStatus(managed.record.status);
		const controller: SubagentRunController = {
			markRunning: () => {
				if (inactive() || managed.record.status === "stopping") return;
				managed.record.status = "running";
				this.emitChange(managed);
			},
			recordPane: (pane: string) => {
				if (inactive()) return;
				managed.record.pane = pane;
				this.emitChange(managed);
			},
			updateActivity: (activity: AgentActivity) => {
				if (inactive()) return;
				managed.record.activity = activity;
				this.emitChange(managed);
			},
			updateUsage: (totals: SessionUsage) => {
				if (inactive()) return;
				managed.record.usage = structuredClone(totals);
			},
			updateProgress: (text: string) => {
				if (inactive()) return;
				managed.record.lastProgressText = text;
				this.emitChange(managed);
			},
			markDelivered: (seq: number) => {
				if (inactive()) return;
				this.markDelivered(managed.record.runId, seq);
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
			managed.pendingTerminalStatus = "closed";
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

	private async finalizeManagedRun(managed: InternalManagedRun<C>, outcome: SubagentRunOutcome): Promise<void> {
		if (managed.finalizing || isTerminalSubagentStatus(managed.record.status)) {
			return;
		}
		managed.finalizing = true;

		const finalStatus: SubagentTerminalStatus =
			outcome.status === "closed" ? (managed.pendingTerminalStatus ?? "closed") : outcome.status;
		managed.record.endedAt = this.now();
		managed.record.summaryText = outcome.summaryText;
		if (outcome.transcriptPath) managed.record.transcriptPath = outcome.transcriptPath;
		if (outcome.reportPath) managed.record.reportPath = outcome.reportPath;
		if (outcome.stopReason && !managed.record.stopReason) {
			managed.record.stopReason = outcome.stopReason;
		}
		if (outcome.errorMessage) {
			managed.record.errorMessage = outcome.errorMessage;
		}

		let finalized: SubagentRunRecord = { ...structuredClone(managed.record), status: finalStatus };
		const { onFinalize } = this;
		if (onFinalize) {
			try {
				finalized = structuredClone(await onFinalize(finalized));
			} catch (err) {
				finalized = {
					...finalized,
					status: "failed",
					errorMessage: `Run finalization failed: ${err instanceof Error ? err.message : String(err)}`,
				};
				await bestEffortAsync(async () => {
					finalized = structuredClone(await onFinalize(finalized));
				});
			}
		}
		managed.record = finalized;

		this.disposeManagedResources(managed);
		this.emitChange(managed);
		managed.resolveCompletion(structuredClone(managed.record));
	}

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
		bestEffort(() => this.onStateChange?.(structuredClone(managed.record)));
	}
}
