import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maxActiveRuns, RUN_CLAIM_WAIT_MS, type RunHostLaunch, RunQueue } from "../daemon/run-queue.ts";

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
function fixture(capacity: () => number | undefined = () => 4) {
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
		capacity,
	});
	queues.push(queue);
	/** A claim, and whether it was granted yet. */
	const claim = (run: string, parent: string) => {
		const state: { granted?: boolean } = {};
		const done = queue.claim(run, parent).then((granted) => {
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
		const claims = ["a1", "a2", "a3"].map((run) => f.claim(run, "alpha"));
		const [b1, b2] = ["b1", "b2"].map((run) => f.claim(run, "beta"));
		await settle();
		expect([...claims, b1, b2].map(({ state }) => state.granted)).toEqual([true, true, true, true, undefined]);
		for (const run of ["a1", "a2", "a3", "b1"]) f.launch(run);

		f.end("a1");
		await settle();
		expect(b2.state.granted).toBe(true);
	});

	it("holds a run's slot while its processes run, though its orchestrator released it", async () => {
		const f = fixture(() => 1);
		f.claim("a1", "alpha");
		await settle();
		f.launch("a1");
		const next = f.claim("a2", "alpha");
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
		const f = fixture(() => 2);
		const alpha = ["a1", "a2", "a3", "a4"].map((run) => f.claim(run, "alpha"));
		await settle();
		f.launch("a1");
		f.launch("a2");
		const b1 = f.claim("b1", "beta");

		f.end("a1");
		await settle();
		expect([b1.state.granted, alpha[2].state.granted]).toEqual([true, undefined]);
		f.launch("b1");
		f.end("a2");
		await settle();
		expect([alpha[2].state.granted, alpha[3].state.granted]).toEqual([true, undefined]);
	});

	it("keeps the bound it last read while the user's settings cannot be read (#321)", async () => {
		const reads: (number | undefined)[] = [2, 2, undefined, undefined];
		const f = fixture(() => reads.shift());
		const [a1, a2, a3] = ["a1", "a2", "a3"].map((run) => f.claim(run, "alpha"));
		await settle();
		expect([a1, a2, a3].map(({ state }) => state.granted)).toEqual([true, true, undefined]);
	});

	it("grants no run whose orchestrator stopped claiming it", async () => {
		const f = fixture(() => 1);
		f.claim("a1", "alpha");
		await settle();
		f.launch("a1");
		const gone = f.claim("b1", "beta");
		await vi.advanceTimersByTimeAsync(RUN_CLAIM_WAIT_MS);
		expect(gone.state.granted).toBe(false);

		f.end("a1");
		const later = f.claim("c1", "gamma");
		await settle();
		expect(later.state.granted).toBe(true);
		expect(() => f.launch("b1")).toThrow(/not granted/);
	});

	it("gives a granted run's slot to the next once its orchestrator neither launches nor releases it", async () => {
		const f = fixture(() => 1);
		f.claim("a1", "alpha");
		await settle();
		const next = f.claim("b1", "beta");
		await vi.advanceTimersByTimeAsync(20_000);
		expect(next.state.granted).toBeUndefined();
		// A claim waits its while, then is made again.
		await vi.advanceTimersByTimeAsync(RUN_CLAIM_WAIT_MS);
		const again = f.claim("b1", "beta");
		await vi.advanceTimersByTimeAsync(20_000);
		expect(again.state.granted).toBe(true);
		expect(() => f.launch("a1")).toThrow(/not granted/);
	});

	it("frees the slot of a run whose host could not be started, and of a claim given up", async () => {
		const f = fixture(() => 1);
		const queue = new RunQueue({
			now: () => Date.now(),
			spawn: () => {
				throw new Error("spawn node ENOENT");
			},
			running: () => true,
			capacity: () => 1,
		});
		queues.push(queue);
		await queue.claim("a1", "alpha");
		expect(() => queue.launch("a1", host("a1"))).toThrow(/ENOENT/);
		expect(await queue.claim("a2", "alpha")).toBe(true);

		f.claim("b1", "beta");
		await settle();
		const given = f.claim("b2", "beta");
		f.queue.release("b2");
		await settle();
		expect(given.state.granted).toBe(false);
		f.queue.release("b1");
		const next = f.claim("b3", "beta");
		await settle();
		expect(next.state.granted).toBe(true);
	});

	it("bounds active runs by the user's own setting as it is at each claim, which no orchestrator gives", async () => {
		let max = 2;
		const f = fixture(() => max);
		for (const run of ["a1", "a2"]) f.claim(run, "alpha");
		await settle();
		for (const run of ["a1", "a2"]) f.launch(run);
		const third = f.claim("a3", "alpha");
		await settle();
		expect(third.state.granted).toBeUndefined();

		// The user raises it: the next claim, as an orchestrator makes one again while it waits, is granted.
		max = 3;
		const again = f.claim("a3", "alpha");
		await settle();
		expect(again.state.granted).toBe(true);
	});

	it("grants a run a slot at once only when one is free, never queuing it (#353)", async () => {
		const f = fixture(() => 1);
		f.claim("a1", "alpha");
		await settle();
		f.launch("a1");

		// Every slot is taken: it is told how many, and nothing of it waits for one.
		expect(f.queue.claimNow("k/1", "beta")).toEqual({ granted: false, active: 1, capacity: 1 });
		const next = f.claim("a2", "alpha");
		f.end("a1");
		await settle();
		expect(next.state.granted).toBe(true);
		f.launch("a2");
		f.end("a2");

		// A slot is free: it is granted, and its claim then is at once.
		expect(f.queue.claimNow("k/1", "beta")).toEqual({ granted: true, active: 1, capacity: 1 });
		expect(await f.queue.claim("k/1", "beta")).toBe(true);
		f.launch("k/1");
		expect(f.spawned.map(({ runDir }) => runDir)).toEqual(["/runs/a1", "/runs/a2", "/runs/k/1"]);
	});
});

