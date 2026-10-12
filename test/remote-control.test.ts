import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIpcRequest, listSummaries, setRemoteControl } from "../daemon/handler.ts";
import type { InstanceSummary } from "../daemon/ipc/protocol.ts";
import { RemoteControl } from "../daemon/remote/control.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";
import type { PushResult, WebPushSubscription } from "../daemon/remote/webpush.ts";

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

	it("keeps the launch command of the latest heartbeat, rewriting remote.json only when it changes", async () => {
		setRemoteControl(control);
		const beat = (command: string[]) =>
			handleIpcRequest({
				type: "register",
				instance: { id: "pane-1", cwd: "/p", leafId: "e2", launch: { command } },
			});
		await beat(["node", "pi.js"]);
		expect(control.store.load().launch).toEqual({ command: ["node", "pi.js"] });
		expect(listSummaries().find((i) => i.id === "pane-1")).toMatchObject({ external: true, leafId: "e2" });
		const written = statSync(join(dir, "remote.json")).ino;
		await beat(["node", "pi.js"]);
		control = make();
		setRemoteControl(control);
		await beat(["node", "pi.js"]);
		expect(statSync(join(dir, "remote.json")).ino).toBe(written);
		await control.handle({ type: "remote", action: "off" });
		expect(control.store.load().launch).toEqual({ command: ["node", "pi.js"] });
		await beat(["node", "other.js"]);
		expect(control.launch()).toEqual({ command: ["node", "other.js"] });
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

	describe("push notifications", () => {
		const subscription = (endpoint: string): WebPushSubscription => ({
			endpoint,
			keys: {
				p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url"),
				auth: "AAAAAAAAAAAAAAAAAAAAAA",
			},
		});
		let instances: InstanceSummary[];
		let pushes: Array<{ endpoint: string; payload: unknown }>;
		let results: Record<string, PushResult>;
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
			control = new RemoteControl({
				store: new RemoteStore(join(dir, "remote.json")),
				listInstances: () => instances,
				send: () => true,
				deleteInstance: () => false,
				webDir: dir,
				sendPush: async (push, payload) => {
					pushes.push({ endpoint: push.endpoint, payload: JSON.parse(payload) });
					return results[push.endpoint] ?? "ok";
				},
			});
		});

		it("pushes to every subscribed device when a session stops working, and drops a gone subscription", async () => {
			const phone = pairDevice(control.store);
			const pad = pairDevice(control.store);
			pairDevice(control.store);
			control.store.setPush(phone, subscription("https://push.test/phone"));
			control.store.setPush(pad, subscription("https://push.test/pad"));
			results["https://push.test/pad"] = "gone";
			await control.handle({ type: "remote", action: "on", port: 0 });
			await vi.advanceTimersByTimeAsync(2000);
			expect(pushes).toEqual([]);
			instances = [pane("idle")];
			await vi.advanceTimersByTimeAsync(1000);
			const payload = { title: "fix the build", body: "Done — All green", sessionId: "pane-1" };
			expect(pushes).toEqual([
				{ endpoint: "https://push.test/phone", payload },
				{ endpoint: "https://push.test/pad", payload },
			]);
			await vi.advanceTimersByTimeAsync(3000);
			expect(pushes).toHaveLength(2);
			expect(control.store.load().devices.map((d) => d.push?.endpoint)).toEqual([
				"https://push.test/phone",
				undefined,
				undefined,
			]);
		});

		it("does not send late what changed while no device was subscribed, nor while off", async () => {
			const phone = pairDevice(control.store);
			control.store.setPush(phone, subscription("https://push.test/phone"));
			await control.handle({ type: "remote", action: "on", port: 0 });
			await vi.advanceTimersByTimeAsync(1000);
			control.store.setPush(phone, undefined);
			await vi.advanceTimersByTimeAsync(1000);
			instances = [pane("idle")];
			await vi.advanceTimersByTimeAsync(1000);
			control.store.setPush(phone, subscription("https://push.test/phone"));
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

	it("acknowledges a pane's live reply when remote control is unavailable", async () => {
		expect(
			await handleIpcRequest({ type: "remote_live", instanceId: "pane-1", live: { text: "", tools: [] } }),
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
