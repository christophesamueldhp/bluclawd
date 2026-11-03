import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { listSummaries } from "../daemon/handler.ts";
import { loadInstances, saveInstances } from "../daemon/storage.ts";
import type { ServerSupervisor } from "../daemon/supervisor.ts";
import { testRegistry } from "./helpers/registry.ts";

describe("agent-view stored rows", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-lifecycle-"));
	});

	it("save lists a session as a row without starting it, reusing a row it already has", () => {
		const sessions = mkdtempSync(join(tmpdir(), "bluclawd-save-"));
		const file = join(sessions, "s.jsonl");
		const reply = { role: "assistant", content: [{ type: "text", text: "tests pass" }], stopReason: "stop" };
		writeFileSync(file, `${JSON.stringify({ type: "message", message: reply })}\n`);
		const supervisor = testRegistry(dir);

		const saved = supervisor.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file })!;
		expect(loadInstances(dir)).toEqual([
			expect.objectContaining({ id: saved.id, status: "stopped", outcome: "done", detail: "tests pass" }),
		]);

		supervisor.setInstanceMeta(saved.id, { pinned: true });
		const again = supervisor.saveInstance({ cwd: "/p", label: "other", sessionFile: file });
		expect(again).toMatchObject({ id: saved.id, label: "fix tests", pinned: true });
		expect(loadInstances(dir)).toHaveLength(1);
	});

	it("a pane's pin carries over to its stored row once its pi quits", () => {
		const supervisor = testRegistry(dir);
		const pane = { status: "online" as const, cwd: "/p", createdAt: new Date().toISOString() };
		supervisor.registerExternal({ ...pane, id: "pi-a", sessionFile: "/nonexistent/a.jsonl" }, "idle");
		supervisor.setInstanceMeta("pi-a", { pinned: true, sortOrder: 2 });
		supervisor.registerExternal({ ...pane, id: "pi-b", sessionFile: "/nonexistent/b.jsonl" }, "idle");
		supervisor.unregisterExternal("pi-a");
		supervisor.unregisterExternal("pi-b");

		expect(supervisor.saveInstance({ cwd: "/p", sessionFile: "/nonexistent/a.jsonl" })).toMatchObject({
			pinned: true,
			sortOrder: 2,
		});
		expect(supervisor.saveInstance({ cwd: "/p", sessionFile: "/nonexistent/b.jsonl" })?.pinned).toBeUndefined();

		// Saved before its unregister lands: a quitting pane does not wait for it.
		supervisor.registerExternal({ ...pane, id: "pi-c", sessionFile: "/nonexistent/c.jsonl" }, "idle");
		supervisor.setInstanceMeta("pi-c", { pinned: true });
		expect(supervisor.saveInstance({ cwd: "/p", sessionFile: "/nonexistent/c.jsonl" })?.pinned).toBe(true);
	});

	it("a stored row's pin carries over to the pane resuming it, deleted before it registers or not at all", () => {
		const supervisor = testRegistry(dir);
		const pane = { status: "online" as const, cwd: "/p", createdAt: new Date().toISOString() };
		const pinnedRow = (file: string) => {
			const saved = supervisor.saveInstance({ cwd: "/p", sessionFile: file })!;
			supervisor.setInstanceMeta(saved.id, { pinned: true, sortOrder: 3 });
			return saved.id;
		};
		const listed = (id: string) => supervisor.listExternalInstances().find((e) => e.record.id === id)?.record;

		// Agent view: the stored row goes as soon as its pane starts, before that pane registers.
		supervisor.deleteInstance(pinnedRow("/nonexistent/mac.jsonl"));
		supervisor.registerExternal({ ...pane, id: "pi-other", sessionFile: "/nonexistent/other.jsonl" }, "idle");
		supervisor.registerExternal({ ...pane, id: "pi-mac", sessionFile: "/nonexistent/mac.jsonl" }, "idle");
		supervisor.registerExternal({ ...pane, id: "pi-mac", sessionFile: "/nonexistent/mac.jsonl" }, "idle");
		expect(listed("pi-mac")).toMatchObject({ pinned: true, sortOrder: 3 });
		expect(listed("pi-other")?.pinned).toBeUndefined();
		// Carried once: a later pane on that file is not pinned again.
		supervisor.unregisterExternal("pi-mac");
		supervisor.registerExternal({ ...pane, id: "pi-mac-2", sessionFile: "/nonexistent/mac.jsonl" }, "idle");
		expect(listed("pi-mac-2")?.pinned).toBeUndefined();

		// The phone deletes nothing: its pane goes on as the stored row, which is not listed beside it.
		const phoneRow = pinnedRow("/nonexistent/phone.jsonl");
		supervisor.registerExternal({ ...pane, id: "pi-phone", sessionFile: "/nonexistent/phone.jsonl" }, "idle");
		supervisor.registerExternal({ ...pane, id: "pi-phone", sessionFile: "/nonexistent/phone.jsonl" }, "idle");
		expect(listed(phoneRow)).toMatchObject({ pinned: true, sortOrder: 3 });
		expect(supervisor.listInstances().filter((i) => i.sessionFile === "/nonexistent/phone.jsonl")).toEqual([]);
	});

	it("rename and delete act on a stored row; the session file stays", () => {
		const supervisor = testRegistry(dir);
		const saved = supervisor.saveInstance({ cwd: "/p", sessionFile: "/nonexistent/s.jsonl" })!;
		expect(supervisor.renameInstance(saved.id, "renamed")).toMatchObject({ label: "renamed" });
		expect(supervisor.deleteInstance(saved.id)).toBe(true);
		expect(loadInstances(dir)).toEqual([]);
		expect(supervisor.deleteInstance(saved.id)).toBe(false);
	});

	it("keeps its rows in its own storage dir, stamped by its clock", () => {
		const now = () => Date.parse("2026-10-30T12:00:00.000Z");
		testRegistry(dir, now).saveInstance({ cwd: "/p", sessionFile: "/nonexistent/s.jsonl" });

		expect(testRegistry(dir).listInstances()).toEqual([
			expect.objectContaining({ status: "stopped", finishedAt: "2026-10-30T12:00:00.000Z" }),
		]);
		expect(testRegistry().listInstances()).toEqual([]);
	});

	it("rows an older daemon left running come back stopped after a restart", () => {
		saveInstances(dir, [{ id: "old", status: "online", cwd: "/p", createdAt: new Date().toISOString() }]);
		testRegistry(dir).recoverAfterRestart();
		expect(loadInstances(dir)[0]).toMatchObject({ status: "stopped", outcome: "stopped" });
	});
});

