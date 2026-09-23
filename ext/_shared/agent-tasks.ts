/**
 * The main session's background subagent runs, as `/tasks` and the footer see
 * them. Subagents and background-bash load in separate module graphs, so the
 * source crosses over through sharedRef; only the root session's subagents
 * instance publishes one (a nested child has no background runs).
 */

import { sharedRef } from "./global-state.ts";

export interface AgentTaskInfo {
	id: string;
	agent: string;
	task: string;
	startedAt: number;
}

export interface AgentTaskSource {
	list(): AgentTaskInfo[];
	/** Stops a run as `/agents stop` does; false for an unknown id. */
	stop(id: string): boolean;
}

const state = sharedRef("agentTasks", {
	source: undefined as AgentTaskSource | undefined,
	listeners: new Set<() => void>(),
}).get();

export function publishAgentTasks(source: AgentTaskSource): () => void {
	state.source = source;
	agentTasksChanged();
	return () => {
		if (state.source === source) state.source = undefined;
		agentTasksChanged();
	};
}

export function agentTasks(): AgentTaskSource | undefined {
	return state.source;
}

export function agentTasksChanged(): void {
	for (const listener of state.listeners) {
		try {
			listener();
		} catch {}
	}
}

export function subscribeAgentTasks(listener: () => void): () => void {
	state.listeners.add(listener);
	return () => state.listeners.delete(listener);
}
