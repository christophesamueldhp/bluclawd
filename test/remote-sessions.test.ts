// test/remote-sessions.test.ts
import { describe, expect, it } from "vitest";
import type { InstanceSummary } from "../daemon/ipc/protocol.ts";
import { findSession, remoteSessions } from "../daemon/remote/sessions.ts";

const live = (
	id: string,
	activity: InstanceSummary["activity"],
	extra: Partial<InstanceSummary> = {},
): InstanceSummary => ({
	id,
	status: "online",
	cwd: "/p",
	external: true,
	activity,
	createdAt: "2026-10-12T00:00:00Z",
	sessionFile: `/s/${id}.jsonl`,
	...extra,
});

describe("remote sessions", () => {
	it("groups rows into agent view's bands, Needs input first", () => {
		const sessions = remoteSessions([
			live("a", "idle", { label: "idle one" }),
			live("b", "working", { detail: "npm test" }),
			live("c", "awaiting_input"),
		]);
		expect(sessions.map((s) => [s.id, s.band])).toEqual([
			["c", "needs"],
			["b", "working"],
			["a", "idle"],
		]);
		expect(sessions[1]).toMatchObject({ detail: "npm test", alive: true, resumable: false, state: "working" });
		expect(sessions[2].label).toBe("idle one");
	});

	it("puts pinned rows in their own band, first", () => {
		const sessions = remoteSessions([live("a", "working"), live("p", "idle", { pinned: true })]);
		expect(sessions.map((s) => [s.id, s.band])).toEqual([
			["p", "pinned"],
			["a", "working"],
		]);
	});

	it("lists a stored row as not alive, and its live twin instead when both exist", () => {
		const stored: InstanceSummary = {
			id: "old",
			status: "stopped",
			cwd: "/p",
			sessionFile: "/s/x.jsonl",
			outcome: "done",
		};
		expect(remoteSessions([stored])[0]).toMatchObject({ id: "old", alive: false, resumable: true, band: "idle" });
		const { sessionFile: _, ...fileless } = stored;
		expect(remoteSessions([fileless])[0]).toMatchObject({ id: "old", alive: false, resumable: false });
		expect(remoteSessions([stored, live("new", "idle", { sessionFile: "/s/x.jsonl" })]).map((s) => s.id)).toEqual([
			"new",
		]);
	});

	it("finds a session's file and whether a pane runs it", () => {
		const stored: InstanceSummary = { id: "old", status: "stopped", cwd: "/p", sessionFile: "/s/old.jsonl" };
		const list = [stored, live("b", "idle", { leafId: "e3" })];
		expect(findSession(list, "b")).toEqual({ sessionFile: "/s/b.jsonl", cwd: "/p", running: true, leafId: "e3" });
		expect(findSession(list, "old")).toEqual({ sessionFile: "/s/old.jsonl", cwd: "/p", running: false });
		expect(findSession(list, "zzz")).toBeUndefined();
	});
});
