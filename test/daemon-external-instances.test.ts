import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerSupervisor } from "../daemon/supervisor.ts";
import type { InstanceRecord } from "../daemon/types.ts";

function rec(id: string): InstanceRecord {
	return { id, status: "online", cwd: "/p", createdAt: "2026-01-01T00:00:00Z" };
}

describe("external (self-registered) instances", () => {
	it("registers and lists an external instance with its activity", () => {
		const supervisor = new ServerSupervisor();
		supervisor.registerExternal(rec("ext-1"), "working", 1000);
		const list = supervisor.listExternalInstances(1000);
		expect(list.length).toBe(1);
		expect(list[0].record.id).toBe("ext-1");
		expect(list[0].activity).toBe("working");
	});

	it("heartbeat (re-register) updates activity and keeps it alive", () => {
		const supervisor = new ServerSupervisor();
		supervisor.registerExternal(rec("ext-1"), "working", 1000);
		supervisor.registerExternal(rec("ext-1"), "idle", 10_000);
		expect(supervisor.listExternalInstances(10_000)[0].activity).toBe("idle");
		expect(supervisor.listExternalInstances(10_000).length).toBe(1);
	});

	it("reaps an external instance whose heartbeat is past the TTL", () => {
		const supervisor = new ServerSupervisor();
		supervisor.registerExternal(rec("ext-1"), "working", 1000);
		expect(supervisor.listExternalInstances(1000 + 20_000)).toEqual([]);
	});

	it("keeps an external instance just within the TTL", () => {
		const supervisor = new ServerSupervisor();
		supervisor.registerExternal(rec("ext-1"), "idle", 1000);
		expect(supervisor.listExternalInstances(1000 + 14_000).length).toBe(1);
	});

	it("unregister removes it", () => {
		const supervisor = new ServerSupervisor();
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
		const supervisor = new ServerSupervisor();
		supervisor.registerExternal(rec("ext-1"), "working", 0);
		// misses at t=5000,10000,15000 — a query landing exactly at the 3rd miss's own tick.
		expect(supervisor.listExternalInstances(3 * OLD_HEARTBEAT_MS).length).toBe(1);
		// ...but a query even 1ms later reaps it — this IS the "no margin" bug: any other
		// FleetView's routine 1s list() poll landing microseconds after drops the row.
		expect(supervisor.listExternalInstances(3 * OLD_HEARTBEAT_MS + 1)).toEqual([]);
	});

	it("at the current 3000ms cadence, 4 consecutive misses are still safely inside the TTL", () => {
		const supervisor = new ServerSupervisor();
		supervisor.registerExternal(rec("ext-1"), "working", 0);
		expect(supervisor.listExternalInstances(4 * HEARTBEAT_MS).length).toBe(1); // 12000 < 15000
	});

	it("reaping now needs a 5th consecutive miss, not a 3rd", () => {
		const supervisor = new ServerSupervisor();
		supervisor.registerExternal(rec("ext-1"), "working", 0);
		expect(supervisor.listExternalInstances(5 * HEARTBEAT_MS + 1)).toEqual([]); // past the 15000ms boundary
	});
});

describe("waiting for a pane's next message", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("wakes when a message is queued, leaving it for the pane's next register to drain", async () => {
		const supervisor = new ServerSupervisor();
		supervisor.registerExternal(rec("ext-1"), "idle");
		const waiting = supervisor.waitExternal("ext-1", 25_000);
		supervisor.sendExternal("ext-1", { type: "prompt", text: "hi" });
		await expect(waiting).resolves.toBe("queued");
		expect(supervisor.drainExternal("ext-1")).toEqual([{ type: "prompt", text: "hi" }]);
	});

	it("wakes at once when something is already queued", async () => {
		const supervisor = new ServerSupervisor();
		supervisor.registerExternal(rec("ext-1"), "idle");
		supervisor.sendExternal("ext-1", { type: "abort" });
		await expect(supervisor.waitExternal("ext-1", 25_000)).resolves.toBe("queued");
	});

	it("is refused for a pane that is not registered", () => {
		expect(new ServerSupervisor().waitExternal("ext-1", 25_000)).toBeUndefined();
	});

	it("answers false once the time is up with nothing queued", async () => {
		vi.useFakeTimers();
		const supervisor = new ServerSupervisor();
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
		supervisor.sendExternal("ext-1", { type: "abort" });
		expect(supervisor.drainExternal("ext-1")).toEqual([{ type: "abort" }]);
	});

	it("keeps one wait per pane: a newer one settles the older, as across a pane's reload", async () => {
		const supervisor = new ServerSupervisor();
		supervisor.registerExternal(rec("ext-1"), "idle");
		const older = supervisor.waitExternal("ext-1", 25_000);
		const newer = supervisor.waitExternal("ext-1", 25_000);
		await expect(older).resolves.toBe("superseded");
		supervisor.sendExternal("ext-1", { type: "abort" });
		await expect(newer).resolves.toBe("queued");
	});

	it("settles a pane's wait when it unregisters or its row is deleted", async () => {
		const supervisor = new ServerSupervisor();
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
		const supervisor = new ServerSupervisor();
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
		const supervisor = new ServerSupervisor();
		supervisor.registerExternal(rec("ext-1"), "idle");
		supervisor.registerExternal(rec("ext-2"), "idle");
		const waits = [supervisor.waitExternal("ext-1", 25_000), supervisor.waitExternal("ext-2", 25_000)];
		supervisor.settleWaits();
		await expect(Promise.all(waits)).resolves.toEqual(["none", "none"]);
	});
});
