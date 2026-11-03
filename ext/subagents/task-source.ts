import type { AgentTask, AgentTaskSource, AgentTaskState } from "../_shared/agent-tasks.ts";
import type { RunDirectory, RunEntry } from "./directory.ts";
import type { ParentScope } from "./parent-scope.ts";
import { isTerminalSubagentStatus, type SubagentLifecycleStatus, type SubagentRunScheduler } from "./runs.ts";
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
	directory: Pick<RunDirectory, "get" | "list">;
	scheduler: Pick<SubagentRunScheduler, "cancelRun">;
	agentDir: () => string;
	/** The owner when a caller names none. */
	activeScope: () => ParentScope | undefined;
}

/** Translates runs into the tasks `/tasks` and `task_stop` see. */
export function createAgentTaskSource(deps: AgentTaskSourceDeps): AgentTaskSource {
	const toTask = ({ record: run, state }: RunEntry): AgentTask => {
		const agentDir = deps.agentDir();
		return {
			id: run.runId,
			owner: run.parentSessionId,
			agent: run.agentName,
			summary: run.taskSummary || run.agentName,
			startedAt: run.startedAt ?? run.admittedAt,
			endedAt: run.endedAt,
			state: TASK_STATES[run.status],
			status: state === "finishing" ? state : run.status,
			model: `${run.provider}/${run.modelId}`,
			outputFile: subagentReportPath(agentDir, run.parentSessionId, run.runId),
			output: () => {
				const bounded = readBoundedSubagentReport(agentDir, run.parentSessionId, run.runId, TASK_OUTPUT_BYTES);
				return bounded.ok && bounded.content ? bounded.content : (run.lastProgressText ?? "");
			},
		};
	};

	/** The owner's current scope; only the orchestrator's own session has one. */
	const scopeOf = (owner?: string): ParentScope | undefined => {
		const active = deps.activeScope();
		return owner === undefined || owner === active?.parentSessionId ? active : undefined;
	};

	/** A run this instance knows first, then a persisted one; another owner's run is not found. */
	const findRun = (id: string, owner?: string): RunEntry | undefined => {
		const targetOwner = owner ?? deps.activeScope()?.parentSessionId;
		const known = deps.directory.get(id);
		if (known) return targetOwner && known.record.parentSessionId !== targetOwner ? undefined : known;
		const stored = targetOwner ? readPersistedRunRecord(deps.agentDir(), targetOwner, id) : undefined;
		return stored && { record: stored, state: "finished" };
	};

	const stoppable = (entry: RunEntry) => entry.state !== "finishing" && entry.state !== "finished";

	return {
		list: (owner) => {
			const scope = scopeOf(owner);
			return scope ? deps.directory.list(scope).map(toTask) : [];
		},
		get: (id, owner) => {
			const run = findRun(id, owner);
			return run && toTask(run);
		},
		stop: (id, options) => {
			const run = findRun(id, options?.owner);
			if (!run) return { ok: false, reason: "not_found" };
			const { runId } = run.record;
			if (
				stoppable(run) &&
				deps.scheduler.cancelRun(runId, options?.source ?? "user", `Stopped subagent ${runId}`)
			) {
				return { ok: true, task: toTask(deps.directory.get(runId) ?? run) };
			}
			// A persisted run that never ended was orphaned by a crash: there is nothing to stop.
			const orphaned = !deps.directory.get(runId) && !isTerminalSubagentStatus(run.record.status);
			return orphaned ? { ok: false, reason: "not_found" } : { ok: false, reason: "not_running", task: toTask(run) };
		},
		stopAll: (options) => {
			const scope = scopeOf(options?.owner);
			if (!scope) return 0;
			return deps.directory
				.list(scope)
				.filter(
					(run) =>
						stoppable(run) &&
						deps.scheduler.cancelRun(run.record.runId, options?.source ?? "user", "Stopped all subagents"),
				).length;
		},
	};
}
