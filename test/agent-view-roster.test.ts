import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceSummary } from "../daemon/orchestrator-client.ts";
import type { ShellInfo } from "../daemon/tmux.ts";
import { Roster } from "../ext/agent-view/roster.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** A pane's pi, as the daemon lists it. */
const pane = (id: string, extra: Partial<InstanceSummary> = {}): InstanceSummary => ({
	id,
	status: "online",
	cwd: "/p",
	label: id,
	external: true,
	pane: id,
	...extra,
});
/** The row a restarted daemon stored behind a pane it has not heard from yet. */
const stored = (id: string): InstanceSummary => ({ id, status: "stopped", cwd: "/p", label: `${id} stored` });
const shell = (name: string): ShellInfo =>
	({ name, command: "ls", cwd: "/p", createdAt: "2026-01-01T00:00:00Z", exit: "0", lastLine: "ok" }) as ShellInfo;

/** A promise settled from outside, for a read or a write that is still on its way. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A roster over a daemon whose list and clock the test holds. */
function world(options: { seed?: InstanceSummary[]; hide?: string; shells?: ShellInfo[] } = {}) {
	const w = {
		now: 1000,
		listed: [] as InstanceSummary[],
		shells: options.shells ?? [],
		/** Each read's own answer, when a test holds one back; else `listed` at once. */
		reads: [] as Array<ReturnType<typeof deferred<InstanceSummary[]>>>,
		held: false,
		lists: 0,
		writes: [] as Array<{ id: string; sortOrder?: number; done: ReturnType<typeof deferred<void>> }>,
		holdWrites: false,
		changes: 0,
		orderErrors: [] as unknown[],
	};
	const roster = new Roster({
		client: {
			list: async () => {
				w.lists++;
				if (!w.held) return w.listed;
				const read = deferred<InstanceSummary[]>();
				w.reads.push(read);
				return read.promise;
			},
			setMeta: async (id, meta) => {
				const done = deferred<void>();
				w.writes.push({ id, sortOrder: meta.sortOrder, done });
				if (!w.holdWrites) done.resolve();
				return done.promise;
			},
		},
		shells: { list: () => w.shells, listAsync: async () => w.shells },
		now: () => w.now,
		hide: options.hide,
		seed: options.seed,
		changed: () => {
			w.changes++;
		},
		orderFailed: (error) => w.orderErrors.push(error),
	});
	const ids = () => roster.listed(undefined).rows.map((row) => row.id);
	const labels = () => roster.listed(undefined).rows.map((row) => row.label);
	const order = () => roster.listed(undefined).instances.map((i) => [i.id, i.sortOrder]);
	return { w, roster, ids, labels, order };
}

