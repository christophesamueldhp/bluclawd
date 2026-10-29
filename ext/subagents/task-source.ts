import type { AgentTask, AgentTaskSource, AgentTaskState } from "../_shared/agent-tasks.ts";
import type { SubagentLifecycleStatus, SubagentRunRecord, SubagentRunScheduler } from "./runs.ts";
import { readBoundedSubagentReport, readPersistedRunRecord, subagentReportPath } from "./storage.ts";

const TASK_OUTPUT_BYTES = 8192;

const TASK_STATES: Record<SubagentLifecycleStatus, AgentTaskState> = {
	starting: "running",
	running: "running",
	stopping: "running",
	completed: "completed",
	failed: "failed",
	interrupted: "failed",
	cancelled: "stopped",
};

export interface AgentTaskSourceDeps {
	scheduler: Pick<SubagentRunScheduler, "getRun" | "listActiveRuns" | "cancelRun">;
	agentDir: () => string;
	/** The owner when a caller names none. */
	activeParentSessionId: () => string | undefined;
}

/** Translates runs into the tasks `/tasks` and `task_stop` see. */
export function createAgentTaskSource(deps: AgentTaskSourceDeps): AgentTaskSource {
	const toTask = (run: Readonly<SubagentRunRecord>): AgentTask => {
		const agentDir = deps.agentDir();
		return {
			id: run.runId,
			owner: run.parentSessionId,
			agent: run.agentName,
			task: run.taskSummary || run.agentName,
			startedAt: run.startedAt ?? run.admittedAt,
			endedAt: run.endedAt,
			state: TASK_STATES[run.status],
			status: run.status,
			model: `${run.provider}/${run.modelId}`,
			outputFile: subagentReportPath(agentDir, run.parentSessionId, run.runId),
			output: () => {
				const bounded = readBoundedSubagentReport(agentDir, run.parentSessionId, run.runId, TASK_OUTPUT_BYTES);
				return bounded.ok && bounded.content ? bounded.content : (run.lastProgressText ?? "");
			},
		};
	};

	/** A live run first, then a persisted one; another owner's run is not found. */
	const findRun = (id: string, owner?: string): Readonly<SubagentRunRecord> | undefined => {
		const targetOwner = owner ?? deps.activeParentSessionId();
		const live = deps.scheduler.getRun(id);
		if (live) return targetOwner && live.parentSessionId !== targetOwner ? undefined : live;
		return targetOwner ? readPersistedRunRecord(deps.agentDir(), targetOwner, id) : undefined;
	};

	return {
		list: (owner) => deps.scheduler.listActiveRuns(owner ?? deps.activeParentSessionId()).map(toTask),
		get: (id, owner) => {
			const run = findRun(id, owner);
			return run && toTask(run);
		},
		stop: (id, options) => {
			const run = findRun(id, options?.owner);
			if (!run) return { ok: false, reason: "not_found" };
			if (!deps.scheduler.cancelRun(run.runId, options?.source ?? "user", `Stopped subagent ${run.runId}`)) {
				return { ok: false, reason: "not_running", task: toTask(run) };
			}
			return { ok: true, task: toTask(deps.scheduler.getRun(run.runId) ?? run) };
		},
		stopAll: (options) => {
			const owner = options?.owner ?? deps.activeParentSessionId();
			if (!owner) return 0;
			return deps.scheduler
				.listActiveRuns(owner)
				.filter((run) => deps.scheduler.cancelRun(run.runId, options?.source ?? "user", "Stopped all subagents"))
				.length;
		},
	};
}
