import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActivity } from "../daemon/activity.ts";
import { handleIpcRequest, listSummaries } from "../daemon/handler.ts";
import { RemoteControl, type RemoteControlDeps, TMUX_TIMEOUT_MS } from "../daemon/remote/control.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";
import type { RemoteSession } from "../daemon/remote/sessions.ts";
import { loadInstances, saveInstances } from "../daemon/storage.ts";
import type { ServerSupervisor } from "../daemon/supervisor.ts";
import { Tmux } from "../daemon/tmux.ts";
import { heldTmux } from "./helpers/held-tmux.ts";
import { testRegistry } from "./helpers/registry.ts";
import { waitFor } from "./helpers/wait-for.ts";
import { validP256dh } from "./support/push.ts";

function register(id: string, activity: AgentActivity = "idle") {
	return { type: "register", instance: { id, pane: id, cwd: "/p", activity } } as const;
}

/** Remote control as the daemon wires it to `supervisor`, listing with a kept probe. */
function remoteFor(dir: string, supervisor: ServerSupervisor, extra: Partial<RemoteControlDeps> = {}) {
	return new RemoteControl({
		store: new RemoteStore(join(dir, "remote.json")),
		delivery: supervisor.delivery,
		listInstances: (probe) => listSummaries(supervisor, probe),
		probeForList: () => supervisor.probeForList(),
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
	const list = async () => {
		const res = await fetch(`http://127.0.0.1:${on.port}/api/sessions`, {
			headers: { authorization: `Bearer ${claimed.token}` },
		});
		return (await res.json()) as { sessions: RemoteSession[]; terminalOpen: boolean };
	};
	const sessions = async () => (await list()).sessions;
	const terminalOpen = async () => (await list()).terminalOpen;
	return { sessions, terminalOpen, deviceId: claimed.deviceId };
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

	/** tmux answers the probe out, and it lands. */
	const land = async () => {
		held.answer();
		await new Promise((resolve) => setImmediate(resolve));
	};

	it("lists Silent panes from the kept probe: no blocking call, and no wait on a probe tmux holds", async () => {
		up.add("pi-a");
		await handleIpcRequest(supervisor, register("pi-a"));
		now += 16_000;
		// The first list has no probe yet: it asks as an unprobed list does, and starts one.
		await sessions();
		await waitFor(() => expect([...held.pending.keys()]).toEqual(["pi-a"]));
		await land();

		held.blocking.length = 0;
		vi.setSystemTime(Date.now() + 1500);
		const listed = await sessions();
		// The kept probe went stale: a new one is out, and tmux holds it.
		expect([...held.pending.keys()]).toEqual(["pi-a"]);
		expect(listed).toMatchObject([{ id: "pi-a", silent: true }]);
		expect(await sessions()).toMatchObject([{ id: "pi-a", silent: true }]);
		expect(held.blocking).toEqual([]);
	});

	it("lists from its probes, never blocking, while tmux takes its whole timeout over each", async () => {
		up.add("pi-a");
		await handleIpcRequest(supervisor, register("pi-a"));
		now += 16_000;
		await sessions();
		await land();
		held.blocking.length = 0;
		// A list a second, as the phone's timers do; tmux answers each probe TMUX_TIMEOUT_MS after it
		// was asked, just after that second's list.
		let askedAt: number | undefined;
		for (let second = 0; second < 12; second++) {
			vi.setSystemTime(Date.now() + 1000);
			expect(await sessions()).toMatchObject([{ id: "pi-a", silent: true }]);
			askedAt ??= held.pending.size ? Date.now() : undefined;
			if (askedAt !== undefined && Date.now() - askedAt >= TMUX_TIMEOUT_MS) {
				await land();
				askedAt = undefined;
			}
		}
		expect(held.blocking).toEqual([]);
	});

	it("lists from its latest probe while the next is out, however long a blocking call held the daemon", async () => {
		up.add("pi-a");
		await handleIpcRequest(supervisor, register("pi-a"));
		now += 16_000;
		await sessions();
		await land();
		held.blocking.length = 0;
		vi.setSystemTime(Date.now() + 1500);
		await sessions();
		expect(held.pending.size).toBe(1);
		// A send blocked on a hung tmux, and the overdue list runs before the probe's answer does.
		vi.setSystemTime(Date.now() + 10_000);
		expect(await sessions()).toMatchObject([{ id: "pi-a", silent: true }]);
		expect(held.blocking).toEqual([]);
	});

	it("lists from its probes again after a list that went without one blocked on a hung tmux", async () => {
		for (const id of ["pi-a", "pi-b", "pi-c"]) {
			up.add(id);
			await handleIpcRequest(supervisor, register(id));
		}
		now += 16_000;
		await sessions();
		await land();
		// tmux hangs: each blocking call takes its whole timeout.
		const { hasSession } = held.tmux;
		held.tmux.hasSession = (name) => {
			vi.setSystemTime(Date.now() + TMUX_TIMEOUT_MS);
			return hasSession(name);
		};
		// The phone was away: its first list has no fresh probe, so it blocks, and asks for one.
		vi.setSystemTime(Date.now() + 60_000);
		await sessions();
		await land();

		held.blocking.length = 0;
		for (let second = 0; second < 3; second++) {
			vi.setSystemTime(Date.now() + 1000);
			expect(await sessions()).toHaveLength(3);
			await land();
		}
		expect(held.blocking).toEqual([]);
	});

	/** A list that starts a probe, which tmux answers before the next list. */
	const warm = async () => {
		await sessions();
		await land();
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
		await land();

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
		const control = remoteFor(dir, supervisor, {
			sendPush: async (_subscription, payload) => {
				pushes.push(payload);
				return "ok";
			},
			...(probed ? {} : { probeForList: undefined }),
		});
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

describe("whether a terminal shows pi", () => {
	it("is asked of tmux without blocking, with the blocking ask's answers", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bluclawd-attached-"));
		try {
			const tmux = (out: string | Error) =>
				new Tmux(dir, () => {
					if (out instanceof Error) throw out;
					return out;
				});
			expect(await tmux("/dev/ttys001\n").attachedAsync()).toBe(true);
			expect(await tmux("").attachedAsync()).toBe(false);
			expect(await tmux(new Error("no server running")).attachedAsync()).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	describe("to the phone", () => {
		let dir: string;
		let control: RemoteControl;
		let terminalOpen: () => Promise<boolean>;
		/** tmux's list-clients: the blocking ask answers `clients` at once; each one without blocking
		 *  waits in `pending` until the test answers it. */
		let clients: boolean;
		let blocking: number;
		let pending: ((open: boolean) => void)[];
		const answer = async (open: boolean) => {
			for (const resolve of pending.splice(0)) resolve(open);
			await new Promise((resolve) => setImmediate(resolve));
		};

		beforeEach(async () => {
			dir = mkdtempSync(join(tmpdir(), "bluclawd-remote-terminal-"));
			vi.useFakeTimers({ toFake: ["Date"] });
			clients = true;
			blocking = 0;
			pending = [];
			const tmux = {
				attached: () => {
					blocking++;
					return clients;
				},
				attachedAsync: () => new Promise<boolean>((resolve) => pending.push(resolve)),
			} as unknown as Tmux;
			control = remoteFor(dir, testRegistry(dir, () => Date.now(), heldTmux(new Set()).tmux), { tmux });
			({ terminalOpen } = await pairedPhone(control));
		});
		afterEach(async () => {
			await control.stop();
			vi.useRealTimers();
			rmSync(dir, { recursive: true, force: true });
		});

		it("answers from tmux's latest answer, never waiting on a list-clients tmux holds", async () => {
			// None kept yet: asked as today, so the phone is not shown "Read only" meanwhile.
			expect(await terminalOpen()).toBe(true);
			expect(blocking).toBe(1);
			expect(pending).toHaveLength(0);

			vi.setSystemTime(Date.now() + 1500);
			expect(await terminalOpen()).toBe(true);
			expect(pending).toHaveLength(1);
			clients = false;
			for (let i = 0; i < 3; i++) expect(await terminalOpen()).toBe(true);
			// tmux holds it however long: the latest answer stands, and no second one is asked.
			vi.setSystemTime(Date.now() + 10_000);
			expect(await terminalOpen()).toBe(true);
			expect(pending).toHaveLength(1);
			expect(blocking).toBe(1);

			await answer(false);
			expect(await terminalOpen()).toBe(false);
			expect(blocking).toBe(1);
		});
		it("asks as at first once its answer is too old and none is out: the phone was away", async () => {
			await terminalOpen();
			vi.setSystemTime(Date.now() + 1500);
			await terminalOpen();
			await answer(true);
			clients = false;
			vi.setSystemTime(Date.now() + 60_000);
			expect(await terminalOpen()).toBe(false);
			expect(blocking).toBe(2);
		});

		it("does not keep an answer asked before the listener restarted", async () => {
			await terminalOpen();
			vi.setSystemTime(Date.now() + 1500);
			await terminalOpen();
			expect(pending).toHaveLength(1);
			await control.handle({ type: "remote", action: "off" });
			({ terminalOpen } = await pairedPhone(control));
			clients = false;
			expect(await terminalOpen()).toBe(false);
			expect(blocking).toBe(2);
			// The ask from before the restart lands with what tmux said then.
			await answer(true);
			expect(await terminalOpen()).toBe(false);
		});

		it("asks tmux nothing until a phone asks", async () => {
			vi.setSystemTime(Date.now() + 60_000);
			expect([blocking, pending.length]).toEqual([0, 0]);
		});
	});
});