/** Lets the promise chains of a read or a write run. */
const settle = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("agent view's roster", () => {
	afterEach(() => vi.useRealTimers());

	it("lists what the opener read until its first read, with the `!` commands, and never a hidden row", async () => {
		const { w, roster, ids } = world({ seed: [pane("a"), pane("gone")], hide: "gone", shells: [shell("sh-1")] });
		expect(ids()).toEqual(["a", "sh-1"]);
		expect(w.changes).toBe(0);
		w.listed = [pane("a"), pane("b"), pane("gone")];
		await roster.refresh();
		expect(ids()).toEqual(["a", "b", "sh-1"]);
		expect(w.changes).toBe(1);
	});

	it("lists nothing before its first read when the opener read nothing", () => {
		const { ids } = world({ shells: [shell("sh-1")] });
		expect(ids()).toEqual([]);
	});

	it("reads once more after a read in flight, however often it is asked meanwhile", async () => {
		const { w, roster, ids } = world();
		w.held = true;
		const first = roster.refresh();
		const again = [roster.refresh(), roster.refresh(), roster.refresh()];
		await settle();
		expect(w.lists).toBe(1);
		w.reads[0].resolve([pane("a")]);
		await first;
		expect(ids()).toEqual(["a"]);
		await settle();
		// What was done while the first was in flight may postdate its list: one more read, not three.
		expect(w.lists).toBe(2);
		w.reads[1].resolve([pane("a"), pane("b")]);
		await Promise.all(again);
		expect(ids()).toEqual(["a", "b"]);
		expect(w.lists).toBe(2);
	});

	it("keeps the last known rows when the daemon does not answer, and says so until it does", async () => {
		const { w, roster, ids } = world();
		w.listed = [pane("a")];
		await roster.refresh();
		w.held = true;
		const read = roster.refresh();
		await settle();
		w.reads[0].reject(new Error("timed out"));
		await read;
		expect(roster.connectionLost).toBe(true);
		expect(ids()).toEqual(["a"]);
		w.held = false;
		await roster.refresh();
		expect(roster.connectionLost).toBe(false);
	});

	it("reads again every second once watched, and nothing more once stopped", async () => {
		vi.useFakeTimers();
		const { w, roster } = world();
		roster.watch();
		await vi.advanceTimersByTimeAsync(3000);
		expect(w.lists).toBe(3);
		expect(w.changes).toBe(3);
		roster.stop();
		await vi.advanceTimersByTimeAsync(3000);
		await roster.refresh();
		expect(w.lists).toBe(3);
		expect(w.changes).toBe(3);
	});

	describe("a delete", () => {
		it("takes its row out at once, and puts it back when it fails", async () => {
			const { w, roster, ids } = world();
			w.listed = [pane("a"), pane("b")];
			await roster.refresh();
			roster.startDelete("a");
			expect(ids()).toEqual(["b"]);
			expect(w.changes).toBe(2);
			// The daemon still lists it meanwhile.
			await roster.refresh();
			expect(ids()).toEqual(["b"]);
			roster.endDelete("a");
			expect(ids()).toEqual(["a", "b"]);
		});

		it("that landed is not undone by a list asked for before it landed", async () => {
			const { w, roster, ids } = world();
			w.listed = [pane("a"), pane("b")];
			await roster.refresh();
			w.held = true;
			const stale = roster.refresh();
			await settle();
			w.now = 1500;
			roster.deleted(["a"]);
			expect(ids()).toEqual(["b"]);
			w.reads[0].resolve([pane("a"), pane("b")]);
			await stale;
			expect(ids()).toEqual(["b"]);
		});

		it("is not carried back by the grace of a daemon restart", async () => {
			const { w, roster, labels } = world({ seed: [pane("a", { label: "doomed" }), pane("b", { label: "kept" })] });
			// A restarted daemon lists no pane until it beats again; their rows are carried meanwhile.
			roster.daemonRestarted();
			w.held = true;
			const stale = roster.refresh();
			await settle();
			w.now += 10;
			roster.deleted(["a"]);
			// A poll read before the delete landed answers with the row still in it.
			w.reads[0].resolve([pane("a", { label: "doomed" }), pane("b", { label: "kept" })]);
			await stale;
			w.held = false;
			w.listed = [];
			await roster.refresh();
			expect(labels()).toEqual(["kept"]);
		});
	});

	describe("after this view restarted the daemon", () => {
		it("carries a pane's row over the stored one until the pane beats again, or a beat would have come", async () => {
			const { w, roster, labels } = world({ seed: [pane("a", { label: "carried on" })] });
			roster.daemonRestarted();
			w.listed = [stored("a")];
			await roster.refresh();
			expect(labels()).toEqual(["carried on"]);
			w.listed = [pane("a", { label: "re-registered" })];
			await roster.refresh();
			expect(labels()).toEqual(["re-registered"]);
			// A pane that never heartbeats again is gone once a heartbeat would have come.
			w.listed = [];
			w.now += 10_000;
			await roster.refresh();
			expect(labels()).toEqual([]);
		});

		it("carries nothing when no daemon was restarted", async () => {
			const { w, roster, labels } = world({ seed: [pane("a", { label: "as opened" })] });
			w.listed = [stored("a")];
			await roster.refresh();
			expect(labels()).toEqual(["a stored"]);
		});
	});

	describe("a Manual order", () => {
		it("shows at once, and gives way to the daemon's once its writes and the list after them are in", async () => {
			const { w, roster, order } = world();
			w.listed = [pane("a"), pane("b")];
			await roster.refresh();
			w.holdWrites = true;
			roster.reorder([
				["b", 0],
				["a", 1],
			]);
			expect(order()).toEqual([
				["a", 1],
				["b", 0],
			]);
			await settle();
			expect(w.writes.map(({ id, sortOrder }) => [id, sortOrder])).toEqual([
				["b", 0],
				["a", 1],
			]);
			// A poll meanwhile reads a list from before the writes: the order given still shows.
			await roster.refresh();
			expect(order()).toEqual([
				["a", 1],
				["b", 0],
			]);
			w.listed = [pane("a", { sortOrder: 1 }), pane("b", { sortOrder: 0 })];
			for (const write of w.writes) write.done.resolve();
			await waitFor(() => expect(w.lists).toBe(3));
			await settle();
			// The daemon's own, now: a later change of its order shows.
			w.listed = [pane("a", { sortOrder: 7 }), pane("b", { sortOrder: 0 })];
			await roster.refresh();
			expect(order()).toEqual([
				["a", 7],
				["b", 0],
			]);
			expect(w.orderErrors).toEqual([]);
		});

		it("given again before the first is saved waits for it, and the first's end does not drop the second", async () => {
			const { w, roster, order } = world();
			w.listed = [pane("a"), pane("b"), pane("c")];
			await roster.refresh();
			w.holdWrites = true;
			roster.reorder([
				["b", 0],
				["a", 1],
				["c", 2],
			]);
			roster.reorder([
				["b", 0],
				["c", 1],
				["a", 2],
			]);
			await settle();
			// Only the first press's writes are out.
			expect(w.writes).toHaveLength(3);
			for (const write of w.writes) write.done.resolve();
			await waitFor(() => expect(w.writes).toHaveLength(6));
			// The first's list is in, with the daemon knowing only the first: the second still shows.
			expect(order()).toEqual([
				["a", 2],
				["b", 0],
				["c", 1],
			]);
			w.listed = [pane("a", { sortOrder: 2 }), pane("b", { sortOrder: 0 }), pane("c", { sortOrder: 1 })];
			const before = w.lists;
			for (const write of w.writes.slice(3)) write.done.resolve();
			await waitFor(() => expect(w.lists).toBeGreaterThan(before));
			await settle();
			w.listed = [pane("a"), pane("b"), pane("c")];
			await roster.refresh();
			expect(order()).toEqual([
				["a", undefined],
				["b", undefined],
				["c", undefined],
			]);
		});

		it("that could not be saved is reported, and gives way to the daemon's", async () => {
			const { w, roster, order } = world();
			w.listed = [pane("a"), pane("b")];
			await roster.refresh();
			w.holdWrites = true;
			roster.reorder([
				["b", 0],
				["a", 1],
			]);
			await settle();
			const failure = new Error("Unknown instance: a");
			w.writes[0].done.resolve();
			w.writes[1].done.reject(failure);
			await waitFor(() => expect(w.orderErrors).toEqual([failure]));
			await waitFor(() => expect(w.lists).toBe(2));
			await settle();
			expect(order()).toEqual([
				["a", undefined],
				["b", undefined],
			]);
		});
	});
});
