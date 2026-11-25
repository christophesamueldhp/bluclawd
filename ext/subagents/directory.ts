import { isAgentTaskId } from "../_shared/agent-tasks.ts";
import { inParentScope, type ParentScope } from "./parent-scope.ts";
import { isTerminalSubagentStatus, type SubagentRunRecord, type SubagentRunScheduler } from "./runs.ts";
import { listPersistedRunRecords, readPersistedRunRecord } from "./storage.ts";

export type RunState = "starting" | "live" | "stopping" | "finished";

export interface RunEntry {
	readonly record: Readonly<SubagentRunRecord>;
	readonly state: RunState;
	readonly unreachable?: string;
}

const UNREACHABLE: Partial<Record<RunState, string>> = {
	stopping: "is stopping",
	finished: "has finished",
};

export interface RunDirectoryDeps {
	scheduler: Pick<SubagentRunScheduler, "getRun" | "listRuns">;
	agentDir: () => string;
}

export type RunDirectory = ReturnType<typeof createRunDirectory>;

export function createRunDirectory(deps: RunDirectoryDeps) {
	const stateOf = (record: Readonly<SubagentRunRecord>): RunState => {
		if (isTerminalSubagentStatus(record.status)) return "finished";
		if (record.status === "stopping") return record.status;
		return record.status === "starting" ? "starting" : "live";
	};
	const entryOf = (record: Readonly<SubagentRunRecord>): RunEntry => {
		const state = stateOf(record);
		return { record, state, unreachable: record.status === "cancelled" ? "was stopped" : UNREACHABLE[state] };
	};
	const named = (target: string) => (record: Readonly<SubagentRunRecord>) =>
		record.runId === target || record.name === target;
	const latestEnded = (records: readonly Readonly<SubagentRunRecord>[]) =>
		[...records].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];

	const list = (scope: ParentScope): RunEntry[] =>
		deps.scheduler
			.listRuns()
			.filter((record) => inParentScope(record, scope) && !isTerminalSubagentStatus(record.status))
			.map(entryOf);

	return {
		get(runId: string): RunEntry | undefined {
			const record = deps.scheduler.getRun(runId);
			return record && entryOf(record);
		},

		list,

		reachable: (scope: ParentScope): RunEntry[] => list(scope).filter((entry) => !entry.unreachable),

		nameHolder: (scope: ParentScope, name: string): RunEntry | undefined =>
			list(scope).find((entry) => entry.record.name === name),

		find(scope: ParentScope, target: string): RunEntry | undefined {
			const open = list(scope).find((entry) => named(target)(entry.record));
			if (open) return open;
			const finished = latestEnded(
				deps.scheduler
					.listRuns()
					.filter(
						(record) =>
							record.parentSessionId === scope.parentSessionId &&
							isTerminalSubagentStatus(record.status) &&
							named(target)(record),
					),
			);
			if (finished) return entryOf(finished);
			const stored = isAgentTaskId(target)
				? readPersistedRunRecord(deps.agentDir(), scope.parentSessionId, target)
				: latestEnded(
						listPersistedRunRecords(deps.agentDir(), scope.parentSessionId).filter(
							(record) => record.name === target && !deps.scheduler.getRun(record.runId),
						),
					);
			return stored && { record: stored, state: "finished", unreachable: UNREACHABLE.finished };
		},
	};
}
