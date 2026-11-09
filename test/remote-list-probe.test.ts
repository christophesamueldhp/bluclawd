import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActivity } from "../daemon/activity.ts";
import { handleIpcRequest, listSummaries } from "../daemon/handler.ts";
import { RemoteControl, type RemoteControlDeps } from "../daemon/remote/control.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";
import type { RemoteSession } from "../daemon/remote/sessions.ts";
import { loadInstances, saveInstances } from "../daemon/storage.ts";
import type { ServerSupervisor } from "../daemon/supervisor.ts";
import { heldTmux } from "./helpers/held-tmux.ts";
import { testRegistry } from "./helpers/registry.ts";
import { waitFor } from "./helpers/wait-for.ts";
import { validP256dh } from "./support/push.ts";

function register(id: string, activity: AgentActivity = "idle") {
	return { type: "register", instance: { id, pane: id, cwd: "/p", activity } } as const;
}

/** Remote control as the daemon wires it to `supervisor`, listing with a kept probe unless `probed` is false. */
function remoteFor(dir: string, supervisor: ServerSupervisor, extra: Partial<RemoteControlDeps> = {}, probed = true) {
	return new RemoteControl({
		store: new RemoteStore(join(dir, "remote.json")),
		delivery: supervisor.delivery,
		listInstances: (probe) => listSummaries(supervisor, probe),
		...(probed ? { probeForList: () => supervisor.probeForList() } : {}),
		send: () => true,
		deleteInstance: (id) => supervisor.deleteInstance(id),
		renameInstance: (id, name) => supervisor.renameInstance(id, name) !== undefined,
		setPinned: (id, pinned) => supervisor.setInstanceMeta(id, { pinned }) !== undefined,
		claimStart: (spec) => supervisor.claimStart(spec),
		paneStarting: (spec) => supervisor.paneStarting(spec),
		startFailed: (id) => supervisor.startFailed(id),
		webDir: dir,
		...extra,
	});
}

/** Turns `control` on and pairs a phone: its session list, and its device id. */
async function pairedPhone(control: RemoteControl) {
	const on = await control.handle({ type: "remote", action: "on", port: 0 });
	if (on.type !== "remote_result") throw new Error(on.error);
	const { code } = control.store.createCode();
	const claimed = control.store.claim(code, "iPhone");
	if (!("token" in claimed)) throw new Error(claimed.error);
	const sessions = async (): Promise<RemoteSession[]> => {
		const res = await fetch(`http://127.0.0.1:${on.port}/api/sessions`, {
			headers: { authorization: `Bearer ${claimed.token}` },
		});
		return ((await res.json()) as { sessions: RemoteSession[] }).sessions;
	};
	return { sessions, deviceId: claimed.deviceId };
}

