import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentActivity } from "../daemon/activity.ts";
import { loadInstances, saveInstances } from "../daemon/storage.ts";
import type { InstanceRecord } from "../daemon/types.ts";
import { testRegistry } from "./helpers/registry.ts";

function rec(id: string): InstanceRecord {
	return { id, status: "online", cwd: "/p", createdAt: "2026-01-01T00:00:00Z" };
}

describe("external (self-registered) instances", () => {
	it("registers and lists an external instance with its activity", () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "working", 1000);
		const list = supervisor.listExternalInstances(1000);
		expect(list.length).toBe(1);
		expect(list[0].record.id).toBe("ext-1");
		expect(list[0].activity).toBe("working");
	});

	it("heartbeat (re-register) updates activity and keeps it alive", () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "working", 1000);
		supervisor.registerExternal(rec("ext-1"), "idle", 10_000);
		expect(supervisor.listExternalInstances(10_000)[0].activity).toBe("idle");
		expect(supervisor.listExternalInstances(10_000).length).toBe(1);
	});

	it("counts each time a session stops working, however briefly it worked", () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "idle", 1000);
		supervisor.registerExternal(rec("ext-1"), "working", 1100);
		supervisor.registerExternal(rec("ext-1"), "working", 1200);
		supervisor.registerExternal(rec("ext-1"), "idle", 1300);
		supervisor.registerExternal(rec("ext-1"), "idle", 1400);
		expect(supervisor.listExternalInstances(1400)[0].settled).toBe(1);
		supervisor.registerExternal(rec("ext-1"), "working", 1500);
		supervisor.registerExternal(rec("ext-1"), "awaiting_input", 1600);
		expect(supervisor.listExternalInstances(1600)[0].settled).toBe(2);
	});

	it("reaps an external instance whose heartbeat is past the TTL", () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "working", 1000);
		expect(supervisor.listExternalInstances(1000 + 20_000)).toEqual([]);
	});

	it("reaps by its own clock when no time is given", () => {
		let now = 1000;
		const supervisor = testRegistry(undefined, () => now);
		supervisor.registerExternal(rec("ext-1"), "working");
		now += 14_000;
		expect(supervisor.listExternalInstances()).toHaveLength(1);
		now += 2_000;
		expect(supervisor.listExternalInstances()).toEqual([]);
	});

	it("keeps an external instance just within the TTL", () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "idle", 1000);
		expect(supervisor.listExternalInstances(1000 + 14_000).length).toBe(1);
	});

	it("unregister removes it", () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "working", 1000);
		supervisor.unregisterExternal("ext-1");
		expect(supervisor.listExternalInstances(1000)).toEqual([]);
	});
});

/**
 * The client's own heartbeat cadence (`HEARTBEAT_MS`, `ext/agent-view/self-registration.ts` —
 * a different file, no shared module to import from) times out against THIS
 * module's TTL. Mirrored here as a literal rather than a real import.
 */
describe("external instance TTL vs the client's heartbeat cadence", () => {
	const OLD_HEARTBEAT_MS = 5000; // the pre-fix interval, kept here only to prove the old bug
	const HEARTBEAT_MS = 3000; // must match self-registration.ts's current HEARTBEAT_MS

	it("the pre-fix 5000ms cadence gave exactly zero margin: 3 misses land ON the TTL boundary", () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "working", 0);
		// misses at t=5000,10000,15000 — a query landing exactly at the 3rd miss's own tick.
		expect(supervisor.listExternalInstances(3 * OLD_HEARTBEAT_MS).length).toBe(1);
		// ...but a query even 1ms later reaps it — this IS the "no margin" bug: any other
		// FleetView's routine 1s list() poll landing microseconds after drops the row.
		expect(supervisor.listExternalInstances(3 * OLD_HEARTBEAT_MS + 1)).toEqual([]);
	});

	it("at the current 3000ms cadence, 4 consecutive misses are still safely inside the TTL", () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "working", 0);
		expect(supervisor.listExternalInstances(4 * HEARTBEAT_MS).length).toBe(1); // 12000 < 15000
	});

	it("reaping now needs a 5th consecutive miss, not a 3rd", () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "working", 0);
		expect(supervisor.listExternalInstances(5 * HEARTBEAT_MS + 1)).toEqual([]); // past the 15000ms boundary
	});
});

