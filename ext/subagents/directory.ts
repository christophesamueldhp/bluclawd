import { isAgentTaskId } from "../_shared/agent-tasks.ts";
import { inParentScope, type ParentScope } from "./parent-scope.ts";
import { isTerminalSubagentStatus, type SubagentRunRecord, type SubagentRunScheduler } from "./runs.ts";
import { listPersistedRunRecords, readPersistedRunRecord } from "./storage.ts";

/**
 * Where a run is in its life. A starting run's session is still being created; messages to it wait for it (#99).
 * A finishing run has ended its last turn but is not final yet.
 */
export type RunState = "starting" | "live" | "finishing" | "stopping" | "finished";

export interface RunEntry {
	readonly record: Readonly<SubagentRunRecord>;
	readonly state: RunState;
	/** Why a message cannot reach the run now; absent when it can. */
	readonly unreachable?: string;
}

const UNREACHABLE: Partial<Record<RunState, string>> = {
	finishing: "has finished",
	stopping: "is stopping",
	finished: "has finished",
};

export interface RunDirectoryDeps {
	scheduler: Pick<SubagentRunScheduler, "getRun" | "listRuns">;
	agentDir: () => string;
}

export type RunDirectory = ReturnType<typeof createRunDirectory>;

/** The one answer to which runs exist in a parent scope, whether each can be messaged, and which names are taken. */
export function createRunDirectory(deps: RunDirectoryDeps) {
	/** The generation whose last turn ended, per run. */
	const endedTurns = new Map<string, number>();

	const stateOf = (record: Readonly<SubagentRunRecord>): RunState => {
		if (isTerminalSubagentStatus(record.status)) return "finished";
		if (record.status === "stopping") return "stopping";
		if (endedTurns.get(record.runId) === (record.generation ?? 0)) return "finishing";
		return record.status === "starting" ? "starting" : "live";
	};
	const entryOf = (record: Readonly<SubagentRunRecord>): RunEntry => {
		const state = stateOf(record);
		return { record, state, unreachable: UNREACHABLE[state] };
	};
	const named = (target: string) => (record: Readonly<SubagentRunRecord>) =>
		record.runId === target || record.name === target;
	const latestEnded = (records: readonly Readonly<SubagentRunRecord>[]) =>
		[...records].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];

	/** Runs of the scope that are not final yet, in admission order. */
	const list = (scope: ParentScope): RunEntry[] =>
		deps.scheduler
			.listRuns()
			.filter((record) => inParentScope(record, scope) && !isTerminalSubagentStatus(record.status))
			.map(entryOf);

	return {
		/** The child's last turn of its current generation ended. */
		endTurn(runId: string): void {
			const record = deps.scheduler.getRun(runId);
			if (record) endedTurns.set(runId, record.generation ?? 0);
		},

		/** A run this instance knows, in any scope. */
		get(runId: string): RunEntry | undefined {
			const record = deps.scheduler.getRun(runId);
			return record && entryOf(record);
		},

		list,

		/** The runs of the scope a message can reach now. */
		reachable: (scope: ParentScope): RunEntry[] => list(scope).filter((entry) => !entry.unreachable),

		/** The run of the scope that holds a name until it is final. */
		nameHolder: (scope: ParentScope, name: string): RunEntry | undefined =>
			list(scope).find((entry) => entry.record.name === name),

		/**
		 * A run by name or run ID: one of the scope not yet final, else the latest that finished in this
		 * instance for the scope's session, else one stored by an earlier instance.
		 */
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
			// A reload replaces this extension, so a run from before it is only on disk, and unknown to this instance.
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
