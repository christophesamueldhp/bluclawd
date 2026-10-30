// test/remote-sessions.test.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIpcRequest, listSummaries } from "../daemon/handler.ts";
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
		expect(sessions[1]).toMatchObject({ detail: "npm test", alive: true, state: "working" });
		expect(sessions[2].label).toBe("idle one");
	});

	it("carries how many times each session stopped working", () => {
		expect(remoteSessions([live("a", "idle", { settled: 3 })])[0].settled).toBe(3);
	});

	it("lists both panes running one session file, each saying how many share it", () => {
		const sessions = remoteSessions([
			live("a", "idle", { sessionFile: "/s/x.jsonl" }),
			live("b", "idle", { sessionFile: "/s/x.jsonl" }),
			live("c", "idle"),
		]);
		expect(sessions.map((s) => [s.id, s.livePanes]).sort()).toEqual([
			["a", 2],
			["b", 2],
			["c", undefined],
		]);
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
		expect(remoteSessions([stored])[0]).toMatchObject({ id: "old", alive: false, band: "idle" });
		const { sessionFile: _, ...fileless } = stored;
		expect(remoteSessions([fileless])[0]).toMatchObject({ id: "old", alive: false });
		expect(remoteSessions([stored, live("new", "idle", { sessionFile: "/s/x.jsonl" })]).map((s) => s.id)).toEqual([
			"new",
		]);
	});

	it("finds a session's file, whether a pane runs it and whether it is mid-turn", () => {
		const stored: InstanceSummary = { id: "old", status: "stopped", cwd: "/p", sessionFile: "/s/old.jsonl" };
		const list = [stored, live("b", "idle", { leafId: "e3" }), live("c", "working"), live("d", "awaiting_input")];
		expect(findSession(list, "b")).toEqual({
			sessionFile: "/s/b.jsonl",
			cwd: "/p",
			running: true,
			busy: false,
			leafId: "e3",
		});
		expect(findSession(list, "c")).toMatchObject({ running: true, busy: true });
		expect(findSession(list, "d")).toMatchObject({ running: true, busy: true });
		expect(findSession(list, "old")).toEqual({
			sessionFile: "/s/old.jsonl",
			cwd: "/p",
			running: false,
			busy: false,
		});
		expect(findSession(list, "zzz")).toBeUndefined();
	});
});

describe("remote sessions through the daemon", () => {
	beforeEach(() => vi.stubEnv("PI_SERVER_DIR", mkdtempSync(join(tmpdir(), "bluclawd-remote-sessions-"))));
	afterEach(() => vi.useRealTimers());

	it("keeps idle panes in the order their last turns ended, whichever heartbeat came last", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const beat = (id: string, finishedAt: string) =>
			handleIpcRequest({
				type: "register",
				instance: { id, cwd: "/p", activity: "idle", turns: 1, sessionFile: `/s/${id}.jsonl`, finishedAt },
			});
		const order = () => remoteSessions(listSummaries()).map((s) => [s.id, s.finishedAt]);
		try {
			vi.setSystemTime(Date.parse("2026-10-15T10:00:00Z"));
			await beat("pi-older", "2026-10-15T09:00:00.000Z");
			vi.setSystemTime(Date.parse("2026-10-15T10:00:01Z"));
			await beat("pi-newer", "2026-10-15T09:30:00.000Z");
			const expected = [
				["pi-newer", "2026-10-15T09:30:00.000Z"],
				["pi-older", "2026-10-15T09:00:00.000Z"],
			];
			expect(order()).toEqual(expected);
			// The older one's heartbeat is now the latest: its row stays where its last turn put it.
			vi.setSystemTime(Date.parse("2026-10-15T10:00:03Z"));
			await beat("pi-older", "2026-10-15T09:00:00.000Z");
			expect(order()).toEqual(expected);
		} finally {
			await handleIpcRequest({ type: "unregister", instanceId: "pi-older" });
			await handleIpcRequest({ type: "unregister", instanceId: "pi-newer" });
		}
	});

	it("gives each session pi's session id, a pane's and a quit one's stored row alike", async () => {
		await handleIpcRequest({
			type: "register",
			instance: { id: "pi-a", cwd: "/p", sessionId: "uuid-a", sessionFile: "/s/a.jsonl" },
		});
		await handleIpcRequest({ type: "save", cwd: "/p", sessionFile: "/s/b.jsonl", sessionId: "uuid-b" });
		try {
			expect(remoteSessions(listSummaries()).map((s) => [s.alive, s.sessionId])).toEqual(
				expect.arrayContaining([
					[true, "uuid-a"],
					[false, "uuid-b"],
				]),
			);
		} finally {
			await handleIpcRequest({ type: "unregister", instanceId: "pi-a" });
		}
	});

	it("says which dialog a session waits on, only while it needs input", async () => {
		const dialog = { kind: "confirm", title: "Allow bash?" };
		const beat = (activity: "awaiting_input" | "working") =>
			handleIpcRequest({
				type: "register",
				instance: { id: "pi-d", cwd: "/p", activity, dialog, detail: "Waiting: Allow bash?" },
			});
		try {
			await beat("awaiting_input");
			expect(remoteSessions(listSummaries())[0]).toMatchObject({
				state: "needs",
				detail: "Waiting: Allow bash?",
				dialog,
			});
			await beat("working");
			expect(remoteSessions(listSummaries())[0]).not.toHaveProperty("dialog");
		} finally {
			await handleIpcRequest({ type: "unregister", instanceId: "pi-d" });
		}
	});
});
