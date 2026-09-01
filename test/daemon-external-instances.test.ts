import { describe, expect, it } from "vitest";
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
		expect(supervisor.getActivity("ext-1")).toBe("working");
	});

	it("heartbeat (re-register) updates activity and keeps it alive", () => {
		const supervisor = new ServerSupervisor();
		supervisor.registerExternal(rec("ext-1"), "working", 1000);
		supervisor.registerExternal(rec("ext-1"), "idle", 10_000);
		expect(supervisor.getActivity("ext-1")).toBe("idle");
		expect(supervisor.listExternalInstances(10_000).length).toBe(1);
	});

	it("reaps an external instance whose heartbeat is past the TTL", () => {
		const supervisor = new ServerSupervisor();
		supervisor.registerExternal(rec("ext-1"), "working", 1000);
		expect(supervisor.listExternalInstances(1000 + 20_000)).toEqual([]);
		expect(supervisor.getActivity("ext-1")).toBeUndefined();
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
 * The client's own heartbeat cadence (`HEARTBEAT_MS`, `ext/fleet/self-registration.ts` —
 * a different file, no shared module to import from) times out against THIS
 * module's TTL. Mirrored here as a literal, matching the fork branch's existing
 * precedent for documented cross-module duplication rather than a real import.
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