describe("waiting for a pane's next message", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("wakes when a message is queued, leaving it for the pane's next register to drain", async () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "idle");
		const waiting = supervisor.waitExternal("ext-1", 25_000);
		await supervisor.sendExternal("ext-1", { type: "prompt", text: "hi" });
		await expect(waiting).resolves.toBe("queued");
		expect(supervisor.drainExternal("ext-1")).toEqual([{ type: "prompt", text: "hi" }]);
	});

	it("wakes at once when something is already queued", async () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "idle");
		await supervisor.sendExternal("ext-1", { type: "abort" });
		await expect(supervisor.waitExternal("ext-1", 25_000)).resolves.toBe("queued");
	});

	it("is refused for a pane that is not registered", () => {
		expect(testRegistry().waitExternal("ext-1", 25_000)).toBeUndefined();
	});

	it("answers none once the time is up with nothing queued", async () => {
		vi.useFakeTimers();
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "idle");
		let result: string | undefined;
		void supervisor.waitExternal("ext-1", 25_000)?.then((queued) => {
			result = queued;
		});
		await vi.advanceTimersByTimeAsync(24_999);
		expect(result).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(result).toBe("none");
		// The settled wait's timer is gone: a later message wakes nothing and stays queued.
		await supervisor.sendExternal("ext-1", { type: "abort" });
		expect(supervisor.drainExternal("ext-1")).toEqual([{ type: "abort" }]);
	});

	it("keeps one wait per pane: a newer one settles the older, as across a pane's reload", async () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "idle");
		const older = supervisor.waitExternal("ext-1", 25_000);
		const newer = supervisor.waitExternal("ext-1", 25_000);
		await expect(older).resolves.toBe("superseded");
		await supervisor.sendExternal("ext-1", { type: "abort" });
		await expect(newer).resolves.toBe("queued");
	});

	it("settles a pane's wait when it unregisters or its row is deleted", async () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "idle");
		supervisor.registerExternal(rec("ext-2"), "idle");
		const one = supervisor.waitExternal("ext-1", 25_000);
		const two = supervisor.waitExternal("ext-2", 25_000);
		supervisor.unregisterExternal("ext-1");
		supervisor.deleteInstance("ext-2");
		await expect(one).resolves.toBe("none");
		await expect(two).resolves.toBe("none");
	});

	it("settles a pane's wait when its row is reaped", async () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "idle", 0);
		let result: string | undefined;
		void supervisor.waitExternal("ext-1", 25_000)?.then((outcome) => {
			result = outcome;
		});
		expect(supervisor.listExternalInstances(20_000)).toEqual([]);
		await Promise.resolve();
		expect(result).toBe("none");
	});

	it("settles every wait at shutdown", async () => {
		const supervisor = testRegistry();
		supervisor.registerExternal(rec("ext-1"), "idle");
		supervisor.registerExternal(rec("ext-2"), "idle");
		const waits = [supervisor.waitExternal("ext-1", 25_000), supervisor.waitExternal("ext-2", 25_000)];
		supervisor.settleWaits();
		await expect(Promise.all(waits)).resolves.toEqual(["none", "none"]);
	});
});

describe("a run whose orchestrator's pane is gone", () => {
	/** Registers the orchestrator's pane `pi-o` and its run `pi-r`, on a tmux that has every pane in `up`. */
	function fixture() {
		const up = new Set(["pi-o", "pi-r"]);
		const ended: string[] = [];
		let now = 1000;
		const supervisor = testRegistry(undefined, () => now, {
			hasSession: (name) => up.has(name),
			end: (name) => {
				ended.push(name);
				up.delete(name);
			},
		});
		const orchestrator = { ...rec("pi-o"), pane: "pi-o" };
		const run = { ...rec("pi-r"), pane: "pi-r", parent: "pi-o" };
		supervisor.registerExternal(orchestrator, "idle");
		supervisor.registerExternal(run, "idle");
		/** Time passes with the run beating as `activity` and the orchestrator not, and a look at the list. */
		const pass = (ms: number, activity: AgentActivity = "idle") => {
			now += ms;
			supervisor.registerExternal(run, activity);
			return supervisor.listExternalInstances().map(({ record, silent }) => ({ id: record.id, silent }));
		};
		return { up, ended, pass };
	}

	it("is closed by the daemon at its next heartbeat once tmux no longer has the orchestrator's pane", () => {
		const { up, ended, pass } = fixture();
		expect(pass(1000)).toHaveLength(2);
		expect(ended).toEqual([]);
		// The orchestrator's pi crashed, and its pane went with it.
		up.delete("pi-o");
		pass(3000);
		expect(ended).toEqual(["pi-r"]);
	});

	it("finishes the turn in flight: a working run is closed at its first heartbeat once it settles", () => {
		const { up, ended, pass } = fixture();
		pass(1000, "working");
		up.delete("pi-o");
		pass(3000, "working");
		pass(3000, "working");
		expect(ended).toEqual([]);
		pass(3000, "idle");
		expect(ended).toEqual(["pi-r"]);
	});

	it("is only told it is closed while a terminal shows it, and ended once none does", () => {
		const up = new Set(["pi-o", "pi-r"]);
		const ended: string[] = [];
		let shown = true;
		const supervisor = testRegistry(undefined, undefined, {
			hasSession: (name) => up.has(name),
			end: (name) => ended.push(name),
			shown: (name) => shown && name === "pi-r",
		});
		const run = { ...rec("pi-r"), pane: "pi-r", parent: "pi-o" };
		supervisor.registerExternal({ ...rec("pi-o"), pane: "pi-o" }, "idle");
		up.delete("pi-o");
		supervisor.registerExternal(run, "idle");
		expect(ended).toEqual([]);
		expect(supervisor.drainExternal("pi-r")).toEqual([{ type: "session_message", kind: "close", from: "pi-o" }]);
		shown = false;
		supervisor.registerExternal(run, "idle");
		expect(ended).toEqual(["pi-r"]);
	});

	it("is closed at once when it waits on a dialog: nobody is left to answer it", () => {
		const { up, ended, pass } = fixture();
		up.delete("pi-o");
		pass(3000, "awaiting_input");
		expect(ended).toEqual(["pi-r"]);
	});

	it("stays open while the orchestrator's pane is Silent", () => {
		const { ended, pass } = fixture();
		// Past the TTL the orchestrator is reaped as Silent: tmux still has its pane.
		for (let beat = 0; beat < 10; beat++) pass(3000);
		expect(pass(3000)).toContainEqual({ id: "pi-o", silent: true });
		expect(ended).toEqual([]);
	});

	it("is left open when tmux cannot say whether the orchestrator's pane is there", () => {
		const ended: string[] = [];
		const supervisor = testRegistry(undefined, undefined, {
			hasSession: (name) => {
				if (name === "pi-o") throw new Error("tmux timed out");
				return true;
			},
			end: (name) => ended.push(name),
		});
		supervisor.registerExternal({ ...rec("pi-r"), pane: "pi-r", parent: "pi-o" }, "idle");
		expect(ended).toEqual([]);
	});
});

