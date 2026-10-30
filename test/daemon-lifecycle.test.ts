import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadInstances, saveInstances } from "../daemon/storage.ts";
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

		const saved = supervisor.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file });
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
		expect(supervisor.saveInstance({ cwd: "/p", sessionFile: "/nonexistent/b.jsonl" }).pinned).toBeUndefined();

		// Saved before its unregister lands: a quitting pane does not wait for it.
		supervisor.registerExternal({ ...pane, id: "pi-c", sessionFile: "/nonexistent/c.jsonl" }, "idle");
		supervisor.setInstanceMeta("pi-c", { pinned: true });
		expect(supervisor.saveInstance({ cwd: "/p", sessionFile: "/nonexistent/c.jsonl" }).pinned).toBe(true);
	});

	it("a stored row's pin carries over to the pane resuming it, deleted before or after it registers", () => {
		const supervisor = testRegistry(dir);
		const pane = { status: "online" as const, cwd: "/p", createdAt: new Date().toISOString() };
		const pinnedRow = (file: string) => {
			const saved = supervisor.saveInstance({ cwd: "/p", sessionFile: file });
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

		// The phone: the stored row goes once its pane registered.
		const phoneRow = pinnedRow("/nonexistent/phone.jsonl");
		supervisor.registerExternal({ ...pane, id: "pi-phone", sessionFile: "/nonexistent/phone.jsonl" }, "idle");
		supervisor.deleteInstance(phoneRow);
		supervisor.registerExternal({ ...pane, id: "pi-phone", sessionFile: "/nonexistent/phone.jsonl" }, "idle");
		expect(listed("pi-phone")).toMatchObject({ pinned: true, sortOrder: 3 });
		expect(loadInstances(dir)).toEqual([]);
	});

	it("rename and delete act on a stored row; the session file stays", () => {
		const supervisor = testRegistry(dir);
		const saved = supervisor.saveInstance({ cwd: "/p", sessionFile: "/nonexistent/s.jsonl" });
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
