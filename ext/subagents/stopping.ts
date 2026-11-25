import { formatRunLabel, isLegacyRun, type SubagentRunRecord, type SubagentRunScheduler } from "./runs.ts";
import { type CallResult, type CallsUnderWay, whileCalled } from "./settling.ts";
import { legacyRunRefusal } from "./tmux-runs.ts";
import type { ParentScopeViews } from "./views.ts";

export interface StopDeps {
	scheduler: Pick<SubagentRunScheduler, "cancelRun" | "whenFinal">;
	runs: Pick<ParentScopeViews, "open" | "findOpen">;
	calls: Pick<CallsUnderWay, "kind" | "stop">;
}

export async function stopTarget(
	deps: StopDeps,
	target: string,
	signal: AbortSignal | undefined,
): Promise<CallResult<undefined>> {
	const { runs, calls } = deps;
	const run = target === "all" ? undefined : runs.findOpen(target)?.record;
	const members = target === "all" ? runs.open() : run ? [] : openGroupMembers(runs, target);
	const chain = !run && calls.kind(target) === "chain";
	if (target === "all" || members.length > 0 || chain) {
		const kind = target === "all" ? undefined : chain ? "chain" : "batch";
		const stopped = await stopMembersThenChain(deps, members, { target, kind, chain }, signal);
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

const openGroupMembers = (runs: StopDeps["runs"], target: string) =>
	runs.open().filter(({ record }) => record.batch === target || record.chain === target);

function stopMembersThenChain(
	deps: StopDeps,
	members: ReturnType<StopDeps["runs"]["open"]>,
	{ target, kind, chain }: { target: string; kind: "chain" | "batch" | undefined; chain: boolean },
	signal: AbortSignal | undefined,
) {
	const stopping = members.map(({ record }) =>
		stopRun(deps, record, signal, kind ? `Its ${kind} ${target} was stopped` : undefined),
	);
	if (chain) deps.calls.stop(target);
	return Promise.all(stopping);
}

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
