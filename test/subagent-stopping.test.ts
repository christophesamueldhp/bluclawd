import { describe, expect, it } from "vitest";
import type { SubagentRunRecord } from "../ext/subagents/runs.ts";
import { CallsUnderWay } from "../ext/subagents/settling.ts";
import { stopTarget } from "../ext/subagents/stopping.ts";
import { fakeScheduler, runRecord } from "./helpers/fake-runs.ts";

function setup(runs: SubagentRunRecord[]) {
	const scheduler = fakeScheduler(runs);
	const calls = new CallsUnderWay();
	const stop = async (target: string, signal?: AbortSignal) => {
		const result = await stopTarget({ scheduler, runs: scheduler.views, calls }, target, signal);
		return { text: result.content.map((part) => part.text).join(""), isError: result.isError };
	};
	return { scheduler, calls, stop };
}

const CANCELLED =
	"its work was cancelled, and none of its processes runs any more. Its session, Reports and files are kept; only subagent_resume continues it.";

describe("Stop", () => {
	it("cancels a run by name or ID, and says so once nothing of it runs", async () => {
		const { scheduler, stop } = setup([runRecord({ name: "a" }), runRecord({ name: "b" })]);
		expect(await stop("a")).toEqual({ text: `Stopped "a" (sub_a): ${CANCELLED}`, isError: false });
		expect(await stop("sub_b")).toEqual({ text: `Stopped "b" (sub_b): ${CANCELLED}`, isError: false });
		expect(scheduler.cancelled).toEqual([
			{ runId: "sub_a", source: "model", reason: "Stopped by its orchestrator" },
			{ runId: "sub_b", source: "model", reason: "Stopped by its orchestrator" },
		]);
	});

	it("says a run finished before it could be stopped, with its Report", async () => {
		const { scheduler, stop } = setup([runRecord({ name: "a" })]);
		scheduler.onCancel = () => ({ status: "closed", reportPath: "/runs/a/report.md" });
		expect(await stop("a")).toEqual({
			text: `"a" (sub_a) finished its work before it could be stopped; its Report: /runs/a/report.md.`,
			isError: false,
		});
	});

	it("says it could not confirm a stop when the run ended otherwise", async () => {
		const { scheduler, stop } = setup([runRecord({ name: "a" })]);
		scheduler.onCancel = () => ({ status: "failed", errorMessage: "its host died" });
		expect(await stop("a")).toEqual({ text: `Could not confirm "a" (sub_a) stopped: its host died.`, isError: true });
	});

	it("says a run is still stopping once its call is cancelled first", async () => {
		const { scheduler, stop } = setup([runRecord({ name: "a" })]);
		scheduler.onCancel = () => undefined;
		const call = new AbortController();
		const stopped = stop("a", call.signal);
		call.abort();
		expect(await stopped).toEqual({
			text: `Asked "a" (sub_a) to stop; it is still stopping, and its processes may still run.`,
			isError: true,
		});
	});

	it("ends a Legacy run's pi", async () => {
		const { scheduler, stop } = setup([
			runRecord({ name: "old", backend: undefined, kind: undefined, pane: "pi-old" }),
		]);
		scheduler.onCancel = () => ({ status: "closed", reportPath: "/r.md", transcriptPath: "/t.jsonl" });
		expect((await stop("old")).text).toBe(
			`Stopped "old" (sub_old): its pi in tmux ended. "old" (sub_old) ran in tmux, before runs ran on pi's RPC, and is not resumed. To continue its work, launch a new subagent and point it at its Report (/r.md) and transcript (/t.jsonl).`,
		);
	});

	it("cancels every member of a Batch by its ID, from their records, though its call is not under way here", async () => {
		const { scheduler, stop } = setup([
			runRecord({ name: "a", batch: "batch_1" }),
			runRecord({ name: "b", batch: "batch_1", status: "starting" }),
			runRecord({ name: "c" }),
		]);
		expect(await stop("batch_1")).toEqual({
			text: `Stopped "a" (sub_a): ${CANCELLED}\nStopped "b" (sub_b): ${CANCELLED}`,
			isError: false,
		});
		expect(scheduler.cancelled).toEqual([
			{ runId: "sub_a", source: "model", reason: "Its batch batch_1 was stopped" },
			{ runId: "sub_b", source: "model", reason: "Its batch batch_1 was stopped" },
		]);
		expect(scheduler.getRun("sub_c")?.status).toBe("running");
	});

	it("cancels a Chain's working step and starts none of its later steps", async () => {
		const { scheduler, calls, stop } = setup([runRecord({ name: "a", chain: "chain_1" })]);
		const chain = new AbortController();
		calls.add("chain_1", "chain", chain);
		expect(await stop("chain_1")).toEqual({ text: `Stopped "a" (sub_a): ${CANCELLED}`, isError: false });
		expect(scheduler.cancelled).toEqual([
			{ runId: "sub_a", source: "model", reason: "Its chain chain_1 was stopped" },
		]);
		expect(chain.signal.aborted).toBe(true);
	});

	it("stops a Chain between steps, with none of it working", async () => {
		const { calls, stop } = setup([]);
		const chain = new AbortController();
		calls.add("chain_1", "chain", chain);
		expect(await stop("chain_1")).toEqual({
			text: "Stopped chain chain_1: no further step of it starts.",
			isError: false,
		});
		expect(chain.signal.aborted).toBe(true);
	});

	it(`cancels every open run with "all", each for its own reason`, async () => {
		const { scheduler, stop } = setup([
			runRecord({ name: "a" }),
			runRecord({ name: "b", batch: "batch_1" }),
			runRecord({ name: "done", status: "closed" }),
		]);
		expect((await stop("all")).text).toBe(`Stopped "a" (sub_a): ${CANCELLED}\nStopped "b" (sub_b): ${CANCELLED}`);
		expect(scheduler.cancelled.map(({ reason }) => reason)).toEqual([
			"Stopped by its orchestrator",
			"Stopped by its orchestrator",
		]);
		expect(await stop("all")).toEqual({ text: "No subagents are running.", isError: false });
	});

	it("refuses a target no open run, Batch or Chain answers to", async () => {
		const { stop } = setup([runRecord({ name: "done", status: "closed" })]);
		expect(await stop("done")).toEqual({ text: `No running subagent "done".`, isError: true });
		expect(await stop("batch_9")).toEqual({ text: `No running subagent "batch_9".`, isError: true });
	});
});
