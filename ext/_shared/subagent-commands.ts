/**
 * Which subagent a tool call runs for. The subagents extension runs a child's proxied tool calls
 * inside `runForSubagent`, and the sandbox reads `currentSubagent` when a command starts, so it can
 * tell children's commands from the orchestrator's.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { sharedRef } from "./global-state.ts";

export interface SubagentCommandOwner {
	readonly name: string;
	/** Tells the orchestrator that a request to `target` from one of `suspects`' commands was denied. */
	reportNetworkDenied(target: string, suspects: readonly string[]): void;
}

// Shared, since the subagents and sandbox extensions each load their own copy of this module.
const storage = sharedRef("subagentCommands", new AsyncLocalStorage<SubagentCommandOwner>()).get();

export function runForSubagent<T>(owner: SubagentCommandOwner, task: () => T): T {
	return storage.run(owner, task);
}

export function currentSubagent(): SubagentCommandOwner | undefined {
	return storage.getStore();
}
