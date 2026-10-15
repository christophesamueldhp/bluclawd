import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadInstances, saveInstances } from "../daemon/storage.ts";
import { ServerSupervisor } from "../daemon/supervisor.ts";

describe("agent-view stored rows", () => {
	let prevEnv: string | undefined;

	beforeEach(() => {
		prevEnv = process.env.PI_SERVER_DIR;
		process.env.PI_SERVER_DIR = mkdtempSync(join(tmpdir(), "bluclawd-lifecycle-"));
	});

	afterEach(() => {
		if (prevEnv === undefined) delete process.env.PI_SERVER_DIR;
		else process.env.PI_SERVER_DIR = prevEnv;
	});

	it("save lists a session as a row without starting it, reusing a row it already has", () => {
		const dir = mkdtempSync(join(tmpdir(), "bluclawd-save-"));
		const file = join(dir, "s.jsonl");
		const reply = { role: "assistant", content: [{ type: "text", text: "tests pass" }], stopReason: "stop" };
		writeFileSync(file, `${JSON.stringify({ type: "message", message: reply })}\n`);
		const supervisor = new ServerSupervisor();

		const saved = supervisor.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file });
		expect(loadInstances()).toEqual([
			expect.objectContaining({ id: saved.id, status: "stopped", outcome: "done", detail: "tests pass" }),
		]);

		supervisor.setInstanceMeta(saved.id, { pinned: true });
		const again = supervisor.saveInstance({ cwd: "/p", label: "other", sessionFile: file });
		expect(again).toMatchObject({ id: saved.id, label: "fix tests", pinned: true });
		expect(loadInstances()).toHaveLength(1);
	});

	it("a pane's pin carries over to its stored row once its pi quits", () => {
		const supervisor = new ServerSupervisor();
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
		expect(supervisor.saveInstance({ cwd: "/p", sessionFile: "/nonexistent/b.jsonl" }).pinned).toBeUndefined();

		// Saved before its unregister lands: a quitting pane does not wait for it.
		supervisor.registerExternal({ ...pane, id: "pi-c", sessionFile: "/nonexistent/c.jsonl" }, "idle");
		supervisor.setInstanceMeta("pi-c", { pinned: true });
		expect(supervisor.saveInstance({ cwd: "/p", sessionFile: "/nonexistent/c.jsonl" }).pinned).toBe(true);
	});

	it("rename and delete act on a stored row; the session file stays", () => {
		const supervisor = new ServerSupervisor();
		const saved = supervisor.saveInstance({ cwd: "/p", sessionFile: "/nonexistent/s.jsonl" });
		expect(supervisor.renameInstance(saved.id, "renamed")).toMatchObject({ label: "renamed" });
		expect(supervisor.deleteInstance(saved.id)).toBe(true);
		expect(loadInstances()).toEqual([]);
		expect(supervisor.deleteInstance(saved.id)).toBe(false);
	});

	it("rows an older daemon left running come back stopped after a restart", () => {
		saveInstances([{ id: "old", status: "online", cwd: "/p", createdAt: new Date().toISOString() }]);
		new ServerSupervisor().recoverAfterRestart();
		expect(loadInstances()[0]).toMatchObject({ status: "stopped", outcome: "stopped" });
	});
});
