import { describe, expect, it } from "vitest";
import { Notifier } from "../daemon/remote/notifier.ts";
import type { RemoteSession } from "../daemon/remote/sessions.ts";

const session = (id: string, state: RemoteSession["state"], detail = ""): RemoteSession => ({
	id,
	label: `task ${id}`,
	cwd: "/p",
	band: state === "working" ? "working" : state === "needs" ? "needs" : "idle",
	state,
	alive: true,
	resumable: false,
	detail,
});

describe("notifier", () => {
	it("notifies once when a session stops working, never on first sight", () => {
		const notifier = new Notifier();
		expect(notifier.observe([session("a", "working"), session("b", "done", "all good")])).toEqual([]);
		expect(notifier.observe([session("a", "working"), session("b", "done", "all good")])).toEqual([]);
		expect(notifier.observe([session("a", "needs", "Allow bash?"), session("b", "done")])).toEqual([
			{ title: "task a", body: "Needs input — Allow bash?", sessionId: "a" },
		]);
		expect(notifier.observe([session("a", "needs", "Allow bash?")])).toEqual([]);
	});

	it("notifies when an idle session comes to need input, but not when that answer settles it again", () => {
		const notifier = new Notifier();
		notifier.observe([session("a", "idle"), session("b", "done"), session("c", "needs")]);
		expect(
			notifier.observe([
				session("a", "needs", "Waiting: Allow bash?"),
				session("b", "needs"),
				session("c", "needs"),
			]),
		).toEqual([
			{ title: "task a", body: "Needs input — Waiting: Allow bash?", sessionId: "a" },
			{ title: "task b", body: "Needs input", sessionId: "b" },
		]);
		expect(notifier.observe([session("a", "idle"), session("b", "done"), session("c", "idle")])).toEqual([]);
	});

	it("says Done, Failed or Needs input, with the detail when there is one", () => {
		const notifier = new Notifier();
		const ids = ["a", "b", "c", "d", "e"];
		notifier.observe(ids.map((id) => session(id, "working")));
		const out = notifier.observe([
			session("a", "done", "Fixed the build"),
			session("b", "failed", "exit 1 — boom"),
			session("c", "idle"),
			session("d", "needs"),
			session("e", "stopped", "stopped"),
		]);
		expect(out.map((n) => [n.sessionId, n.body])).toEqual([
			["a", "Done — Fixed the build"],
			["b", "Failed — exit 1 — boom"],
			["c", "Done"],
			["d", "Needs input"],
		]);
	});

	it("notifies a turn too quick for any poll to see it working", () => {
		const notifier = new Notifier();
		notifier.observe([{ ...session("a", "done", "hi"), settled: 1 }]);
		expect(notifier.observe([{ ...session("a", "done", "hello"), settled: 1 }])).toEqual([]);
		expect(notifier.observe([{ ...session("a", "done", "hello"), settled: 2 }])).toEqual([
			{ title: "task a", body: "Done — hello", sessionId: "a" },
		]);
	});

	it("notifies a new session whose first turn ended before any look, but not on the very first look", () => {
		const notifier = new Notifier();
		expect(notifier.observe([{ ...session("a", "done"), settled: 2 }])).toEqual([]);
		expect(
			notifier.observe([
				{ ...session("a", "done"), settled: 2 },
				{ ...session("b", "done", "hi"), settled: 1 },
			]),
		).toEqual([{ title: "task b", body: "Done — hi", sessionId: "b" }]);
		expect(notifier.observe([{ ...session("c", "done"), settled: 0 }])).toEqual([]);
	});

	it("keeps the body short", () => {
		const notifier = new Notifier();
		notifier.observe([session("a", "working")]);
		const [note] = notifier.observe([session("a", "done", "x".repeat(500))]);
		expect(note.body).toHaveLength(120);
		expect(note.body.endsWith("…")).toBe(true);
	});

	it("keeps the title short", () => {
		const notifier = new Notifier();
		const long = { ...session("a", "working"), label: "t".repeat(200) };
		notifier.observe([long]);
		const [note] = notifier.observe([{ ...long, state: "done" }]);
		expect(note.title).toHaveLength(60);
		expect(note.title.endsWith("…")).toBe(true);
	});

	it("notifies again for each new turn, and forgets a session that disappeared", () => {
		const notifier = new Notifier();
		notifier.observe([session("a", "working")]);
		expect(notifier.observe([session("a", "idle")])).toHaveLength(1);
		notifier.observe([session("a", "working")]);
		expect(notifier.observe([session("a", "idle")])).toHaveLength(1);
		notifier.observe([session("a", "working")]);
		notifier.observe([]);
		expect(notifier.observe([session("a", "idle")])).toEqual([]);
	});
});
