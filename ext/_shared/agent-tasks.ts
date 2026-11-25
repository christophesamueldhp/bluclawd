import { notifyListeners, sharedRef } from "./global-state.ts";

export const AGENT_TASK_ID_PREFIX = "sub_";

export function isAgentTaskId(id: string): boolean {
	return id.startsWith(AGENT_TASK_ID_PREFIX) && /^[A-Za-z0-9_-]+$/.test(id.slice(AGENT_TASK_ID_PREFIX.length));
}

export type AgentTaskState = "running" | "completed" | "failed" | "stopped";

export function isStillRunning(state: AgentTaskState): boolean {
	return state === "running";
}

export interface AgentTask {
	id: string;
	owner: string;
	agent: string;
	summary: string;
	startedAt: number;
	endedAt?: number;
	state: AgentTaskState;
	status: string;
	model: string;
	outputFile: string;
	output: () => string;
}

export interface AgentTaskCloseOptions {
	owner?: string;
	source?: "caller" | "user" | "model" | "remote" | "session_invalidated";
}

export type AgentTaskCloseResult =
	| { ok: true; task: AgentTask }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "not_running"; task: AgentTask };

export interface AgentTaskSource {
	list(owner?: string): AgentTask[];
	getOwned(id: string, owner?: string): AgentTask | undefined;
	closeOwned(id: string, options?: AgentTaskCloseOptions): AgentTaskCloseResult;
	closeAll(options?: AgentTaskCloseOptions): number;
	open?(id: string, owner?: string): Promise<void> | undefined;
	listDone?(owner?: string): AgentTask[];
	dismiss?(id: string, owner?: string): boolean;
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