describe("a run's row", () => {
	/** The orchestrator's pane `pi-o` and its open run `pi-r`, with a run it closed stored, on a tmux
	 *  that has every pane in `up`. */
	function fixture() {
		const dir = mkdtempSync(join(tmpdir(), "bluclawd-runs-"));
		const up = new Set(["pi-o", "pi-r"]);
		const ended: string[] = [];
		const supervisor = testRegistry(dir, undefined, {
			hasSession: (name) => up.has(name),
			end: (name) => {
				ended.push(name);
				up.delete(name);
			},
		});
		const runFile = join(dir, "run.jsonl");
		writeFileSync(runFile, "");
		saveInstances(dir, [
			{ id: "closed", status: "stopped", cwd: "/p", createdAt: "2026-01-01T00:00:00Z", parent: "pi-o" },
		]);
		supervisor.registerExternal({ ...rec("pi-o"), pane: "pi-o" }, "idle");
		supervisor.registerExternal({ ...rec("pi-r"), pane: "pi-r", parent: "pi-o", sessionFile: runFile }, "idle");
		const ids = () => [
			...supervisor.listExternalInstances().map(({ record }) => record.id),
			...supervisor.listInstances().map((i) => i.id),
		];
		return { dir, up, ended, supervisor, ids, runFile };
	}

	it("goes with its orchestrator's row, and its pi ends", () => {
		const { ended, supervisor, ids } = fixture();
		expect(ids().sort()).toEqual(["closed", "pi-o", "pi-r"]);
		expect(supervisor.deleteInstance("pi-o")).toBe(true);
		expect(ended).toEqual(["pi-r"]);
		expect(ids()).toEqual([]);
	});

	it("is not saved again by its pi's quit once deleted with its orchestrator", () => {
		const { supervisor, ids, runFile } = fixture();
		supervisor.deleteInstance("pi-o");
		supervisor.saveInstance({ cwd: "/p", sessionFile: runFile, parent: "pi-o" });
		expect(ids()).toEqual([]);
	});

	it("stored, goes once tmux no longer has its orchestrator's pane", () => {
		const { dir, up, supervisor } = fixture();
		saveInstances(dir, [
			...loadInstances(dir),
			{ id: "orphan", status: "stopped", cwd: "/p", createdAt: "2026-01-01T00:00:00Z", parent: "pi-gone" },
		]);
		expect(supervisor.listInstances().map((i) => i.id)).toEqual(["closed"]);
		expect(loadInstances(dir).map((i) => i.id)).not.toContain("orphan");
		// A Silent orchestrator's tmux still has its pane: the rows of its runs stay.
		up.add("pi-silent");
		saveInstances(dir, [
			...loadInstances(dir),
			{ id: "held", status: "stopped", cwd: "/p", createdAt: "2026-01-01T00:00:00Z", parent: "pi-silent" },
		]);
		expect(supervisor.listInstances().map((i) => i.id)).toEqual(["closed", "held"]);
	});
});
