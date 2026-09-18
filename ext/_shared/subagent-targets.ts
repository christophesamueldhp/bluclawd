/**
 * Which agents a `task` call will really run, beyond the names in its own input.
 *
 * The permission layer decides `Task(agent)` rules from the call's input, but some
 * inputs name no agent, or the wrong one: a `resume` id runs whatever def that child
 * was started with, whatever `agent` is sent beside it. The subagents extension knows
 * those mappings and publishes a resolver here; `taskAgents` in permissions/rules.ts
 * adds what it returns. Global via {@link sharedRef}: permissions and subagents are
 * separate top-level extensions with separate module graphs.
 */

import { sharedRef } from "./global-state.ts";

export type TaskTargetResolver = (input: Record<string, unknown>) => string[];

const resolvers = sharedRef<Set<TaskTargetResolver>>("subagents.taskTargets", new Set());

/** Register a resolver; the returned function removes it. */
export function publishTaskTargets(resolver: TaskTargetResolver): () => void {
	resolvers.get().add(resolver);
	return () => {
		resolvers.get().delete(resolver);
	};
}

export function resolveTaskTargets(input: Record<string, unknown>): string[] {
	const names: string[] = [];
	for (const resolve of resolvers.get()) {
		try {
			names.push(...resolve(input));
		} catch {
			// A broken resolver adds nothing; the call's own names still apply.
		}
	}
	return names;
}
