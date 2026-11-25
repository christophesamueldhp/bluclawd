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
	pane: string | undefined;
	scope: Pick<ParentScopeChecks, "current" | "onBranch">;
	admission: Pick<RunAdmission, "adopt" | "recover">;
	scheduler: Pick<SubagentRunScheduler, "getRun" | "cancelRun" | "listActiveRuns" | "reopen">;
	tmux: () => Pick<Tmux, "hasSession" | "hangUpAsQuit">;
	pullReports: (scope: ParentScope) => void;
	resumeChains: (parentSessionId: string) => void;
	retellReport: (run: Readonly<SubagentRunRecord>) => void;
}

export type TakeoverContext = AdmissionContext & Pick<ExtensionContext, "hasUI" | "ui">;

export function takeOverRuns(deps: TakeoverDeps, ctx: TakeoverContext): void {
	const agentDir = deps.agentDir();
	const sessionId = ctx.sessionManager.getSessionId();
	const branchEntries = ctx.sessionManager.getBranch();
	if (deps.pane) adoptLegacyPaneRuns(deps, agentDir, sessionId);
	recoverRpcRuns(deps, ctx, agentDir, sessionId);
	const leftRunning = deps.pane ? [] : legacyRunsLeftRunning(deps, agentDir, sessionId);
	if (leftRunning.length > 0 && ctx.hasUI) {
		ctx.ui.notify(
			`subagents: ${leftRunning.map(formatRunLabel).join(", ")} still run in tmux, from before runs ran on pi's RPC, and this pi has no pane to take them over: they are left running. Open this session in agent view to stop them.`,
			"warning",
		);
	}
	closeUntakenRuns(deps, agentDir, sessionId, leftRunning);
	const reopened = deps.scope.current();
	if (reopened) {
		reopenResumable(deps, agentDir, sessionId, branchEntries, reopened);
		deps.pullReports(reopened);
		deps.resumeChains(sessionId);
		retellUnsettledBatchMembers(deps, agentDir, sessionId, reopened);
	}
}

function adoptLegacyPaneRuns(deps: TakeoverDeps, agentDir: string, sessionId: string): void {
	for (const run of listPersistedRunRecords(agentDir, sessionId)) {
		if (
			run.pane &&
			!isTerminalSubagentStatus(run.status) &&
			deps.scope.onBranch(run.originEntryId) &&
			paneUp(deps.tmux(), run.pane)
		)
			deps.admission.adopt(run);
	}
}

function recoverRpcRuns(deps: TakeoverDeps, ctx: TakeoverContext, agentDir: string, sessionId: string): void {
	const { scheduler } = deps;
	for (const run of listPersistedRunRecords(agentDir, sessionId)) {
		if (isLegacyRun(run) || isTerminalSubagentStatus(run.status) || scheduler.getRun(run.runId)) continue;
		if (!deps.admission.recover(run, ctx)) continue;
		if (run.status === "stopping") {
			scheduler.cancelRun(run.runId, run.stopSource ?? "user", run.stopReason ?? "Subagent run cancelled");
		} else if (!deps.scope.onBranch(run.originEntryId)) {
			scheduler.cancelRun(
				run.runId,
				"session_invalidated",
				"Originating branch is no longer active after tree navigation",
			);
		}
	}
}

const legacyRunsLeftRunning = (deps: TakeoverDeps, agentDir: string, sessionId: string) =>
	listPersistedRunRecords(agentDir, sessionId).filter(
		(run) => run.pane && !isTerminalSubagentStatus(run.status) && paneUp(deps.tmux(), run.pane),
	);

function closeUntakenRuns(
	deps: TakeoverDeps,
	agentDir: string,
	sessionId: string,
	leftRunning: readonly SubagentRunRecord[],
): void {
	const liveIds = new Set([
		...deps.scheduler.listActiveRuns(sessionId).map((r) => r.runId),
		...leftRunning.map((run) => run.runId),
	]);
	for (const run of reconcileInterruptedRuns(agentDir, sessionId, liveIds)) {
		if (run.status !== "closed" || !run.pane) continue;
		endPane(deps.tmux(), run.pane);
	}
}

function reopenResumable(
	deps: TakeoverDeps,
	agentDir: string,
	sessionId: string,
	branchEntries: ReturnType<TakeoverContext["sessionManager"]["getBranch"]>,
	reopened: ParentScope,
): void {
	for (const runId of extractReferencedRunIdsFromBranch(branchEntries)) {
		const run = deps.scheduler.getRun(runId) ?? readPersistedRunRecord(agentDir, sessionId, runId);
		if (run && isResumableSubagentStatus(run.status)) deps.scheduler.reopen(run, reopened.sessionEpoch);
	}
}

function retellUnsettledBatchMembers(
	deps: TakeoverDeps,
	agentDir: string,
	sessionId: string,
	reopened: ParentScope,
): void {
	const unsettled = new Set(deps.scheduler.listActiveRuns(sessionId).flatMap((run) => run.batch ?? []));
	for (const run of listPersistedRunRecords(agentDir, sessionId)) {
		if (run.batch && unsettled.has(run.batch) && isTerminalSubagentStatus(run.status)) {
			deps.retellReport({ ...run, sessionEpoch: reopened.sessionEpoch });
		}
	}
}
