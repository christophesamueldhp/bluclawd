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
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted"
	/** Its pi was ended and its session kept: it can be resumed (a run in tmux). */
	| "closed";

export type SubagentTerminalStatus = "completed" | "failed" | "cancelled" | "interrupted" | "closed";

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
	/** How many times the orchestrator resumed this run after it completed: 0 for the launch. */
	generation: number;
	/** The tmux session of the run's pi (ADR-0006); absent on runs from before runs were pis of their own. */
	pane?: string;
	/** What the run's pi is doing, as it last said; absent until it says. */
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
	/** The usage of the run's session so far, as its latest Report gave it. */
	usage: SessionUsage;
	backgroundDeliveryAttempted: boolean;
	/** The `seq` of the run's latest Report the orchestrator was told of; absent until one numbered was. */
	lastDeliveredSeq?: number;
	lastProgressText?: string;
	summaryText?: string;
}

export interface SubagentRunController {
	markRunning(): void;
	/** The run's pi started in this tmux session. */
	recordPane(pane: string): void;
	/** What the run's pi says it is doing now. */
	updateActivity(activity: AgentActivity): void;
	/** The usage of the run's session so far. */
	updateUsage(totals: SessionUsage): void;
	updateProgress(text: string): void;
	/** The orchestrator was told of the run's Report `seq`: stored with the run's next change. */
	markDelivered(seq: number): void;
}

export interface SubagentRunExecuteParams {
	readonly record: Readonly<SubagentRunRecord>;
	readonly signal: AbortSignal;
	readonly controller: SubagentRunController;
}

export interface SubagentRunOutcome {
	status: SubagentTerminalStatus;
	complete: boolean;
	summaryText: string;
	stopReason?: string;
	errorMessage?: string;
	transcriptPath?: string;
	reportPath?: string;
	endSnapshot?: WorkspaceSnapshot;
}

export interface AdmitSubagentRunRequest<C = unknown> {
	/** Minted by the caller when it prepares the run's storage first. */
	runId?: string;
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

export type AdmitSubagentRunResult =
	| { readonly ok: true; readonly handle: AdmittedSubagentHandle }
	| { readonly ok: false; readonly error: string };

export interface SubagentRunSchedulerOptions<C = unknown> {
	now?: () => number;
	onStateChange?: (record: Readonly<SubagentRunRecord>) => void;
	/** Durably stores a settled run before it turns terminal; a throw fails the run. */
	onFinalize?: (record: Readonly<SubagentRunRecord>) => Promise<Readonly<SubagentRunRecord>>;
	executeRun: (params: SubagentRunExecuteParams & { context?: C }) => Promise<SubagentRunOutcome>;
	/** What a stopped run ends as; `cancelled` when omitted. */
	stoppedAs?: SubagentTerminalStatus;
}

export function createRunId(): string {
	return `${AGENT_TASK_ID_PREFIX}${randomUUID()}`;
}

const TERMINAL_STATES = new Set<SubagentLifecycleStatus>(["completed", "failed", "cancelled", "interrupted", "closed"]);

/** Whether a final run can take a next generation. */
export function isResumableSubagentStatus(status: SubagentLifecycleStatus): boolean {
	return status === "completed" || status === "closed";
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
	private readonly stoppedAs: SubagentTerminalStatus;

	private readonly runs = new Map<string, InternalManagedRun<C>>();

	constructor(options: SubagentRunSchedulerOptions<C>) {
		this.now = options.now ?? (() => Date.now());
		this.onStateChange = options.onStateChange;
		this.onFinalize = options.onFinalize;
		this.executeRun = options.executeRun;
		this.stoppedAs = options.stoppedAs ?? "cancelled";
	}

	getRun(runId: string): Readonly<SubagentRunRecord> | undefined {
		const managed = this.runs.get(runId);
		return managed ? structuredClone(managed.record) : undefined;
	}

	/** The context a run was admitted or last resumed with. */
	getContext(runId: string): C | undefined {
		return this.runs.get(runId)?.context;
	}

	/** Settles with the run's record once its current generation is final and stored. */
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
			snapshotDrifted: false,
			admittedAt,
			deliveryMode: request.deliveryMode,
			status: "starting",
			complete: false,
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

	/**
	 * Runs a completed or closed run again under the same identity, in the background. A run this scheduler does not
	 * know is taken over from `stored`, its record as kept on disk.
	 */
	resume(runId: string, context: C, stored?: Readonly<SubagentRunRecord>): AdmitSubagentRunResult {
		if (!this.runs.has(runId) && stored?.runId === runId && isResumableSubagentStatus(stored.status)) {
			this.adopt(stored);
		}
		const managed = this.runs.get(runId);
		if (!managed) return { ok: false, error: "Subagent run is unknown." };
		if (!isResumableSubagentStatus(managed.record.status)) {
			return {
				ok: false,
				error: `Subagent run is ${managed.record.status}; only a completed or closed run can be resumed.`,
			};
		}
		let resolveCompletion!: (rec: Readonly<SubagentRunRecord>) => void;
		const completionPromise = new Promise<Readonly<SubagentRunRecord>>((res) => {
			resolveCompletion = res;
		});
		Object.assign(managed, {
			record: {
				...managed.record,
				startedAt: undefined,
				endedAt: undefined,
				endSnapshot: undefined,
				stopReason: undefined,
				stopSource: undefined,
				errorMessage: undefined,
				summaryText: undefined,
				// Unset, so the earlier generation's final report stays on disk until this one reports progress.
				lastProgressText: undefined,
				generation: managed.record.generation + 1,
				status: "starting",
				complete: false,
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

	/**
	 * Takes over an open run, its pi still running, that an earlier instance of the orchestrator's session started
	 * (a reload, or a crash), as it is stored. No foreground call waits for it any more: its Reports come as notices.
	 */
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

	/**
	 * A final run of the session the orchestrator reopens joins the session's new epoch, so it is listed and can be
	 * resumed; one this scheduler does not know is taken over as it is stored.
	 */
	reopen(run: Readonly<SubagentRunRecord>, sessionEpoch: number): void {
		const managed = this.runs.get(run.runId);
		if (managed && !isTerminalSubagentStatus(managed.record.status)) return;
		if (managed) managed.record.sessionEpoch = sessionEpoch;
		else this.adopt({ ...run, sessionEpoch });
	}

	/** Takes over a final run another instance ran, as it is stored, so it can be resumed. */
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

	/** The orchestrator was told of the run's Report `seq`, of a final run too: stored with its next change. */
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

	/** Cancels every live run `where` selects, as invalidated by the parent session. */
	cancelRuns(where: (record: Readonly<SubagentRunRecord>) => boolean, reason: string): void {
		for (const managed of this.runs.values()) {
			if (!isTerminalSubagentStatus(managed.record.status) && where(managed.record)) {
				this.triggerStop(managed, "session_invalidated", reason);
			}
		}
	}

	private startManagedRun(managed: InternalManagedRun<C>): void {
		// A run taken over keeps when it started.
		managed.record.startedAt ??= this.now();
		this.emitChange(managed);

		// A resume reuses `managed`, so a controller from an earlier generation must not touch the new one.
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
			managed.pendingTerminalStatus = this.stoppedAs;
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

		const finalStatus: SubagentTerminalStatus = managed.pendingTerminalStatus ?? outcome.status;
		managed.record.endedAt = this.now();
		managed.record.complete = finalStatus === "completed" ? outcome.complete : false;
		managed.record.summaryText = outcome.summaryText;
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