describe("maxActiveRuns: the user's bound on active runs", () => {
	it("is four unless the user's own settings give a positive whole number", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "bluclawd-max-active-"));
		try {
			const bound = (settings: unknown) => {
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
				return maxActiveRuns(agentDir);
			};
			expect(bound({ subagents: { maxActive: 2 } })).toBe(2);
			for (const maxActive of [0, -1, 2.5, "6"]) expect(bound({ subagents: { maxActive } })).toBe(4);
			expect(bound({})).toBe(4);
			rmSync(join(agentDir, "settings.json"));
			expect(maxActiveRuns(agentDir)).toBe(4);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("is unknown while the settings cannot be read, as when another writer has written half of them (#321)", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "bluclawd-max-active-"));
		try {
			writeFileSync(join(agentDir, "settings.json"), '{"subagents":{"maxAct');
			expect(maxActiveRuns(agentDir)).toBeUndefined();
			rmSync(join(agentDir, "settings.json"));
			mkdirSync(join(agentDir, "settings.json"));
			expect(maxActiveRuns(agentDir)).toBeUndefined();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("gives a run in a pane its launch's environment once, without loaders, and none for a pane no run launched", async () => {
		const { queue, claim, spawned } = fixture();
		const run = "sub_a-0";
		await claim(run, "o").done;
		queue.launch(run, { runDir: "/runs/a", env: { PATH: "/bin", NODE_OPTIONS: "--require x" }, pane: run });
		expect(spawned.at(-1)).toMatchObject({ pane: run });
		expect(queue.takePaneEnv("sub_b-0")).toBeUndefined();
		expect(queue.takePaneEnv(run)).toEqual({ PATH: "/bin" });
		expect(queue.takePaneEnv(run)).toBeUndefined();
	});

	it("refuses a pane not named as a run's", async () => {
		const { queue, claim } = fixture();
		await claim("sub_a-0", "o").done;
		expect(() => queue.launch("sub_a-0", { ...host("a"), pane: "main; kill-server" })).toThrow(
			/not named as a run's/,
		);
	});
});
