import { describe, expect, it } from "vitest";
import { ageAt, successor } from "../daemon/remote/web/list.js";

const row = (id: string, state: string, more: Record<string, unknown> = {}) => ({
	id,
	label: id,
	cwd: "/p",
	band: state === "needs" || state === "working" ? state : "idle",
	state,
	alive: true,
	resumable: false,
	detail: "",
	...more,
});
const createdAt = "2026-10-15T10:00:00.000Z";
const finishedAt = "2026-10-15T11:00:00.000Z";

describe("a row's age on the phone", () => {
	it("counts from its last entry once it is quiet", () => {
		for (const state of ["idle", "done", "failed", "stopped"]) {
			expect(ageAt(row("a", state, { createdAt, finishedAt })), state).toBe(finishedAt);
		}
		// A pinned row is in the pinned band, and quiet all the same.
		expect(ageAt(row("a", "idle", { band: "pinned", createdAt, finishedAt }))).toBe(finishedAt);
	});

	it("counts from its start while it works or waits on an answer", () => {
		expect(ageAt(row("a", "working", { createdAt, finishedAt }))).toBe(createdAt);
		expect(ageAt(row("a", "needs", { createdAt, finishedAt }))).toBe(createdAt);
	});

	it("falls back on its start, and on nothing", () => {
		expect(ageAt(row("a", "idle", { createdAt }))).toBe(createdAt);
		expect(ageAt(row("a", "idle"))).toBeUndefined();
	});
});

describe("an open chat whose row is gone", () => {
	const sessions = [row("pi-2", "idle", { sessionId: "s1" }), row("pi-3", "idle", { sessionId: "s2" })];

	it("moves to the row with the same pi session", () => {
		expect(successor(sessions, "pi-1", "s1")).toBe("pi-2");
	});

	it("stays while its own row is listed", () => {
		expect(successor([...sessions, row("pi-1", "idle", { sessionId: "s1" })], "pi-1", "s1")).toBeUndefined();
	});

	it("stays when no row has its session, or its session is not known", () => {
		expect(successor(sessions, "pi-1", "s9")).toBeUndefined();
		expect(successor(sessions, "pi-1", undefined)).toBeUndefined();
		expect(successor([row("pi-4", "idle")], "pi-1", undefined)).toBeUndefined();
	});
});
