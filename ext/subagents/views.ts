import type { RunDirectory, RunEntry } from "./directory.ts";
import { inParentScope, type ParentScope } from "./parent-scope.ts";
import { isTerminalSubagentStatus, type SubagentRunScheduler } from "./runs.ts";
import { readPersistedRunRecord } from "./storage.ts";

/** How long a Run that succeeded stays in the panel after it ends. */
const SUCCEEDED_RUN_LINGER_MS = 30_000;

/** Whether a stop can reach the Run: not once its last turn ended. */
export const canStop = (entry: RunEntry) => entry.state !== "finishing" && entry.state !== "finished";

export interface ParentScopeViewsDeps {
	scheduler: Pick<
		SubagentRunScheduler<{ runtime?: string; resume?: { toolCallId: string } }>,
		"listRuns" | "getContext"
	>;
	directory: Pick<RunDirectory, "get" | "list">;
	agentDir: () => string;
	/** The orchestrator's current Parent scope; none before the first session starts. */
	scope: () => ParentScope | undefined;
	/** Whether the orchestrator is between turns. */
	idle: () => boolean;
	now: () => number;
	/** Called whenever what the views answer changes without a scheduler change: a dismissal. */
	onChange: () => void;
}

export type ParentScopeViews = ReturnType<typeof createParentScopeViews>;

/** Every view of the current Parent scope's Runs, so the panel, `/tasks`, the footer and the reminder agree. */
export function createParentScopeViews(deps: ParentScopeViewsDeps) {
	/** The Generation of each final Run the user dismissed, by surface; a `/tasks` dismissal leaves the panel too. */
	const dismissed = { panel: new Map<string, number>(), tasks: new Map<string, number>() };
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
	/**
	 * Whether the panel still shows a Run: a closed one leaves at once, one that succeeded after a while, and any
	 * other final Run stays.
	 */
	const lingers = ({ record }: RunEntry, now: number) =>
		record.status !== "closed" &&
		(record.status !== "completed" || now - (record.endedAt ?? now) < SUCCEEDED_RUN_LINGER_MS);

	/** The Runs of the current scope the panel shows, in admission order: a dismissed Generation is not. */
	const panel = (): RunEntry[] => {
		const scope = deps.scope();
		if (!scope) return [];
		const now = deps.now();
		return deps.scheduler
			.listRuns()
			.filter(
				(run) =>
					inParentScope(run, scope) &&
					dismissed.panel.get(run.runId) !== run.generation &&
					dismissed.tasks.get(run.runId) !== run.generation,
			)
			.flatMap((run) => deps.directory.get(run.runId) ?? [])
			.filter((entry) => lingers(entry, now));
	};
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
					dismissed.tasks.get(run.runId) !== run.generation,
			)
			.flatMap((run) => deps.directory.get(run.runId) ?? []);
	};

	return {
		open,
		awaited,
		panel,
		done,
		/**
		 * Takes a final Run off the surface that shows it until a Resume starts its next Generation; false when that
		 * surface does not show it as final. Each dismissal sends the change signal.
		 */
		dismiss: (from: "panel" | "tasks", id: string, owner?: string): boolean => {
			const shown = from === "panel" ? panel() : done(owner);
			const run = shown.find(({ record }) => record.runId === id && isTerminalSubagentStatus(record.status));
			if (!run) return false;
			dismissed[from].set(id, run.record.generation);
			deps.onChange();
			return true;
		},
		/** The working Runs the orchestrator is Waiting for: none while its turn runs. */
		waitingFor: () => (deps.idle() ? awaited().length : 0),
		/** How many open Runs the footer counts as running, and as stopping. */
		footer: () => {
			const runs = open();
			const stopping = runs.filter((entry) => entry.state === "stopping").length;
			return { running: runs.length - stopping, stopping };
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
		/** The open Runs of the owner's scope that a stop, one or all, can reach. */
		stoppable: (owner?: string): RunEntry[] => open(owner).filter(canStop),
		/** An open Run by name or run ID. */
		findOpen: (target: string): RunEntry | undefined =>
			open().find(({ record }) => record.runId === target || record.name === target),
		/** The open Run a tool call launched; a resumed Generation runs under the message call that resumed it. */
		launchedBy: (toolCallId: string) =>
			open()
				.map((entry) => entry.record)
				.find(
					(run) =>
						(deps.scheduler.getContext(run.runId)?.resume?.toolCallId ?? run.originToolCallId) === toolCallId,
				),
	};
}
