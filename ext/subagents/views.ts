import type { AgentActivity } from "../../daemon/activity.ts";
import type { RunDirectory, RunEntry } from "./directory.ts";
import { inParentScope, type ParentScope } from "./parent-scope.ts";
import { isLegacyRun, isTerminalSubagentStatus, type SubagentRunRecord, type SubagentRunScheduler } from "./runs.ts";
import { readPersistedRunRecord } from "./storage.ts";

const ACTIVITY_LABEL: Record<AgentActivity, string> = {
	working: "working",
	idle: "idle",
	awaiting_input: "needs input",
};

export function runStatus(run: Pick<SubagentRunRecord, "pane" | "status" | "activity" | "backend">): string {
	if (!isLegacyRun(run) && run.status === "starting") return "queued";
	if (!isLegacyRun(run) && run.status === "running" && run.activity === "awaiting_input") {
		return ACTIVITY_LABEL.awaiting_input;
	}
	return run.pane && run.status === "running" ? ACTIVITY_LABEL[run.activity ?? "working"] : run.status;
}

export const canClose = (entry: RunEntry) => entry.state !== "finished";

export interface ParentScopeViewsDeps {
	scheduler: Pick<SubagentRunScheduler, "listRuns">;
	directory: Pick<RunDirectory, "get" | "list">;
	agentDir: () => string;
	scope: () => ParentScope | undefined;
	idle: () => boolean;
	onChange: () => void;
}

export type ParentScopeViews = ReturnType<typeof createParentScopeViews>;

export function createParentScopeViews(deps: ParentScopeViewsDeps) {
	const dismissed = new Map<string, number>();
	const scopeOf = (owner?: string): ParentScope | undefined => {
		const active = deps.scope();
		return owner === undefined || owner === active?.parentSessionId ? active : undefined;
	};
	const open = (owner?: string): RunEntry[] => {
		const scope = scopeOf(owner);
		return scope ? deps.directory.list(scope) : [];
	};
	const awaited = () =>
		open().filter((entry) => entry.state !== "stopping" && (entry.record.activity ?? "working") === "working");
	const done = (owner?: string): RunEntry[] => {
		const scope = scopeOf(owner);
		if (!scope) return [];
		return deps.scheduler
			.listRuns()
			.filter(
				(run) =>
					inParentScope(run, scope) &&
					isTerminalSubagentStatus(run.status) &&
					dismissed.get(run.runId) !== run.generation,
			)
			.flatMap((run) => deps.directory.get(run.runId) ?? []);
	};

	return {
		open,
		awaited,
		done,
		dismiss: (id: string, owner?: string): boolean => {
			const run = done(owner).find(({ record }) => record.runId === id);
			if (!run) return false;
			dismissed.set(id, run.record.generation);
			deps.onChange();
			return true;
		},
		waitingFor: () => (deps.idle() ? awaited().length : 0),
		footer: () => {
			const runs = open();
			const closing = runs.filter((entry) => entry.state === "stopping").length;
			return { running: runs.length - closing, closing };
		},
		lookup: (id: string, owner?: string): RunEntry | undefined => {
			const targetOwner = owner ?? deps.scope()?.parentSessionId;
			const known = deps.directory.get(id);
			if (known) return targetOwner && known.record.parentSessionId !== targetOwner ? undefined : known;
			const stored = targetOwner ? readPersistedRunRecord(deps.agentDir(), targetOwner, id) : undefined;
			return stored && { record: stored, state: "finished" };
		},
		closable: (owner?: string): RunEntry[] => open(owner).filter(canClose),
		findOpen: (target: string): RunEntry | undefined =>
			open().find(({ record }) => record.runId === target || record.name === target),
	};
}
