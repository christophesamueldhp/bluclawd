/**
 * The main session's background subagent runs, as `/tasks` and the footer see
 * them. Subagents and background-bash load in separate module graphs, so the
 * source crosses over through sharedRef; only the root session's subagents
 * instance publishes one (a nested child has no background runs).
 */

import { notifyListeners, sharedRef } from "./global-state.ts";

export interface AgentTaskInfo {
	id: string;
	owner?: string;
	agent: string;
	task: string;
	startedAt: number;
	endedAt?: number;
	status?: string;
	model?: string;
	outputFile?: string;
	output?: () => string;
}

export interface AgentTaskStopOptions {
	owner?: string;
	source?: "caller" | "user" | "model" | "remote" | "deadline" | "budget" | "session_invalidated";
}

export interface AgentTaskSource {
	list(owner?: string): AgentTaskInfo[];
	/** Stops an owned run through `/tasks` or `task_stop`; false for an unknown or unauthorized id. */
	stop(id: string, options?: AgentTaskStopOptions): boolean;
	/** Stops every running run the owner has; returns how many were stopped. */
	stopAll?(options?: AgentTaskStopOptions): number;
	getReport?(id: string, owner?: string): string | undefined;
	getRun?(id: string, owner?: string): unknown;
}

const state = sharedRef("agentTasks", {
	source: undefined as AgentTaskSource | undefined,
	listeners: new Set<() => void>(),
}).get();

export function publishAgentTasks(source: AgentTaskSource): () => void {
	state.source = source;
	notifyAgentTasksChanged();
	return () => {
		if (state.source === source) {
			state.source = undefined;
			notifyAgentTasksChanged();
		}
	};
}

export function agentTasks(): AgentTaskSource | undefined {
	return state.source;
}

export function notifyAgentTasksChanged(): void {
	notifyListeners(state.listeners);
}

export function subscribeAgentTasks(listener: () => void): () => void {
	state.listeners.add(listener);
	return () => state.listeners.delete(listener);
}
