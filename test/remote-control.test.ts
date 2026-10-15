import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIpcRequest, listSummaries, setRemoteControl } from "../daemon/handler.ts";
import type { InstanceSummary } from "../daemon/ipc/protocol.ts";
import { RemoteControl } from "../daemon/remote/control.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";
import type { PushResult, WebPushSubscription } from "../daemon/remote/webpush.ts";
import { Tmux } from "../daemon/tmux.ts";
import { validP256dh } from "./support/push.ts";

describe("remote control switch", () => {
	let dir: string;
	let control: RemoteControl;
	const make = () =>
		new RemoteControl({
			store: new RemoteStore(join(dir, "remote.json")),
			listInstances: () => [],
			send: () => true,
			deleteInstance: () => false,
			webDir: dir,
		});

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-remote-control-"));
		control = make();
	});
	afterEach(async () => {
		vi.useRealTimers();
		await control.stop();
		setRemoteControl(undefined);
		rmSync(dir, { recursive: true, force: true });
	});

	it("turns on with a pairing code and listens; off stops listening", async () => {
		const on = await control.handle({ type: "remote", action: "on", port: 0 });
		expect(on).toMatchObject({ type: "remote_result", ok: true, enabled: true, listening: true });
		if (on.type !== "remote_result") throw new Error(on.error);
		expect(on.code).toMatch(/^\d{6}$/);
		expect(on.secret).toMatch(/^[\w-]{22}$/);
		expect((await fetch(`http://127.0.0.1:${on.port}/api/sessions`)).status).toBe(401);
		expect(await control.handle({ type: "remote", action: "off" })).toMatchObject({
			enabled: false,
			listening: false,
		});
		await expect(fetch(`http://127.0.0.1:${on.port}/api/sessions`)).rejects.toThrow();
	});

	it("comes back on from remote.json, as after a daemon restart", async () => {
		await control.handle({ type: "remote", action: "on", port: 0 });
		await control.stop();
		control = make();
		await control.apply();
		expect(await control.handle({ type: "remote", action: "status" })).toMatchObject({
			enabled: true,
			listening: true,
		});
	});

	it("reports a port in use instead of throwing", async () => {
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
		const { port } = blocker.address() as { port: number };
		try {
			const on = await control.handle({ type: "remote", action: "on", port });
			expect(on).toMatchObject({ enabled: true, listening: false });
			expect((on as { listenError?: string }).listenError).toContain("EADDRINUSE");
		} finally {
			await new Promise((r) => blocker.close(() => r(undefined)));
		}
	});

	it("starts one server when switched on twice at once", async () => {
		const [a, b] = await Promise.all([
			control.handle({ type: "remote", action: "on", port: 0 }),
			control.handle({ type: "remote", action: "on", port: 0 }),
		]);
		if (a.type !== "remote_result" || b.type !== "remote_result") throw new Error("not a result");
		await control.handle({ type: "remote", action: "off" });
		await expect(fetch(`http://127.0.0.1:${a.port}/api/sessions`)).rejects.toThrow();
		await expect(fetch(`http://127.0.0.1:${b.port}/api/sessions`)).rejects.toThrow();
	});

	it("refuses a pairing code while off, and an unknown device", async () => {
		expect(await control.handle({ type: "remote", action: "pair" })).toMatchObject({ type: "error", ok: false });
		expect(await control.handle({ type: "remote", action: "revoke", deviceId: "nope" })).toMatchObject({
			type: "error",
			ok: false,
		});
	});

	it("keeps one launch command in remote.json: a heartbeat's only while none usable is there, /remote-control's always", async () => {
		setRemoteControl(control);
		const file = join(dir, "remote.json");
		const [a, b, c] = ["a.js", "b.js", "c.js"].map((name) => {
			writeFileSync(join(dir, name), "");
			return [process.execPath, join(dir, name)];
		});
		const beat = (command: string[]) =>
			handleIpcRequest({
				type: "register",
				instance: { id: "pane-1", cwd: "/p", leafId: "e2", launch: { command } },
			});
		await beat(a);
		expect(control.launch()).toEqual({ command: a });
		expect(listSummaries().find((i) => i.id === "pane-1")).toMatchObject({ external: true, leafId: "e2" });
		// Off: nothing is written for it.
		expect(existsSync(file)).toBe(false);
		// On: the phone needs it at once.
		await control.handle({ type: "remote", action: "on", port: 0 });
		expect(control.store.load().launch).toEqual({ command: a });
		const written = statSync(file).ino;
		// Two panes started differently, alternating: the one kept stays, and nothing is written.
		await beat(b);
		await beat(a);
		await beat(b);
		expect(statSync(file).ino).toBe(written);
		expect(control.launch()).toEqual({ command: a });
		// Its script gone (an upgrade): the latest usable one starts panes, and the next heartbeat keeps it.
		rmSync(join(dir, "a.js"));
		expect(control.launch()).toEqual({ command: b });
		await beat(b);
		expect(control.store.load().launch).toEqual({ command: b });
		// /remote-control's replaces a usable one.
		await control.handle({ type: "remote", action: "status", launch: { command: c } });
		expect(control.store.load().launch).toEqual({ command: c });
		expect(control.launch()).toEqual({ command: c });
		// A restarted daemon has it before any heartbeat, and does not write it again.
		await control.stop();
		control = make();
		setRemoteControl(control);
		await control.apply();
		expect(control.launch()).toEqual({ command: c });
		const rewritten = statSync(file).ino;
		await beat(b);
		expect(statSync(file).ino).toBe(rewritten);
		await control.handle({ type: "remote", action: "off" });
		const off = statSync(file).ino;
		rmSync(join(dir, "c.js"));
		await beat(b);
		expect(control.launch()).toEqual({ command: b });
		expect(statSync(file).ino).toBe(off);
		await handleIpcRequest({ type: "unregister", instanceId: "pane-1" });
	});

	it("learns the launch command from /remote-control too, as a fresh pi has no heartbeat yet", async () => {
		writeFileSync(join(dir, "pi.js"), "");
		const command = [process.execPath, join(dir, "pi.js")];
		await control.handle({ type: "remote", action: "status", launch: { command } });
		await control.handle({ type: "remote", action: "on", port: 0 });
		expect(control.store.load().launch).toEqual({ command });
		await control.handle({ type: "remote", action: "status", launch: { command: [] } });
		expect(control.launch()).toEqual({ command });
	});

	describe("panes the phone starts", () => {
		const START_TIMEOUT_MS = 90_000;
		let instances: InstanceSummary[];
		let deleted: string[];
		let tmuxCalls: string[][];
		let base: string;
		let token: string;

		beforeEach(async () => {
			instances = [{ id: "stored", status: "stopped", cwd: dir, sessionFile: join(dir, "s.jsonl") }];
			deleted = [];
			tmuxCalls = [];
			control = new RemoteControl({
				store: new RemoteStore(join(dir, "remote.json")),
				listInstances: () => instances,
				send: () => true,
				deleteInstance: (id) => {
					deleted.push(id);
					return true;
				},
				tmux: new Tmux(dir, (args) => {
					tmuxCalls.push(args);
					return "";
				}),
				webDir: dir,
			});
			setRemoteControl(control);
			writeFileSync(join(dir, "pi.js"), "");
			control.noteLaunch({ command: [process.execPath, join(dir, "pi.js")] });
			const on = await control.handle({ type: "remote", action: "on", port: 0 });
			if (on.type !== "remote_result" || !on.code) throw new Error("not listening");
			base = `http://127.0.0.1:${on.port}`;
			const paired = await fetch(`${base}/api/pair`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ code: on.code, deviceName: "iPhone" }),
			});
			token = ((await paired.json()) as { token: string }).token;
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		});

		const post = async (path: string, body: object) => {
			const res = await fetch(`${base}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
				body: JSON.stringify(body),
			});
			return { status: res.status, body: (await res.json()) as { pane?: string; error?: string } };
		};
		const register = (id: string) =>
			handleIpcRequest({ type: "register", instance: { id, cwd: dir, sessionFile: join(dir, "s.jsonl") } });
		const killed = () => tmuxCalls.filter((args) => args[0] === "kill-session").map((args) => args[2]);

		it("drops a resumed session's stored row once its pane registers, and only then", async () => {
			const { status, body } = await post("/api/sessions/stored/prompt", { text: "carry on" });
			expect(status).toBe(202);
			expect(deleted).toEqual([]);
			// A second reply before the pane is up would start a second one.
			expect(await post("/api/sessions/stored/prompt", { text: "again" })).toEqual({
				status: 409,
				body: { error: "session_busy" },
			});
			await register(body.pane!);
			expect(deleted).toEqual(["stored"]);
			await register(body.pane!);
			expect(deleted).toEqual(["stored"]);
			vi.advanceTimersByTime(START_TIMEOUT_MS);
			expect(killed()).toEqual([]);
			await handleIpcRequest({ type: "unregister", instanceId: body.pane! });
		});

		it("lists a stored row as being resumed until the phone's pane registers, so agent view starts no second one", async () => {
			vi.stubEnv("PI_SERVER_DIR", dir);
			const saved = await handleIpcRequest({ type: "save", cwd: dir, sessionFile: join(dir, "s.jsonl") });
			if (saved.type !== "ack" || !saved.instance) throw new Error("not saved");
			const id = saved.instance.id;
			instances = listSummaries();
			expect(instances.find((i) => i.id === id)).not.toHaveProperty("resuming");
			const { body } = await post(`/api/sessions/${id}/prompt`, { text: "carry on" });
			expect(listSummaries().find((i) => i.id === id)).toMatchObject({ resuming: true });
			await register(body.pane!);
			expect(listSummaries().find((i) => i.id === id)).not.toHaveProperty("resuming");
			await handleIpcRequest({ type: "unregister", instanceId: body.pane! });
		});

		it("ends a pane it started that never registered, keeping the stored row it would have resumed", async () => {
			const task = await post("/api/sessions", { cwd: dir, task: "go" });
			const resume = await post("/api/sessions/stored/prompt", { text: "carry on" });
			vi.advanceTimersByTime(START_TIMEOUT_MS - 1);
			expect(killed()).toEqual([]);
			vi.advanceTimersByTime(1);
			expect(killed()).toEqual([`=${task.body.pane}`, `=${resume.body.pane}`]);
			expect(deleted).toEqual([]);
			// The stored row can be resumed again.
			expect((await post("/api/sessions/stored/prompt", { text: "carry on" })).status).toBe(202);
		});

		it("leaves a pane it started alone once it registered", async () => {
			const task = await post("/api/sessions", { cwd: dir, task: "go" });
			await register(task.body.pane!);
			vi.advanceTimersByTime(START_TIMEOUT_MS);
			expect(killed()).toEqual([]);
			expect(deleted).toEqual([]);
			await handleIpcRequest({ type: "unregister", instanceId: task.body.pane! });
		});
	});

	it("asks a heartbeat for a report while it has none for the pane, as after a daemon restart", async () => {
		const beat = () => handleIpcRequest({ type: "register", instance: { id: "pane-1", cwd: "/p" } });
		expect(await beat()).not.toHaveProperty("wantReport");
		setRemoteControl(control);
		expect(await beat()).toMatchObject({ type: "register_result", wantReport: true });
		await handleIpcRequest({ type: "remote_report", instanceId: "pane-1", report: { models: [] } });
		expect(await beat()).not.toHaveProperty("wantReport");
		await handleIpcRequest({ type: "unregister", instanceId: "pane-1" });
		expect(await beat()).toMatchObject({ wantReport: true });
		await handleIpcRequest({ type: "unregister", instanceId: "pane-1" });
	});

	it("tells a heartbeat when a phone watches its session, and streams what the pane sends", async () => {
		setRemoteControl(control);
		const on = await control.handle({ type: "remote", action: "on", port: 0 });
		if (on.type !== "remote_result" || !on.code) throw new Error("not listening");
		const base = `http://127.0.0.1:${on.port}`;
		const beat = () => handleIpcRequest({ type: "register", instance: { id: "pane-1", cwd: "/p" } });
		expect(await beat()).not.toHaveProperty("watched");
		const paired = await fetch(`${base}/api/pair`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: on.code, deviceName: "iPhone" }),
		});
		const { token } = (await paired.json()) as { token: string };
		const controller = new AbortController();
		const res = await fetch(`${base}/api/events?token=${token}&session=pane-1`, { signal: controller.signal });
		const reader = res.body!.getReader();
		let received = "";
		const until = async (needle: string) => {
			while (!received.includes(needle)) received += new TextDecoder().decode((await reader.read()).value);
		};
		await until(": connected");
		expect(await beat()).toMatchObject({ type: "register_result", watched: true });
		const live = { text: "Working on it", tools: [] };
		expect(await handleIpcRequest({ type: "remote_live", instanceId: "pane-1", live })).toMatchObject({
			type: "ack",
			ok: true,
		});
		await until(JSON.stringify({ sessionId: "pane-1", live }));
		await handleIpcRequest({ type: "unregister", instanceId: "pane-1" });
		await until(JSON.stringify({ sessionId: "pane-1", live: null }));
		controller.abort();
	});

	it("keeps each pane's latest report for the phone, and signals each one to the phones that have it open", async () => {
		const instances: InstanceSummary[] = [
			{ id: "pane-1", status: "online", cwd: "/p", external: true, activity: "idle" },
		];
		control = new RemoteControl({
			store: new RemoteStore(join(dir, "remote.json")),
			listInstances: () => instances,
			send: () => true,
			deleteInstance: () => false,
			webDir: dir,
		});
		setRemoteControl(control);
		const report = {
			models: [{ provider: "openai", id: "gpt-5" }],
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 },
		};
		// Kept while remote control is off, so the phone has it once it is on.
		expect(await handleIpcRequest({ type: "remote_report", instanceId: "pane-1", report })).toMatchObject({
			type: "ack",
			ok: true,
		});
		const on = await control.handle({ type: "remote", action: "on", port: 0 });
		if (on.type !== "remote_result" || !on.code) throw new Error("not listening");
		const base = `http://127.0.0.1:${on.port}`;
		const paired = await fetch(`${base}/api/pair`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: on.code, deviceName: "iPhone" }),
		});
		const { token } = (await paired.json()) as { token: string };
		const status = () =>
			fetch(`${base}/api/sessions/pane-1/status`, { headers: { authorization: `Bearer ${token}` } });
		expect(await (await status()).json()).toEqual({ report });

		const controller = new AbortController();
		const res = await fetch(`${base}/api/events?token=${token}&session=pane-1`, { signal: controller.signal });
		const reader = res.body!.getReader();
		let received = "";
		const until = async (needle: string) => {
			while (!received.includes(needle)) received += new TextDecoder().decode((await reader.read()).value);
		};
		await until(": connected");
		const next = { ...report, thinkingLevel: "high" };
		await handleIpcRequest({ type: "remote_report", instanceId: "pane-1", report: next });
		await until("event: status");
		expect(await (await status()).json()).toEqual({ report: next });
		// The same report again still signals: a compact the pane skipped or pi refused changes nothing.
		const signals = received.split("event: status").length;
		await handleIpcRequest({ type: "remote_report", instanceId: "pane-1", report: next });
		while (received.split("event: status").length === signals) {
			received += new TextDecoder().decode((await reader.read()).value);
		}
		await handleIpcRequest({ type: "unregister", instanceId: "pane-1" });
		expect((await status()).status).toBe(404);
		controller.abort();
	});

	it("drops the report of a pane that went away without unregistering, but not the sender's own", async () => {
		const pane = (id: string): InstanceSummary => ({
			id,
			status: "online",
			cwd: "/p",
			external: true,
			activity: "idle",
		});
		let instances: InstanceSummary[] = [pane("pane-1"), pane("pane-2")];
		control = new RemoteControl({
			store: new RemoteStore(join(dir, "remote.json")),
			listInstances: () => instances,
			send: () => true,
			deleteInstance: () => false,
			webDir: dir,
		});
		const report = { models: [] };
		control.report("pane-1", report);
		control.report("pane-2", report);
		// pane-2 is reaped; pane-1's next report, unchanged, prunes it.
		instances = [pane("pane-1")];
		control.report("pane-1", report);
		// A pane's first report may arrive before it is listed.
		control.report("pane-3", report);
		instances = [pane("pane-1"), pane("pane-2"), pane("pane-3")];
		const on = await control.handle({ type: "remote", action: "on", port: 0 });
		if (on.type !== "remote_result" || !on.code) throw new Error("not listening");
		const base = `http://127.0.0.1:${on.port}`;
		const paired = await fetch(`${base}/api/pair`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: on.code, deviceName: "iPhone" }),
		});
		const { token } = (await paired.json()) as { token: string };
		const status = (id: string) =>
			fetch(`${base}/api/sessions/${id}/status`, { headers: { authorization: `Bearer ${token}` } });
		expect((await status("pane-1")).status).toBe(200);
		expect((await status("pane-2")).status).toBe(404);
		expect((await status("pane-3")).status).toBe(200);
	});

	describe("push notifications", () => {
		const subscription = (endpoint: string): WebPushSubscription => ({
			endpoint,
			keys: {
				p256dh: validP256dh(),
				auth: "AAAAAAAAAAAAAAAAAAAAAA",
			},
		});
		let instances: InstanceSummary[];
		let pushes: Array<{ endpoint: string; payload: unknown }>;
		let results: Record<string, PushResult>;
		let duringPush: (() => void) | undefined;
		const pane = (activity: "working" | "idle"): InstanceSummary => ({
			id: "pane-1",
			status: "online",
			cwd: "/p",
			external: true,
			label: "fix the build",
			activity,
			turns: 1,
			detail: activity === "idle" ? "All green" : "",
		});
		const pairDevice = (store: RemoteStore) => {
			const { code } = store.createCode();
			const claimed = store.claim(code, "iPhone");
			if (!("deviceId" in claimed)) throw new Error(claimed.error);
			return claimed.deviceId;
		};

		beforeEach(() => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			instances = [pane("working")];
			pushes = [];
			results = {};
			duringPush = undefined;
			control = new RemoteControl({
				store: new RemoteStore(join(dir, "remote.json")),
				listInstances: () => instances,
				send: () => true,
				deleteInstance: () => false,
				webDir: dir,
				sendPush: async (push, payload) => {
					pushes.push({ endpoint: push.endpoint, payload: JSON.parse(payload) });
					duringPush?.();
					return results[push.endpoint] ?? "ok";
				},
			});
		});

		it("pushes to every subscribed device when a session stops working, and drops a gone subscription", async () => {
			const phone = pairDevice(control.store);
			const pad = pairDevice(control.store);
			pairDevice(control.store);
			control.store.setPush(phone, subscription("https://web.push.apple.com/phone"));
			control.store.setPush(pad, subscription("https://web.push.apple.com/pad"));
			results["https://web.push.apple.com/pad"] = "gone";
			await control.handle({ type: "remote", action: "on", port: 0 });
			await vi.advanceTimersByTimeAsync(2000);
			expect(pushes).toEqual([]);
			instances = [pane("idle")];
			await vi.advanceTimersByTimeAsync(1000);
			const payload = { title: "fix the build", body: "Done — All green", sessionId: "pane-1" };
			expect(pushes).toEqual([
				{ endpoint: "https://web.push.apple.com/phone", payload },
				{ endpoint: "https://web.push.apple.com/pad", payload },
			]);
			await vi.advanceTimersByTimeAsync(3000);
			expect(pushes).toHaveLength(2);
			expect(control.store.load().devices.map((d) => d.push?.endpoint)).toEqual([
				"https://web.push.apple.com/phone",
				undefined,
				undefined,
			]);
		});

		it("keeps the subscription a device made after the one the push service said is gone", async () => {
			const phone = pairDevice(control.store);
			control.store.setPush(phone, subscription("https://web.push.apple.com/old"));
			results["https://web.push.apple.com/old"] = "gone";
			duringPush = () => control.store.setPush(phone, subscription("https://web.push.apple.com/new"));
			await control.handle({ type: "remote", action: "on", port: 0 });
			await vi.advanceTimersByTimeAsync(1000);
			instances = [pane("idle")];
			await vi.advanceTimersByTimeAsync(1000);
			expect(pushes.map((p) => p.endpoint)).toEqual(["https://web.push.apple.com/old"]);
			expect(control.store.load().devices[0].push?.endpoint).toBe("https://web.push.apple.com/new");
		});

		it("does not send late what changed while no device was subscribed, nor while off", async () => {
			const phone = pairDevice(control.store);
			control.store.setPush(phone, subscription("https://web.push.apple.com/phone"));
			await control.handle({ type: "remote", action: "on", port: 0 });
			await vi.advanceTimersByTimeAsync(1000);
			control.store.setPush(phone, undefined);
			await vi.advanceTimersByTimeAsync(1000);
			instances = [pane("idle")];
			await vi.advanceTimersByTimeAsync(1000);
			control.store.setPush(phone, subscription("https://web.push.apple.com/phone"));
			await vi.advanceTimersByTimeAsync(2000);
			expect(pushes).toEqual([]);
			instances = [pane("working")];
			await vi.advanceTimersByTimeAsync(1000);
			await control.handle({ type: "remote", action: "off" });
			instances = [pane("idle")];
			await vi.advanceTimersByTimeAsync(3000);
			expect(pushes).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	it("acknowledges a pane's live reply and report when remote control is unavailable", async () => {
		expect(
			await handleIpcRequest({ type: "remote_live", instanceId: "pane-1", live: { text: "", tools: [] } }),
		).toMatchObject({ type: "ack", ok: true });
		expect(
			await handleIpcRequest({ type: "remote_report", instanceId: "pane-1", report: { models: [] } }),
		).toMatchObject({ type: "ack", ok: true });
	});

	it("is reached through the daemon's IPC handler", async () => {
		expect(await handleIpcRequest({ type: "remote", action: "status" })).toMatchObject({ type: "error" });
		setRemoteControl(control);
		expect(await handleIpcRequest({ type: "remote", action: "status" })).toMatchObject({
			type: "remote_result",
			enabled: false,
		});
	});
});
