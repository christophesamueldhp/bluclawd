import type { AgentActivity } from "../../daemon/activity.ts";
import type { RunDirectory, RunEntry } from "./directory.ts";
import { inParentScope, type ParentScope } from "./parent-scope.ts";
import { isTerminalSubagentStatus, type SubagentRunRecord, type SubagentRunScheduler } from "./runs.ts";
import { readPersistedRunRecord } from "./storage.ts";

const ACTIVITY_LABEL: Record<AgentActivity, string> = {
	working: "working",
	idle: "idle",
	awaiting_input: "needs input",
};

/** What a Run is doing, for display: an open one in a pi of its own says whether it works, idles or needs input. */
export function runStatus(run: Pick<SubagentRunRecord, "pane" | "status" | "activity">): string {
	return run.pane && run.status === "running" ? ACTIVITY_LABEL[run.activity ?? "working"] : run.status;
}

/** Whether a close can reach the Run: not once it is final. */
export const canClose = (entry: RunEntry) => entry.state !== "finished";

export interface ParentScopeViewsDeps {
	scheduler: Pick<SubagentRunScheduler, "listRuns">;
	directory: Pick<RunDirectory, "get" | "list">;
	agentDir: () => string;
	/** The orchestrator's current Parent scope; none before the first session starts. */
	scope: () => ParentScope | undefined;
	/** Whether the orchestrator is between turns. */
	idle: () => boolean;
	/** Called whenever what the views answer changes without a scheduler change: a dismissal. */
	onChange: () => void;
}

export type ParentScopeViews = ReturnType<typeof createParentScopeViews>;

/** Every view of the current Parent scope's Runs, so the panel, `/tasks`, the footer and the reminder agree. */
export function createParentScopeViews(deps: ParentScopeViewsDeps) {
	/** The Generation of each final Run the user dismissed from `/tasks`. */
	const dismissed = new Map<string, number>();
	/** The owner's current scope: only the orchestrator's own session, the owner when a caller names none, has one. */
	const scopeOf = (owner?: string): ParentScope | undefined => {
		const active = deps.scope();
		return owner === undefined || owner === active?.parentSessionId ? active : undefined;
	};
	/** The Runs of the owner's current scope that are not final yet, in admission order. */
	const open = (owner?: string): RunEntry[] => {
		const scope = scopeOf(owner);
		return scope ? deps.directory.list(scope) : [];
	};
	/**
	 * The open Runs whose work the orchestrator still waits on: those working. A Run being stopped is not, nor one
	 * idle or waiting on a prompt in its own session. A Run that has not said yet has only just started.
	 */
	const awaited = () =>
		open().filter((entry) => entry.state !== "stopping" && (entry.record.activity ?? "working") === "working");
	/** The scope's final Runs this instance ran, as Done in `/tasks`: none of an earlier epoch or known only from disk. */
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
		/** The Runs the panel shows, beside those that failed lately. */
		open,
		awaited,
		done,
		/**
		 * Takes a final Run off Done in `/tasks` until a Resume starts its next Generation; false when Done does not
		 * list it. Each dismissal sends the change signal.
		 */
		dismiss: (id: string, owner?: string): boolean => {
			const run = done(owner).find(({ record }) => record.runId === id);
			if (!run) return false;
			dismissed.set(id, run.record.generation);
			deps.onChange();
			return true;
		},
		/** The working Runs the orchestrator is Waiting for: none while its turn runs. */
		waitingFor: () => (deps.idle() ? awaited().length : 0),
		/** How many open Runs the footer counts as running, and as closing. */
		footer: () => {
			const runs = open();
			const closing = runs.filter((entry) => entry.state === "stopping").length;
			return { running: runs.length - closing, closing };
		},
		/**
		 * The owner's Run this instance knows, else one an earlier instance stored for the owner. Only the owner is
		 * checked, not the epoch, so an earlier epoch's Run is found before a restart as it is after one.
		 */
		lookup: (id: string, owner?: string): RunEntry | undefined => {
			const targetOwner = owner ?? deps.scope()?.parentSessionId;
			const known = deps.directory.get(id);
			if (known) return targetOwner && known.record.parentSessionId !== targetOwner ? undefined : known;
			const stored = targetOwner ? readPersistedRunRecord(deps.agentDir(), targetOwner, id) : undefined;
			return stored && { record: stored, state: "finished" };
		},
		/** The open Runs of the owner's scope that a close, one or all, can reach. */
		closable: (owner?: string): RunEntry[] => open(owner).filter(canClose),
		/** An open Run by name or run ID. */
		findOpen: (target: string): RunEntry | undefined =>
			open().find(({ record }) => record.runId === target || record.name === target),
	};
}
