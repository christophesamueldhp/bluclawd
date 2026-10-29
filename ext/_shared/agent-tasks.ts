/**
 * The main session's subagent runs, running or finished, as `/tasks`,
 * `task_stop` and the footer see them. Subagents and background-bash load in
 * separate module graphs, so the source crosses over through sharedRef; only
 * the root session's subagents instance publishes one (a nested child has no
 * background runs).
 */

import { notifyListeners, sharedRef } from "./global-state.ts";

/** The id format of an agent task: a run id. */
export const AGENT_TASK_ID_PREFIX = "sub_";

export function isAgentTaskId(id: string): boolean {
	return id.startsWith(AGENT_TASK_ID_PREFIX) && /^[A-Za-z0-9_-]+$/.test(id.slice(AGENT_TASK_ID_PREFIX.length));
}

/** Whether a task still runs; a run being stopped still runs. */
export type AgentTaskState = "running" | "completed" | "failed" | "stopped";

/** A run as `/tasks` and `task_stop` see it, live or finished. */
export interface AgentTask {
	id: string;
	owner: string;
	agent: string;
	/** What the run was asked to do, shortened; the agent's name when it has none. */
	summary: string;
	startedAt: number;
	endedAt?: number;
	state: AgentTaskState;
	/** The run's own status, for display. */
	status: string;
	model: string;
	outputFile: string;
	/** The bounded report, or the latest progress before there is one. */
	output: () => string;
}

export interface AgentTaskStopOptions {
	owner?: string;
	source?: "caller" | "user" | "model" | "remote" | "session_invalidated";
}

export type AgentTaskStopResult =
	| { ok: true; task: AgentTask }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "not_running"; task: AgentTask };

export interface AgentTaskSource {
	/** The owner's running tasks. */
	list(owner?: string): AgentTask[];
	/** A running or finished task; undefined for an unknown id or another owner's. */
	get(id: string, owner?: string): AgentTask | undefined;
	/** Stops an owned task through `/tasks` or `task_stop`; another owner's task is not found. */
	stop(id: string, options?: AgentTaskStopOptions): AgentTaskStopResult;
	/** Stops every running task the owner has; returns how many were stopped. */
	stopAll(options?: AgentTaskStopOptions): number;
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
