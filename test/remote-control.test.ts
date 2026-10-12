import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleIpcRequest, listSummaries, setRemoteControl } from "../daemon/handler.ts";
import { RemoteControl } from "../daemon/remote/control.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";

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

	it("is reached through the daemon's IPC handler", async () => {
		expect(await handleIpcRequest({ type: "remote", action: "status" })).toMatchObject({ type: "error" });
		setRemoteControl(control);
		expect(await handleIpcRequest({ type: "remote", action: "status" })).toMatchObject({
			type: "remote_result",
			enabled: false,
		});
	});
});