describe("remote control's list", () => {
	let dir: string;
	let now: number;
	let up: Set<string>;
	let held: ReturnType<typeof heldTmux>;
	let supervisor: ServerSupervisor;
	let control: RemoteControl;
	let sessions: () => Promise<RemoteSession[]>;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-remote-probe-"));
		// The tmux remote control asks whether a terminal shows pi is this test's, which no server runs.
		vi.stubEnv("PI_SERVER_DIR", dir);
		vi.useFakeTimers({ toFake: ["Date"] });
		now = 1000;
		up = new Set();
		held = heldTmux(up);
		supervisor = testRegistry(dir, () => now, held.tmux);
		control = remoteFor(dir, supervisor);
		({ sessions } = await pairedPhone(control));
	});
	afterEach(async () => {
		await control.stop();
		vi.useRealTimers();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	it("lists Silent panes from the kept probe: no blocking call, and no wait on a probe tmux holds", async () => {
		up.add("pi-a");
		await handleIpcRequest(supervisor, register("pi-a"));
		now += 16_000;
		// The first list has no probe yet: it asks as an unprobed list does, and starts one.
		await sessions();
		await waitFor(() => expect([...held.pending.keys()]).toEqual(["pi-a"]));
		held.answer();
		await waitFor(() => expect(held.pending.size).toBe(0));

		held.blocking.length = 0;
		vi.setSystemTime(Date.now() + 1500);
		const listed = await sessions();
		// The kept probe went stale: a new one is out, and tmux holds it.
		expect([...held.pending.keys()]).toEqual(["pi-a"]);
		expect(listed).toMatchObject([{ id: "pi-a", silent: true }]);
		expect(await sessions()).toMatchObject([{ id: "pi-a", silent: true }]);
		expect(held.blocking).toEqual([]);
	});

	/** A list that starts a probe, which tmux answers before the next list. */
	const warm = async () => {
		await sessions();
		held.answer();
		await waitFor(() => expect(held.pending.size).toBe(0));
		await sessions();
	};

	it("asks about a pane that fell Silent after its probe as an unprobed list does, and ends it", async () => {
		up.add("pi-a");
		await handleIpcRequest(supervisor, register("pi-a"));
		await warm();
		// Agent view's list silences it after remote control's probe, and then tmux loses it.
		now += 16_000;
		const list = handleIpcRequest(supervisor, { type: "list" });
		await waitFor(() => expect(held.pending.size).toBe(1));
		held.answer();
		expect(await list).toMatchObject({ instances: [{ id: "pi-a", silent: true }] });
		up.delete("pi-a");
		held.blocking.length = 0;

		expect(await sessions()).toEqual([]);
		expect(held.blocking).toEqual(["pi-a"]);
	});

	it("lists a pane that beat again after its probe said gone as live", async () => {
		up.add("pi-a");
		await handleIpcRequest(supervisor, register("pi-a"));
		now += 16_000;
		await sessions();
		expect(await sessions()).toMatchObject([{ id: "pi-a", silent: true }]);
		vi.setSystemTime(Date.now() + 1500);
		await sessions();
		// The probe out asks about the Silent pane: tmux says gone, but the pane beats again first.
		up.delete("pi-a");
		await handleIpcRequest(supervisor, register("pi-a"));
		held.answer();
		await waitFor(() => expect(held.pending.size).toBe(0));

		expect(await sessions()).toMatchObject([{ id: "pi-a", alive: true }]);
		expect((await sessions())[0]).not.toHaveProperty("silent");
	});

	it("shows a rename, pin or delete in the very next list", async () => {
		saveInstances(dir, [{ id: "s-a", status: "stopped", cwd: "/p", createdAt: "2026-01-01T00:00:00Z" }]);
		up.add("pi-a");
		up.add("pi-b");
		await handleIpcRequest(supervisor, register("pi-a"));
		await handleIpcRequest(supervisor, register("pi-b"));
		await warm();
		supervisor.renameInstance("s-a", "renamed");
		expect((await sessions()).find((s) => s.id === "s-a")).toMatchObject({ label: "renamed" });
		supervisor.setInstanceMeta("pi-a", { pinned: true });
		expect((await sessions()).find((s) => s.id === "pi-a")).toMatchObject({ band: "pinned" });
		supervisor.deleteInstance("pi-b");
		expect((await sessions()).map((s) => s.id).sort()).toEqual(["pi-a", "s-a"]);
	});

	it("asks tmux nothing while every pane is live and on time, nor with the listener off", async () => {
		up.add("pi-a");
		await handleIpcRequest(supervisor, register("pi-a"));
		for (let i = 0; i < 3; i++) {
			await sessions();
			vi.setSystemTime(Date.now() + 1500);
		}
		expect(held.asked).toEqual([]);

		await control.handle({ type: "remote", action: "off" });
		now += 16_000;
		control.report("pi-a", { models: [] });
		// Unprobed, as before: the listener's off, so no probe runs in the background.
		expect(held.pending.size).toBe(0);
		expect(held.blocking).toContain("pi-a");
	});
});

