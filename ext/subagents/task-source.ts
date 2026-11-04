import type { AgentTask, AgentTaskSource, AgentTaskState } from "../_shared/agent-tasks.ts";
import type { RunDirectory, RunEntry } from "./directory.ts";
import { isTerminalSubagentStatus, type SubagentLifecycleStatus, type SubagentRunScheduler } from "./runs.ts";
import { readBoundedSubagentReport, subagentReportPath } from "./storage.ts";
import { canStop, type ParentScopeViews } from "./views.ts";

const TASK_OUTPUT_BYTES = 8192;

const TASK_STATES: Record<SubagentLifecycleStatus, AgentTaskState> = {
	starting: "running",
	running: "running",
	finishing: "running",
	stopping: "running",
	completed: "completed",
	failed: "failed",
	interrupted: "failed",
	cancelled: "stopped",
};

export interface AgentTaskSourceDeps {
	views: Pick<ParentScopeViews, "open" | "done" | "lookup" | "stoppable" | "dismiss">;
	directory: Pick<RunDirectory, "get">;
	scheduler: Pick<SubagentRunScheduler, "cancelRun">;
	agentDir: () => string;
}

/** Translates runs into the tasks `/tasks` and `task_stop` see. */
export function createAgentTaskSource(deps: AgentTaskSourceDeps): AgentTaskSource {
	const toTask = ({ record: run }: RunEntry): AgentTask => {
		const agentDir = deps.agentDir();
		return {
			id: run.runId,
			owner: run.parentSessionId,
			agent: run.agentName,
			summary: run.taskSummary || run.agentName,
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

	const { views } = deps;
	return {
		list: (owner) => views.open(owner).map(toTask),
		get: (id, owner) => {
			const run = views.lookup(id, owner);
			return run && toTask(run);
		},
		stop: (id, options) => {
			const run = views.lookup(id, options?.owner);
			if (!run) return { ok: false, reason: "not_found" };
			const { runId } = run.record;
			if (canStop(run) && deps.scheduler.cancelRun(runId, options?.source ?? "user", `Stopped subagent ${runId}`)) {
				return { ok: true, task: toTask(deps.directory.get(runId) ?? run) };
			}
			// A persisted run that never ended was orphaned by a crash: there is nothing to stop.
			const orphaned = !deps.directory.get(runId) && !isTerminalSubagentStatus(run.record.status);
			return orphaned ? { ok: false, reason: "not_found" } : { ok: false, reason: "not_running", task: toTask(run) };
		},
		stopAll: (options) =>
			views
				.stoppable(options?.owner)
				.filter((run) =>
					deps.scheduler.cancelRun(run.record.runId, options?.source ?? "user", "Stopped all subagents"),
				).length,
		listDone: (owner) => views.done(owner).map(toTask),
		dismiss: (id, owner) => views.dismiss("tasks", id, owner),
	};
}