describe("one row per session through quit and resume", () => {
	let dir: string;
	let file: string;
	const createdAt = "2026-10-30T09:00:00.000Z";
	const pane = (id: string) => ({
		id,
		status: "online" as const,
		cwd: "/p",
		createdAt,
		label: "fix tests",
		sessionFile: file,
		pane: id,
	});
	/** What every reader lists: the rows of this session file. */
	const rows = (supervisor: ServerSupervisor) => listSummaries(supervisor).filter((i) => i.sessionFile === file);

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-one-row-"));
		file = join(mkdtempSync(join(tmpdir(), "bluclawd-one-row-session-")), "s.jsonl");
		const reply = { role: "assistant", content: [{ type: "text", text: "tests pass" }], stopReason: "stop" };
		writeFileSync(file, `${JSON.stringify({ type: "message", message: reply })}\n`);
	});

	it("register → quit → stopped → resume → live is one row with the same id, pin, order, name and age", () => {
		const supervisor = testRegistry(dir);
		const same = { label: "fix tests", createdAt, pinned: true, sortOrder: 4 };

		supervisor.registerExternal(pane("pi-a"), "idle");
		supervisor.setInstanceMeta("pi-a", { pinned: true, sortOrder: 4 });
		expect(rows(supervisor)).toEqual([expect.objectContaining({ ...same, id: "pi-a", external: true })]);

		supervisor.unregisterExternal("pi-a", "quit");
		expect(rows(supervisor)).toEqual([
			expect.objectContaining({ ...same, id: "pi-a", status: "stopped", external: undefined }),
		]);

		// The hand-off helper's save, once pi's writes are final.
		supervisor.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file });
		expect(rows(supervisor)).toEqual([
			expect.objectContaining({ ...same, id: "pi-a", status: "stopped", outcome: "done", detail: "tests pass" }),
		]);

		// Resumed in another pane.
		supervisor.registerExternal(pane("pi-b"), "working");
		expect(rows(supervisor)).toEqual([
			expect.objectContaining({ ...same, id: "pi-a", external: true, activity: "working", pane: "pi-b" }),
		]);
	});

	it("a quit whose unregister is lost is one stopped row once hand-off saves, through the TTL window", () => {
		let now = Date.parse("2026-10-30T10:00:00.000Z");
		const supervisor = testRegistry(dir, () => now);
		supervisor.registerExternal(pane("pi-a"), "idle");
		supervisor.setInstanceMeta("pi-a", { pinned: true });

		now += 100;
		supervisor.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file });
		const stopped = expect.objectContaining({ id: "pi-a", status: "stopped", pinned: true, createdAt });
		expect(rows(supervisor)).toEqual([stopped]);
		now += 20_000;
		expect(rows(supervisor)).toEqual([stopped]);
	});

	it("a pane of an older build, with no reason, drops its row as before; its hand-off save brings it back", () => {
		const supervisor = testRegistry(dir);
		supervisor.registerExternal(pane("pi-a"), "idle");
		supervisor.setInstanceMeta("pi-a", { pinned: true, sortOrder: 1 });

		supervisor.unregisterExternal("pi-a");
		expect(rows(supervisor)).toEqual([]);
		supervisor.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file });
		expect(rows(supervisor)).toEqual([
			expect.objectContaining({ id: "pi-a", status: "stopped", pinned: true, sortOrder: 1, createdAt }),
		]);
	});

	it("a stopped row deleted before its hand-off saves stays deleted", () => {
		const supervisor = testRegistry(dir);
		supervisor.registerExternal(pane("pi-a"), "idle");
		supervisor.unregisterExternal("pi-a", "quit");
		expect(supervisor.deleteInstance("pi-a")).toBe(true);

		expect(supervisor.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file })).toBeUndefined();
		expect(rows(supervisor)).toEqual([]);
		expect(loadInstances(dir)).toEqual([]);

		// Quit again once resumed, its save keeps it.
		supervisor.registerExternal(pane("pi-b"), "idle");
		supervisor.unregisterExternal("pi-b", "quit");
		supervisor.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file });
		expect(rows(supervisor)).toEqual([expect.objectContaining({ id: "pi-b", status: "stopped" })]);
	});

	it("a quit before the session has a file leaves no row", () => {
		const supervisor = testRegistry(dir);
		supervisor.registerExternal({ ...pane("pi-a"), sessionFile: join(dir, "unwritten.jsonl") }, "idle");
		supervisor.unregisterExternal("pi-a", "quit");
		expect(listSummaries(supervisor)).toEqual([]);
	});

	it("messages and waits go to the pane a resumed row runs in; its row is addressed by the row's id", async () => {
		const supervisor = testRegistry(dir);
		supervisor.registerExternal(pane("pi-a"), "idle");
		supervisor.unregisterExternal("pi-a", "quit");
		supervisor.registerExternal(pane("pi-b"), "idle");

		const waiting = supervisor.waitExternal("pi-b", 5_000);
		expect(supervisor.sendExternal("pi-a", { type: "prompt", text: "hi" })).toBe(true);
		await expect(waiting).resolves.toBe("queued");
		expect(supervisor.drainExternal("pi-b")).toEqual([{ type: "prompt", text: "hi" }]);
		expect(supervisor.waitExternal("pi-a", 10)).toBeUndefined();

		supervisor.setInstanceMeta("pi-a", { sortOrder: 7 });
		expect(rows(supervisor)).toEqual([expect.objectContaining({ id: "pi-a", sortOrder: 7, pane: "pi-b" })]);
		// Deleting it removes the session's row, not only its pane.
		expect(supervisor.deleteInstance("pi-a")).toBe(true);
		expect(rows(supervisor)).toEqual([]);
		expect(loadInstances(dir)).toEqual([]);
	});
});