describe("remote control's list and pushes, kept probe or not", () => {
	const dirs: string[] = [];
	const controls: RemoteControl[] = [];
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	});
	afterEach(async () => {
		for (const control of controls.splice(0)) await control.stop();
		vi.useRealTimers();
		vi.unstubAllEnvs();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * A daemon with a paired phone subscribed to pushes, in every state reaping asks tmux about: a Silent
	 * pane (`pi-up`), a Silent pane mid-turn (`pi-work`, which has a session file), a live working one
	 * (`pi-live`), starts whose panes are up (`pi-start`) and gone (`pi-fail`), and stored runs whose
	 * orchestrator is up (`pi-o`) and gone (`pi-x`). `blocking` records blocking calls.
	 */
	async function daemon(probed: boolean) {
		const dir = mkdtempSync(join(tmpdir(), "bluclawd-remote-twin-"));
		dirs.push(dir);
		vi.stubEnv("PI_SERVER_DIR", dir);
		const file = join(dir, "work.jsonl");
		writeFileSync(file, "");
		let now = 1000;
		const up = new Set(["pi-up", "pi-work", "pi-live", "pi-start", "pi-o"]);
		const blocking: string[] = [];
		const supervisor = testRegistry(dir, () => now, {
			hasSession: (name) => {
				blocking.push(name);
				return up.has(name);
			},
			hasSessionAsync: async (name) => up.has(name),
			end: () => {},
		});
		const createdAt = "2026-01-01T00:00:00Z";
		saveInstances(dir, [
			{ id: "run-o", status: "stopped", cwd: "/p", createdAt, label: "run o", parent: "pi-o" },
			{ id: "run-x", status: "stopped", cwd: "/p", createdAt, label: "run x", parent: "pi-x" },
		]);
		const beat = (id: string, activity: AgentActivity, extra = {}) =>
			handleIpcRequest(supervisor, {
				type: "register",
				instance: { id, pane: id, cwd: "/p", label: id, activity, ...extra },
			});
		await beat("pi-up", "idle");
		await beat("pi-work", "working", { sessionFile: file });
		now += 16_000;
		await beat("pi-live", "working");
		supervisor.paneStarting({ pane: "pi-start", cwd: "/p", label: "start" });
		supervisor.paneStarting({ pane: "pi-fail", cwd: "/p", label: "fail" });
		const pushes: string[] = [];
		const control = remoteFor(
			dir,
			supervisor,
			{
				sendPush: async (_subscription, payload) => {
					pushes.push(payload);
					return "ok";
				},
			},
			probed,
		);
		controls.push(control);
		const phone = await pairedPhone(control);
		control.store.setPush(phone.deviceId, {
			endpoint: "https://web.push.apple.com/phone",
			keys: { p256dh: validP256dh(), auth: "AAAAAAAAAAAAAAAAAAAAAA" },
		});
		const stored = () => loadInstances(dir).map((instance) => instance.id);
		return { up, blocking, pushes, beat, stored, sessions: phone.sessions };
	}

	it("lists and pushes what an unprobed list does, the kept probe's without blocking", async () => {
		const today = await daemon(false);
		const kept = await daemon(true);
		const both = <T>(step: (d: typeof today) => T) => Promise.all([step(today), step(kept)]);
		await vi.advanceTimersByTimeAsync(2000);
		const [listedToday, listedKept] = await both((d) => d.sessions());
		expect(listedKept).toEqual(listedToday);
		expect(listedToday.map(({ id, silent, starting }) => ({ id, silent, starting }))).toEqual([
			{ id: "pi-live", silent: undefined, starting: undefined },
			{ id: "pi-work", silent: true, starting: undefined },
			{ id: "pi-start", silent: undefined, starting: true },
			{ id: "pi-up", silent: true, starting: undefined },
		]);
		// Runs are not the phone's rows, but the stored one whose orchestrator is gone went in both.
		expect(today.stored()).toEqual(["run-o", "pi-work"]);
		expect(kept.stored()).toEqual(today.stored());

		kept.blocking.length = 0;
		// A turn ends, and a Silent pane mid-turn is gone.
		await both((d) => d.beat("pi-live", "idle"));
		await both((d) => d.up.delete("pi-work"));
		await vi.advanceTimersByTimeAsync(3000);
		const [finalToday, finalKept] = await both((d) => d.sessions());
		expect(finalKept).toEqual(finalToday);
		expect(kept.pushes).toEqual(today.pushes);
		expect(today.pushes.map((p) => JSON.parse(p).sessionId)).toEqual(["pi-live"]);
		expect(kept.blocking).toEqual([]);
		expect(today.blocking).not.toEqual([]);
	});
});
