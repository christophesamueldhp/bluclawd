import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleIpcRequest, listSummaries } from "../daemon/handler.ts";
import type { ErrorResponse, InstanceSummary, ListResponse } from "../daemon/ipc/protocol.ts";
import { loadDeleted, loadInstances, saveInstances } from "../daemon/storage.ts";
import type { TmuxProbe } from "../daemon/supervisor.ts";
import type { InstanceRecord } from "../daemon/types.ts";
import { testRegistry } from "./helpers/registry.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** A tmux whose has-session answers only when the test says, each pane as `up` has it. */
function heldTmux(up: Set<string>) {
	const pending = new Map<string, () => void>();
	const asked: string[] = [];
	const tmux: TmuxProbe = {
		hasSession: (name) => {
			asked.push(name);
			return up.has(name);
		},
		hasSessionAsync: (name) => {
			asked.push(name);
			return new Promise((resolve) => pending.set(name, () => resolve(up.has(name))));
		},
		end: () => {},
	};
	const answer = () => {
		for (const [name, resolve] of pending) {
			pending.delete(name);
			resolve();
		}
	};
	return { tmux, pending, asked, answer };
}

/** A list reply's rows. */
function instancesOf(reply: ListResponse | ErrorResponse): InstanceSummary[] {
	if (!reply.ok) throw new Error(reply.error);
	return reply.instances ?? [];
}

function register(id: string) {
	return { type: "register", instance: { id, pane: id, cwd: "/p", activity: "idle" } } as const;
}

describe("a list's tmux probes", () => {
	it("asks tmux about every lapsed pane at once, and answers a heartbeat meanwhile", async () => {
		let now = 1000;
		const { tmux, pending, answer } = heldTmux(new Set(["pi-a", "pi-b", "pi-c"]));
		const supervisor = testRegistry(undefined, () => now, tmux);
		for (const id of ["pi-a", "pi-b", "pi-c"]) await handleIpcRequest(supervisor, register(id));
		now += 16_000;

		const list = handleIpcRequest(supervisor, { type: "list" });
		await waitFor(() => expect([...pending.keys()].sort()).toEqual(["pi-a", "pi-b", "pi-c"]));
		await expect(handleIpcRequest(supervisor, register("pi-d"))).resolves.toMatchObject({ ok: true });
		answer();

		const instances = instancesOf(await list);
		expect(instances.map(({ id, silent }) => ({ id, silent }))).toEqual([
			{ id: "pi-d", silent: undefined },
			{ id: "pi-a", silent: true },
			{ id: "pi-b", silent: true },
			{ id: "pi-c", silent: true },
		]);
	});
});

describe("a silent pane", () => {
	it("is asked about once per list, not once for each of its halves", async () => {
		let now = 1000;
		const { tmux, asked, pending, answer } = heldTmux(new Set(["pi-a"]));
		const supervisor = testRegistry(undefined, () => now, tmux);
		await handleIpcRequest(supervisor, register("pi-a"));
		now += 16_000;
		const list = async () => {
			const listed = handleIpcRequest(supervisor, { type: "list" });
			await waitFor(() => expect(pending.size).toBe(1));
			answer();
			return listed;
		};
		await list();
		asked.length = 0;
		const instances = instancesOf(await list());
		expect(instances).toMatchObject([{ id: "pi-a", silent: true }]);
		expect(asked).toEqual(["pi-a"]);
	});
});

describe("listing with async probes", () => {
	/**
	 * A registry in every state reaping asks tmux about, on its own dir: lapsed panes tmux has
	 * (`pi-up`), has not (`pi-gone`, which has a session file) and cannot say about (`pi-unk`); a
	 * silent pane since gone (`pi-was`); a live one (`pi-live`); a deleted row's pane since gone
	 * (`pi-del`); a start whose pane is gone (`pi-new`); and a stored run whose orchestrator is gone.
	 */
	/** Both fixtures' `pi-gone` session, so their stored rows can be compared. */
	const file = join(mkdtempSync(join(tmpdir(), "bluclawd-probes-")), "gone.jsonl");
	writeFileSync(file, "");

	function fixture(withAsync: boolean) {
		const dir = mkdtempSync(join(tmpdir(), "bluclawd-probes-"));
		const up = new Set(["pi-up", "pi-gone", "pi-was", "pi-live", "pi-del"]);
		const hasSession = (name: string) => {
			if (name === "pi-unk") throw new Error("tmux timed out");
			return up.has(name);
		};
		let now = 1000;
		const supervisor = testRegistry(dir, () => now, {
			hasSession,
			...(withAsync ? { hasSessionAsync: async (name: string) => hasSession(name) } : {}),
			end: () => {},
		});
		saveInstances(dir, [
			{ id: "run", status: "stopped", cwd: "/p", createdAt: "2026-01-01T00:00:00Z", parent: "pi-o" },
		]);
		const beat = (id: string, extra = {}) =>
			supervisor.registerExternal({ ...rec(id), pane: id, ...extra }, "idle", now);
		beat("pi-was");
		now += 16_000;
		supervisor.listExternalInstances(now);
		up.delete("pi-was");
		for (const id of ["pi-up", "pi-unk", "pi-live", "pi-del"]) beat(id);
		beat("pi-gone", { sessionFile: file });
		supervisor.deleteInstance("pi-del");
		up.delete("pi-del");
		up.delete("pi-gone");
		supervisor.paneStarting({ pane: "pi-new", cwd: "/p" });
		now += 16_000;
		beat("pi-live");
		return { dir, supervisor };
	}

	function rec(id: string): InstanceRecord {
		return { id, status: "online", cwd: "/p", createdAt: "2026-01-01T00:00:00Z" };
	}

	it("lists, reaps and expires the same rows as blocking probes do", async () => {
		const blocking = fixture(false);
		const probed = fixture(true);
		const before = listSummaries(blocking.supervisor);
		const after = instancesOf(await handleIpcRequest(probed.supervisor, { type: "list" }));
		expect(after).toEqual(before);
		expect(before.map(({ id, status, silent }) => ({ id, status, silent }))).toEqual([
			{ id: "pi-gone", status: "stopped", silent: undefined },
			{ id: "pi-live", status: "online", silent: undefined },
			{ id: "pi-up", status: "online", silent: true },
		]);
		expect(loadInstances(probed.dir)).toEqual(loadInstances(blocking.dir));
		expect(loadDeleted(probed.dir)).toEqual(loadDeleted(blocking.dir));
		expect(loadDeleted(blocking.dir)).toEqual([expect.objectContaining({ paneId: "pi-del", goneAt: 33_000 })]);
	});
});

describe("a start claimed while a list's probes are out", () => {
	it("is reaped by that list as it would have been had it come first", async () => {
		let now = 1000;
		const { tmux, pending, answer } = heldTmux(new Set(["pi-a"]));
		const supervisor = testRegistry(undefined, () => now, tmux);
		await handleIpcRequest(supervisor, register("pi-a"));
		now += 16_000;
		const list = handleIpcRequest(supervisor, { type: "list" });
		await waitFor(() => expect(pending.size).toBe(1));
		// Its pane failed to start: tmux no longer has it.
		await handleIpcRequest(supervisor, { type: "start", pane: "pi-new", cwd: "/p" });
		answer();
		const instances = instancesOf(await list);
		expect(instances.map(({ id }) => id)).toEqual(["pi-a"]);
	});
});
