import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { handleIpcRequest, listSummaries } from "../daemon/handler.ts";
import { loadInstances, saveInstances } from "../daemon/storage.ts";
import { ServerSupervisor, START_MS } from "../daemon/supervisor.ts";
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
		expect(again).toMatchObject({ id: saved.id, label: "other", pinned: true });
		expect(loadInstances(dir)).toHaveLength(1);
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

	it("a pane of an older build, with no reason, leaves its stored row; its hand-off save keeps it", () => {
		const supervisor = testRegistry(dir);
		supervisor.registerExternal(pane("pi-a"), "idle");
		supervisor.setInstanceMeta("pi-a", { pinned: true, sortOrder: 1 });
		const stopped = { id: "pi-a", status: "stopped", pinned: true, sortOrder: 1, createdAt };

		supervisor.unregisterExternal("pi-a");
		expect(rows(supervisor)).toEqual([expect.objectContaining(stopped)]);
		supervisor.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file });
		expect(rows(supervisor)).toEqual([expect.objectContaining({ ...stopped, outcome: "done" })]);
	});

	it("a session left by /new drops its row, and no pin comes back to its file later", () => {
		const supervisor = testRegistry(dir);
		supervisor.registerExternal(pane("pi-a"), "idle");
		supervisor.setInstanceMeta("pi-a", { pinned: true, sortOrder: 1 });

		supervisor.unregisterExternal("pi-a", "new");
		expect(rows(supervisor)).toEqual([]);
		// Much later, the file is resumed elsewhere and saved with no pane listed on it.
		const saved = supervisor.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file });
		expect(saved).toMatchObject({ status: "stopped" });
		expect(saved?.pinned).toBeUndefined();
		expect(saved?.sortOrder).toBeUndefined();
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

	it("a name set in the pane wins over the stored row's older one, through quit and save", () => {
		const supervisor = testRegistry(dir);
		supervisor.registerExternal(pane("pi-a"), "idle");
		supervisor.unregisterExternal("pi-a", "quit");
		supervisor.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file });

		supervisor.registerExternal(pane("pi-b"), "idle");
		supervisor.registerExternal({ ...pane("pi-b"), label: "renamed" }, "idle");
		supervisor.unregisterExternal("pi-b", "quit");
		expect(rows(supervisor)).toEqual([expect.objectContaining({ id: "pi-a", label: "renamed" })]);
		supervisor.saveInstance({ cwd: "/p", label: "renamed", sessionFile: file });
		expect(rows(supervisor)).toEqual([expect.objectContaining({ id: "pi-a", label: "renamed" })]);

		// Renamed after its last heartbeat: its hand-off carries the name.
		supervisor.registerExternal({ ...pane("pi-c"), label: "renamed" }, "idle");
		supervisor.unregisterExternal("pi-c", "quit");
		supervisor.saveInstance({ cwd: "/p", label: "renamed again", sessionFile: file });
		expect(rows(supervisor)).toEqual([expect.objectContaining({ id: "pi-a", label: "renamed again" })]);
	});

	it("a name given to the stopped row survives a resume, a restart and a quit whose pane never renamed it", () => {
		const supervisor = testRegistry(dir);
		supervisor.registerExternal(pane("pi-a"), "idle");
		supervisor.unregisterExternal("pi-a", "quit");
		supervisor.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file });
		supervisor.renameInstance("pi-a", "my name");

		// Its pane restates the name pi derives from the first prompt.
		supervisor.registerExternal(pane("pi-b"), "idle");
		supervisor.registerExternal(pane("pi-b"), "idle");
		expect(rows(supervisor)).toEqual([expect.objectContaining({ id: "pi-a", label: "my name" })]);

		const after = testRegistry(dir);
		after.registerExternal(pane("pi-b"), "idle");
		expect(rows(after)).toEqual([expect.objectContaining({ id: "pi-a", label: "my name" })]);
		after.unregisterExternal("pi-b", "quit");
		after.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file });
		expect(rows(after)).toEqual([expect.objectContaining({ id: "pi-a", label: "my name" })]);
	});

	it("a pane that goes on to another session gets its own row, never the stored row of the one it left", () => {
		const supervisor = testRegistry(dir);
		supervisor.registerExternal(pane("pi-a"), "idle");
		supervisor.setInstanceMeta("pi-a", { pinned: true });
		// An older build: /new unregisters with no reason, and the pane registers again under its id.
		supervisor.unregisterExternal("pi-a");
		const next = join(dirname(file), "next.jsonl");
		writeFileSync(next, "");
		supervisor.registerExternal({ ...pane("pi-a"), label: "next", sessionFile: next }, "idle");

		expect(rows(supervisor)).toEqual([
			expect.objectContaining({ id: "pi-a", status: "stopped", label: "fix tests", pinned: true }),
		]);
		const listed = listSummaries(supervisor).find((i) => i.sessionFile === next);
		expect(listed).toMatchObject({ external: true, label: "next" });
		expect(listed?.id).not.toBe("pi-a");
		expect(listed?.pinned).toBeUndefined();
	});

	it("after a restart, a resumed session shows stopped, not how it ended before", () => {
		const before = testRegistry(dir);
		before.registerExternal(pane("pi-a"), "idle");
		before.unregisterExternal("pi-a", "quit");
		before.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file });
		before.registerExternal(pane("pi-b"), "working");

		const after = testRegistry(dir);
		after.recoverAfterRestart();
		expect(rows(after)).toEqual([expect.objectContaining({ id: "pi-a", status: "stopped", outcome: "stopped" })]);
	});

	it("a session's age is its header time, not when a stored row was first saved", () => {
		saveInstances(dir, [
			{ id: "old", status: "stopped", cwd: "/p", sessionFile: file, createdAt: "2026-10-30T11:00:00.000Z" },
		]);
		const supervisor = testRegistry(dir);
		supervisor.registerExternal(pane("pi-a"), "idle");
		supervisor.unregisterExternal("pi-a", "quit");
		supervisor.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file });
		expect(rows(supervisor)).toEqual([expect.objectContaining({ id: "old", createdAt })]);
	});

	it("a live row's pin and order survive a daemon restart, shown stopped until its pane's next heartbeat", () => {
		const before = testRegistry(dir);
		before.registerExternal(pane("pi-a"), "idle");
		before.setInstanceMeta("pi-a", { pinned: true, sortOrder: 5 });
		before.setInstanceMeta("pi-a", { sortOrder: 6 });

		const after = testRegistry(dir);
		after.recoverAfterRestart();
		const kept = { id: "pi-a", label: "fix tests", createdAt, pinned: true, sortOrder: 6 };
		expect(rows(after)).toEqual([expect.objectContaining({ ...kept, status: "stopped", external: undefined })]);

		after.registerExternal(pane("pi-a"), "working");
		expect(rows(after)).toEqual([expect.objectContaining({ ...kept, external: true, activity: "working" })]);
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

describe("a resume goes through the registry: starting, then live", () => {
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
	const rows = (supervisor: ServerSupervisor) => listSummaries(supervisor).filter((i) => i.sessionFile === file);

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-resume-"));
		file = join(mkdtempSync(join(tmpdir(), "bluclawd-resume-session-")), "s.jsonl");
		writeFileSync(file, "");
	});

	it("a stopped row resumed is listed as starting, with its id and pin, until its pane registers", () => {
		const supervisor = testRegistry(dir);
		const saved = supervisor.saveInstance({ cwd: "/p", label: "fix tests", sessionFile: file })!;
		supervisor.setInstanceMeta(saved.id, { pinned: true });

		expect(supervisor.claimStart({ cwd: "/p", sessionFile: file })).toEqual({ ok: true, id: saved.id });
		expect(rows(supervisor)).toEqual([expect.objectContaining({ id: saved.id, status: "starting", pinned: true })]);

		supervisor.registerExternal(pane("pi-b"), "idle");
		expect(rows(supervisor)).toEqual([
			expect.objectContaining({ id: saved.id, status: "online", external: true, pinned: true, pane: "pi-b" }),
		]);
	});

	it("a second resume of a starting row is refused; so is a resume of a live row", () => {
		const supervisor = testRegistry(dir);
		supervisor.saveInstance({ cwd: "/p", sessionFile: file });

		expect(supervisor.claimStart({ cwd: "/p", sessionFile: file })).toMatchObject({ ok: true });
		expect(supervisor.claimStart({ cwd: "/p", sessionFile: file })).toEqual({ ok: false, refused: "starting" });

		supervisor.registerExternal(pane("pi-b"), "idle");
		expect(supervisor.claimStart({ cwd: "/p", sessionFile: file })).toEqual({ ok: false, refused: "running" });
		expect(rows(supervisor)).toHaveLength(1);
	});

	it("a start whose pane never registers ends: the row is stopped again, and can be resumed", () => {
		let now = Date.parse("2026-10-30T10:00:00.000Z");
		const supervisor = testRegistry(dir, () => now);
		const saved = supervisor.saveInstance({ cwd: "/p", sessionFile: file })!;
		supervisor.claimStart({ cwd: "/p", sessionFile: file });

		now += START_MS + 1;
		expect(rows(supervisor)).toEqual([expect.objectContaining({ id: saved.id, status: "stopped" })]);
		expect(supervisor.claimStart({ cwd: "/p", sessionFile: file })).toEqual({ ok: true, id: saved.id });
	});

	it("a pane that could not be started leaves the row as it was at once", () => {
		const supervisor = testRegistry(dir);
		const saved = supervisor.saveInstance({ cwd: "/p", sessionFile: file })!;
		supervisor.claimStart({ cwd: "/p", sessionFile: file });
		supervisor.startFailed(saved.id);
		expect(rows(supervisor)).toEqual([expect.objectContaining({ id: saved.id, status: "stopped" })]);
	});

	it("a file with no row is listed as starting under a new id, which its pane goes on as", () => {
		const supervisor = testRegistry(dir);
		const claim = supervisor.claimStart({ cwd: "/p", label: "past", sessionFile: file });
		if (!claim.ok) throw new Error("refused");
		expect(rows(supervisor)).toEqual([
			expect.objectContaining({ id: claim.id, status: "starting", label: "past", cwd: "/p" }),
		]);
		supervisor.registerExternal(pane("pi-b"), "idle");
		expect(rows(supervisor)).toEqual([expect.objectContaining({ id: claim.id, status: "online", pane: "pi-b" })]);
	});

	it("a new session is listed as starting by its pane's id until that pane registers", () => {
		const supervisor = testRegistry(dir);
		supervisor.paneStarting({ cwd: "/p", label: "new task", pane: "pi-n" });
		expect(listSummaries(supervisor)).toEqual([
			expect.objectContaining({ id: "pi-n", status: "starting", label: "new task", pane: "pi-n" }),
		]);
		supervisor.registerExternal({ ...pane("pi-n"), sessionFile: join(dir, "new.jsonl") }, "working");
		expect(listSummaries(supervisor)).toEqual([expect.objectContaining({ id: "pi-n", status: "online" })]);
	});

	it("windows claim a start over IPC: a refusal says why, and a failed start gives the claim back", async () => {
		const supervisor = testRegistry(dir);
		const start = { type: "start" as const, cwd: "/p", sessionFile: file };
		const first = await handleIpcRequest(supervisor, start);
		expect(first).toMatchObject({ type: "start_result", ok: true, id: expect.any(String) });
		expect(await handleIpcRequest(supervisor, start)).toMatchObject({
			ok: false,
			error: "it is already starting — try again in a moment",
		});
		if (first.type !== "start_result") throw new Error("refused");
		expect(await handleIpcRequest(supervisor, { type: "start_failed", instanceId: first.id })).toMatchObject({
			ok: true,
		});
		expect(await handleIpcRequest(supervisor, start)).toMatchObject({ type: "start_result", ok: true });
		supervisor.registerExternal(pane("pi-b"), "idle");
		expect(await handleIpcRequest(supervisor, start)).toMatchObject({
			ok: false,
			error: "it is already open in a pane",
		});
	});

	it("deleting a resuming session's stored row does not free its file while its pane starts", () => {
		const supervisor = testRegistry(dir);
		const { id } = supervisor.saveInstance({ cwd: "/p", sessionFile: file })!;
		supervisor.claimStart({ cwd: "/p", sessionFile: file });
		supervisor.deleteInstance(id);
		expect(supervisor.claimStart({ cwd: "/p", sessionFile: file })).toEqual({ ok: false, refused: "starting" });
		expect(rows(supervisor)).toEqual([expect.objectContaining({ id, status: "starting" })]);
	});

	it("a new session whose pane is gone before it registered stops being listed at once", () => {
		let up = true;
		const supervisor = new ServerSupervisor({ now: () => Date.now(), tmux: { hasSession: () => up }, dir });
		supervisor.paneStarting({ cwd: "/p", pane: "pi-n" });
		expect(listSummaries(supervisor)).toHaveLength(1);
		up = false;
		expect(listSummaries(supervisor)).toEqual([]);
	});

	it("a pane past its heartbeat's TTL does not refuse a resume", () => {
		let now = Date.parse("2026-10-30T10:00:00.000Z");
		const supervisor = testRegistry(dir, () => now);
		supervisor.registerExternal(pane("pi-a"), "idle", now);
		now += 20_000;
		expect(supervisor.claimStart({ cwd: "/p", sessionFile: file })).toMatchObject({ ok: true });
	});
});
