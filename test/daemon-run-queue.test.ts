import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_CLAIM_WAIT_MS, type RunHostLaunch, RunQueue } from "../daemon/run-queue.ts";

let queues: RunQueue[] = [];
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	for (const queue of queues) queue.stop();
	queues = [];
	vi.useRealTimers();
});

const host = (run: string): RunHostLaunch => ({ runDir: `/runs/${run}`, env: { PATH: "/bin", RUN: run } });

/** A queue whose launched hosts run until `end(run)`; what it spawned is listed. */
function fixture() {
	let nextPid = 100;
	const live = new Map<string, number>();
	const spawned: RunHostLaunch[] = [];
	const queue = new RunQueue({
		now: () => Date.now(),
		spawn: (launch) => {
			spawned.push(launch);
			return nextPid++;
		},
		running: (pid) => [...live.values()].includes(pid),
	});
	queues.push(queue);
	/** A claim, and whether it was granted yet. */
	const claim = (run: string, parent: string, capacity = 4) => {
		const state: { granted?: boolean } = {};
		const done = queue.claim(run, parent, capacity).then((granted) => {
			state.granted = granted;
			return granted;
		});
		return { state, done };
	};
	const launch = (run: string) => {
		const pid = queue.launch(run, host(run));
		live.set(run, pid);
		return pid;
	};
	/** The run's processes are all gone. */
	const end = (run: string) => {
		live.delete(run);
		queue.check();
	};
	return { queue, spawned, claim, launch, end };
}

/** Lets settled claims report. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("the daemon's queue of runs", () => {
	it("grants as many runs as its capacity across orchestrators, and the next once a run's processes are gone", async () => {
		const f = fixture();
		const claims = ["a1", "a2", "a3"].map((run) => f.claim(run, "alpha", 4));
		const [b1, b2] = ["b1", "b2"].map((run) => f.claim(run, "beta", 4));
		await settle();
		expect([...claims, b1, b2].map(({ state }) => state.granted)).toEqual([true, true, true, true, undefined]);
		for (const run of ["a1", "a2", "a3", "b1"]) f.launch(run);

		f.end("a1");
		await settle();
		expect(b2.state.granted).toBe(true);
	});

	it("holds a run's slot while its processes run, though its orchestrator released it", async () => {
		const f = fixture();
		f.claim("a1", "alpha", 1);
		await settle();
		f.launch("a1");
		const next = f.claim("a2", "alpha", 1);
		f.queue.release("a1");
		f.queue.check();
		await settle();
		expect(next.state.granted).toBeUndefined();

		f.end("a1");
		await settle();
		expect(next.state.granted).toBe(true);
	});

	it("launches each run's host as its orchestrator gave it", async () => {
		const f = fixture();
		f.claim("a1", "alpha");
		await settle();
		const pid = f.launch("a1");
		expect(f.spawned).toEqual([host("a1")]);
		// Asked again, as after a lost reply: the run is not launched twice.
		expect(f.queue.launch("a1", host("a1"))).toBe(pid);
		expect(f.spawned).toHaveLength(1);
		expect(() => f.queue.launch("a2", host("a2"))).toThrow(/not granted/);
	});

	it("starts no host whose directory, environment or run is not one a run's host has", async () => {
		const f = fixture();
		f.claim("a1", "alpha");
		await settle();
		const launch = (sent: unknown) => () => f.queue.launch("a1", sent as RunHostLaunch);
		expect(launch({ runDir: "runs/a1", env: {} })).toThrow(/not an absolute path/);
		expect(launch({ runDir: "/runs/a1", env: { PATH: 1 } })).toThrow(/not a set of strings/);
		// A run with a shell has its processes named by its run ID: a key that is not one names none.
		expect(launch({ ...host("a1"), contained: true })).toThrow(/names its processes/);
		expect(f.spawned).toEqual([]);
	});

	it("serves the orchestrator served least recently first, so a large batch does not hold another's runs back", async () => {
		const f = fixture();
		const alpha = ["a1", "a2", "a3", "a4"].map((run) => f.claim(run, "alpha", 2));
		await settle();
		f.launch("a1");
		f.launch("a2");
		const b1 = f.claim("b1", "beta", 2);

		f.end("a1");
		await settle();
		expect([b1.state.granted, alpha[2].state.granted]).toEqual([true, undefined]);
		f.launch("b1");
		f.end("a2");
		await settle();
		expect([alpha[2].state.granted, alpha[3].state.granted]).toEqual([true, undefined]);
	});

	it("grants no run whose orchestrator stopped claiming it", async () => {
		const f = fixture();
		f.claim("a1", "alpha", 1);
		await settle();
		f.launch("a1");
		const gone = f.claim("b1", "beta", 1);
		await vi.advanceTimersByTimeAsync(RUN_CLAIM_WAIT_MS);
		expect(gone.state.granted).toBe(false);

		f.end("a1");
		const later = f.claim("c1", "gamma", 1);
		await settle();
		expect(later.state.granted).toBe(true);
		expect(() => f.launch("b1")).toThrow(/not granted/);
	});

	it("gives a granted run's slot to the next once its orchestrator neither launches nor releases it", async () => {
		const f = fixture();
		f.claim("a1", "alpha", 1);
		await settle();
		const next = f.claim("b1", "beta", 1);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(next.state.granted).toBeUndefined();
		// A claim waits its while, then is made again.
		await vi.advanceTimersByTimeAsync(RUN_CLAIM_WAIT_MS);
		const again = f.claim("b1", "beta", 1);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(again.state.granted).toBe(true);
		expect(() => f.launch("a1")).toThrow(/not granted/);
	});

	it("frees the slot of a run whose host could not be started, and of a claim given up", async () => {
		const f = fixture();
		const queue = new RunQueue({
			now: () => Date.now(),
			spawn: () => {
				throw new Error("spawn node ENOENT");
			},
			running: () => true,
		});
		queues.push(queue);
		await queue.claim("a1", "alpha", 1);
		expect(() => queue.launch("a1", host("a1"))).toThrow(/ENOENT/);
		expect(await queue.claim("a2", "alpha", 1)).toBe(true);

		f.claim("b1", "beta", 1);
		await settle();
		const given = f.claim("b2", "beta", 1);
		f.queue.release("b2");
		await settle();
		expect(given.state.granted).toBe(false);
		f.queue.release("b1");
		const next = f.claim("b3", "beta", 1);
		await settle();
		expect(next.state.granted).toBe(true);
	});

	it("bounds active runs by the capacity the latest claim gives", async () => {
		const f = fixture();
		for (const run of ["a1", "a2"]) f.claim(run, "alpha", 2);
		await settle();
		for (const run of ["a1", "a2"]) f.launch(run);
		const third = f.claim("a3", "alpha", 3);
		await settle();
		expect(third.state.granted).toBe(true);
	});
});
