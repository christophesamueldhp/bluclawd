import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalSessionKey, SessionOperations } from "../daemon/session-operations.ts";
import type { ViewEvent, ViewTerminal } from "../daemon/view-types.ts";
import { FakeViewChild } from "./support/fake-view-child.ts";

vi.mock("../daemon/rpc-process.ts", () => ({
	createRpcProcessInstance: (opts: { sessionFile?: string }) => new FakeViewChild(opts),
}));
const { ServerSupervisor } = await import("../daemon/supervisor.ts");
const { loadInstances } = await import("../daemon/storage.ts");
let dir: string;
let file: string;
let supervisor: InstanceType<typeof ServerSupervisor>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "view-operations-"));
	file = join(dir, "saved.jsonl");
	writeFileSync(file, '{"type":"session","id":"saved","version":3,"cwd":"/p","timestamp":"2026-10-05T00:00:00Z"}\n');
	vi.stubEnv("PI_SERVER_DIR", dir);
	FakeViewChild.children = [];
	supervisor = new ServerSupervisor();
});
afterEach(async () => {
	for (const c of FakeViewChild.children)
		c.dispose = async () => {
			c.disposed = true;
		};
	await supervisor.shutdown();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
describe("session lifecycle fencing", () => {
	it("canonicalizes aliases including absent children", () => {
		const alias = join(dir, "alias");
		symlinkSync(dir, alias, "dir");
		expect(canonicalSessionKey(join(alias, "saved.jsonl"))).toBe(canonicalSessionKey(file));
		expect(canonicalSessionKey(join(alias, "missing.jsonl"))).toBe(join(realpathSync(dir), "missing.jsonl"));
	});
	it("rejects queued starts once deletion is requested", async () => {
		const ops = new SessionOperations();
		const gate = deferred<void>();
		const began = deferred<void>();
		const a = ops.run(file, "start", () => {
			began.resolve();
			return gate.promise;
		});
		await began.promise;
		const pending = ops.run(file, "start", async () => "new");
		const rejected = expect(pending).rejects.toThrow("delet");
		const deletion = ops.run(file, "delete", async () => "deleted");
		expect(ops.isBlocked(file)).toBe(true);
		gate.resolve();
		await a;
		await rejected;
		expect(await deletion).toBe("deleted");
	});
	it("parallel alias starts create one initialized child", async () => {
		const alias = join(dir, "alias.jsonl");
		symlinkSync(file, alias);
		const [a, b] = await Promise.all([
			supervisor.spawnInstance({ cwd: dir, sessionFile: file }),
			supervisor.spawnInstance({ cwd: dir, sessionFile: alias }),
		]);
		expect(a.id).toBe(b.id);
		expect(a.status).toBe("online");
		expect(b.status).toBe("online");
		expect(FakeViewChild.children).toHaveLength(1);
	});
	it("external writer blocks spawn", async () => {
		supervisor.registerExternal(
			{ id: "native", cwd: dir, status: "online", createdAt: "now", lastSeenAt: "now", sessionFile: file },
			"working",
		);
		await expect(supervisor.spawnInstance({ cwd: dir, sessionFile: file })).rejects.toThrow("terminal");
		expect(FakeViewChild.children).toHaveLength(0);
	});
	it("late get_state cannot upsert removed row", async () => {
		const row = await supervisor.spawnInstance({ cwd: dir, sessionFile: file });
		const child = FakeViewChild.children[0];
		const send = child.send.bind(child);
		const gate = deferred<void>();
		let pending = false;
		child.send = async (command) => {
			if (command.type === "get_state") {
				pending = true;
				await gate.promise;
			}
			return send(command);
		};
		const rpc = supervisor.handleRpc(row.id, { type: "prompt", message: "hello" });
		await vi.waitFor(() => expect(pending).toBe(true));
		await supervisor.deleteInstance(row.id);
		gate.resolve();
		await rpc;
		expect(loadInstances()).toEqual([]);
		child.crash();
		expect(loadInstances()).toEqual([]);
	});
	it("delete rejects new attach and prompt while cleanup is pending", async () => {
		const row = await supervisor.spawnInstance({ cwd: dir, sessionFile: file });
		const gate = deferred<void>();
		FakeViewChild.children[0].dispose = () => gate.promise;
		const deletion = supervisor.deleteInstance(row.id);
		await vi.waitFor(() => expect(supervisor.getInstance(row.id)?.status).toBe("stopping"));
		expect(supervisor.openViewStream(row.id, () => {})).toBeUndefined();
		await expect(supervisor.handleRpc(row.id, { type: "prompt", message: "do not restart" })).rejects.toThrow(
			"delet",
		);
		gate.resolve();
		expect(await deletion).toBe(true);
	});
	it("stop preserves transcript and deletion notifies all viewers", async () => {
		const row = await supervisor.spawnInstance({ cwd: dir, sessionFile: file });
		const original = readFileSync(file, "utf8");
		const a: Array<ViewEvent | ViewTerminal> = [];
		const b: Array<ViewEvent | ViewTerminal> = [];
		supervisor.openViewStream(row.id, (e) => a.push(e));
		supervisor.openViewStream(row.id, (e) => b.push(e));
		await supervisor.stopInstance(row.id);
		await supervisor.deleteInstance(row.id);
		expect(a.at(-1)).toMatchObject({ type: "view_terminal", reason: "deleted" });
		expect(b.at(-1)).toMatchObject({ type: "view_terminal", reason: "deleted" });
		expect(readFileSync(file, "utf8")).toBe(original);
	});
	it("failed delete remains visible and does not stop another child", async () => {
		const row = await supervisor.spawnInstance({ cwd: dir, sessionFile: file });
		const other = await supervisor.spawnInstance({ cwd: dir });
		FakeViewChild.children[0].dispose = async () => {
			throw new Error("cannot stop");
		};
		await expect(supervisor.deleteInstance(row.id)).rejects.toThrow("cannot stop");
		expect(supervisor.getInstance(row.id)).toBeDefined();
		expect(supervisor.getInstance(other.id)?.status).toBe("online");
		expect(FakeViewChild.children[1].disposed).toBe(false);
	});
	it("explicit later resume is allowed without automatically prompting", async () => {
		const row = await supervisor.spawnInstance({ cwd: dir, sessionFile: file });
		await supervisor.deleteInstance(row.id);
		const resumed = await supervisor.spawnInstance({ cwd: dir, sessionFile: file });
		expect(resumed.id).not.toBe(row.id);
		expect(FakeViewChild.children[1].sent.map((c) => c.type)).toEqual(["get_state"]);
	});
});
