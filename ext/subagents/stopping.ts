import { formatRunLabel, isLegacyRun, type SubagentRunRecord, type SubagentRunScheduler } from "./runs.ts";
import { type CallResult, type CallsUnderWay, whileCalled } from "./settling.ts";
import { legacyRunRefusal } from "./tmux-runs.ts";
import type { ParentScopeViews } from "./views.ts";

export interface StopDeps {
	scheduler: Pick<SubagentRunScheduler, "cancelRun" | "whenFinal">;
	/** The open runs of the current parent scope. */
	runs: Pick<ParentScopeViews, "open" | "findOpen">;
	/** The Chains under way: a stop of one starts none of its later steps. */
	calls: Pick<CallsUnderWay, "kind" | "stop">;
}

/**
 * Stops `target`, as `subagent_stop` names it: a run by name or ID, every member of a Batch or Chain by its ID, or
 * every open run with "all". Returns once nothing of what it stopped runs, or once `signal` aborts the call.
 */
export async function stopTarget(
	deps: StopDeps,
	target: string,
	signal: AbortSignal | undefined,
): Promise<CallResult<undefined>> {
	const { runs, calls } = deps;
	const run = target === "all" ? undefined : runs.findOpen(target)?.record;
	// A Batch's members are found by their records: after a reload, its call is no longer under way here.
	const members =
		target === "all"
			? runs.open()
			: run
				? []
				: runs.open().filter(({ record }) => record.batch === target || record.chain === target);
	const chain = !run && calls.kind(target) === "chain";
	if (target === "all" || members.length > 0 || chain) {
		const kind = target === "all" ? undefined : chain ? "chain" : "batch";
		// Each member's stop is asked first, for its reason; then a chain starts no further step.
		const stopping = members.map(({ record }) =>
			stopRun(deps, record, signal, kind ? `Its ${kind} ${target} was stopped` : undefined),
		);
		if (chain) calls.stop(target);
		const stopped = await Promise.all(stopping);
		const text = stopped.length
			? stopped.map((result) => result.text).join("\n")
			: chain
				? `Stopped chain ${target}: no further step of it starts.`
				: "No subagents are running.";
		return {
			content: [{ type: "text", text }],
			details: undefined,
			isError: stopped.some((result) => !result.stopped),
		};
	}
	if (!run) {
		return {
			content: [{ type: "text", text: `No running subagent "${target}".` }],
			details: undefined,
			isError: true,
		};
	}
	const { text, stopped } = await stopRun(deps, run, signal);
	return { content: [{ type: "text", text }], details: undefined, isError: !stopped };
}

/**
 * Stops a run, queued or working, and waits while the call does until nothing of it runs: a stop asked for is not
 * told as done. A run on pi's RPC is cancelled; one in tmux from before has its pi ended.
 */
async function stopRun(
	{ scheduler }: StopDeps,
	run: Readonly<SubagentRunRecord>,
	signal: AbortSignal | undefined,
	reason = "Stopped by its orchestrator",
) {
	const label = formatRunLabel(run);
	scheduler.cancelRun(run.runId, "model", reason);
	const final = await whileCalled(scheduler.whenFinal(run.runId), signal);
	if (isLegacyRun(run) && final?.status === "closed") {
		return { text: `Stopped ${label}: its pi in tmux ended. ${legacyRunRefusal(final)}`, stopped: true };
	}
	if (final?.status === "cancelled") {
		return {
			text: `Stopped ${label}: its work was cancelled, and none of its processes runs any more. Its session, Reports and files are kept; only subagent_resume continues it.`,
			stopped: true,
		};
	}
	if (final?.status === "closed") {
		return {
			text: `${label} finished its work before it could be stopped; its Report: ${final.reportPath ?? "kept with the run"}.`,
			stopped: true,
		};
	}
	return {
		text: final
			? `Could not confirm ${label} stopped: ${final.errorMessage ?? final.status}.`
			: `Asked ${label} to stop; it is still stopping, and its processes may still run.`,
		stopped: false,
	};
}
