import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { endPane, type Tmux } from "../../daemon/tmux.ts";
import type { AdmissionContext, RunAdmission } from "./admission.ts";
import type { ParentScope, ParentScopeChecks } from "./parent-scope.ts";
import {
	formatRunLabel,
	isLegacyRun,
	isResumableSubagentStatus,
	isTerminalSubagentStatus,
	type SubagentRunRecord,
	type SubagentRunScheduler,
} from "./runs.ts";
import {
	extractReferencedRunIdsFromBranch,
	listPersistedRunRecords,
	readPersistedRunRecord,
	reconcileInterruptedRuns,
} from "./storage.ts";
import { paneUp } from "./tmux-runs.ts";

export interface TakeoverDeps {
	agentDir: () => string;
	/** This pi's tmux session, which takes over the session's Legacy runs; none outside tmux. */
	pane: string | undefined;
	scope: Pick<ParentScopeChecks, "current" | "onBranch">;
	admission: Pick<RunAdmission, "adopt" | "recover">;
	scheduler: Pick<SubagentRunScheduler, "getRun" | "cancelRun" | "listActiveRuns" | "reopen">;
	tmux: () => Pick<Tmux, "hasSession" | "end">;
	/** Gives the orchestrator the Reports its runs stored but could not send while it was gone. */
	pullReports: (scope: ParentScope) => void;
	/** Goes on with the session's Chains under way, their next steps admitted by this instance. */
	resumeChains: (parentSessionId: string) => void;
	/** Tells the orchestrator again of a run's Report that a call took, and that call is gone. */
	retellReport: (run: Readonly<SubagentRunRecord>) => void;
}

/** The orchestrator's session as it starts, as taking its runs over reads it. */
export type TakeoverContext = AdmissionContext & Pick<ExtensionContext, "hasUI" | "ui">;

/**
 * Takes over the runs an earlier instance of the session left open, after a reload or a crash, as each run's kind
 * allows (ADR-0008), and closes those it cannot: called once the session has started, its parent scope entered.
 */
export function takeOverRuns(deps: TakeoverDeps, ctx: TakeoverContext): void {
	const { scope, admission, scheduler, pane } = deps;
	const agentDir = deps.agentDir();
	const sessionId = ctx.sessionManager.getSessionId();
	const branchEntries = ctx.sessionManager.getBranch();
	// Its open runs in tmux, from before runs ran on pi's RPC, whose pis still run, after a reload or a crash of
	// the instance that ran them: this instance takes them over (ADR-0008), and follows each until it ends or is
	// stopped, never ending one itself. Those this process runs already are left as they are. A run is on the branch
	// as tree navigation judges it, by the entry it was launched from.
	if (pane) {
		for (const run of listPersistedRunRecords(agentDir, sessionId)) {
			if (
				run.pane &&
				!isTerminalSubagentStatus(run.status) &&
				scope.onBranch(run.originEntryId) &&
				paneUp(deps.tmux(), run.pane)
			)
				admission.adopt(run);
		}
	}
	// Its open runs on pi's RPC, whose hosts outlive any instance of the session (ADR-0008, ADR-0010): this one
	// takes each over as its run directory has it, after a reload or a crash. One whose host took it is followed
	// to its end; one that never started queues again, and starts only if this session may still start it. A
	// stop requested before stays requested, and a run off the branch is stopped, as tree navigation would.
	for (const run of listPersistedRunRecords(agentDir, sessionId)) {
		if (isLegacyRun(run) || isTerminalSubagentStatus(run.status) || scheduler.getRun(run.runId)) continue;
		if (!admission.recover(run, ctx)) continue;
		if (run.status === "stopping") {
			scheduler.cancelRun(run.runId, run.stopSource ?? "user", run.stopReason ?? "Subagent run cancelled");
		} else if (!scope.onBranch(run.originEntryId)) {
			scheduler.cancelRun(
				run.runId,
				"session_invalidated",
				"Originating branch is no longer active after tree navigation",
			);
		}
	}
	// Outside tmux, this pi has no pane to take its runs in tmux over to: those still running are left so, never
	// ended silently, until the session is opened in a pane again.
	const leftRunning = pane
		? []
		: listPersistedRunRecords(agentDir, sessionId).filter(
				(run) => run.pane && !isTerminalSubagentStatus(run.status) && paneUp(deps.tmux(), run.pane),
			);
	if (leftRunning.length > 0 && ctx.hasUI) {
		ctx.ui.notify(
			`subagents: ${leftRunning.map(formatRunLabel).join(", ")} still run in tmux, from before runs ran on pi's RPC, and this pi has no pane to take them over: they are left running. Open this session in agent view to stop them.`,
			"warning",
		);
	}
	// The session's runs an earlier instance left open and this one did not take over, on any branch.
	const liveIds = new Set([
		...scheduler.listActiveRuns(sessionId).map((r) => r.runId),
		...leftRunning.map((run) => run.runId),
	]);
	for (const run of reconcileInterruptedRuns(agentDir, sessionId, liveIds)) {
		if (run.status !== "closed" || !run.pane) continue;
		// Not taken over (its pi is gone, or this one has no pane to take it to): it is closed.
		endPane(deps.tmux(), run.pane);
	}
	// Reopening the session lists its closed runs, which can be resumed.
	const reopened = scope.current();
	if (reopened) {
		for (const runId of extractReferencedRunIdsFromBranch(branchEntries)) {
			const run = scheduler.getRun(runId) ?? readPersistedRunRecord(agentDir, sessionId, runId);
			if (run && isResumableSubagentStatus(run.status)) scheduler.reopen(run, reopened.sessionEpoch);
		}
		// Reports its runs stored but could not send while it was gone.
		deps.pullReports(reopened);
		// Its chains under way go on, their next steps admitted by this instance.
		deps.resumeChains(sessionId);
		// A batch with a member still open never settled: those of its members that ended, their Reports taken by its
		// waiter, are told of one by one, as the members still open will be.
		const unsettled = new Set(scheduler.listActiveRuns(sessionId).flatMap((run) => run.batch ?? []));
		for (const run of listPersistedRunRecords(agentDir, sessionId)) {
			if (run.batch && unsettled.has(run.batch) && isTerminalSubagentStatus(run.status)) {
				deps.retellReport({ ...run, sessionEpoch: reopened.sessionEpoch });
			}
		}
	}
}
