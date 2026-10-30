import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIpcRequest } from "../daemon/handler.ts";
import { startIpcServer } from "../daemon/ipc/server.ts";
import { OrchestratorClient, type PaneMessage } from "../daemon/orchestrator-client.ts";
import type { ServerSupervisor } from "../daemon/supervisor.ts";
import { SelfRegistration } from "../ext/agent-view/self-registration.ts";
import { testRegistry } from "./helpers/registry.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** A real daemon socket in a temp PI_SERVER_DIR, with a pane's registration as its client. */
describe("instant delivery to a pane", () => {
	let dir: string;
	let server: Server;
	let supervisor: ServerSupervisor;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bluclawd-wait-"));
		vi.stubEnv("PI_SERVER_DIR", dir);
		supervisor = testRegistry(dir);
		server = await startIpcServer((request) => handleIpcRequest(supervisor, request));
	});

	afterEach(async () => {
		supervisor.settleWaits();
		await new Promise((resolve) => server.close(resolve));
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	});

	it("refuses a wait for a pane that is not registered", async () => {
		await expect(new OrchestratorClient().wait("pane-unknown", new AbortController().signal)).rejects.toThrow(
			"Unknown instance: pane-unknown",
		);
	});

	it("hands a queued prompt to the pane at once, not at its next heartbeat", async () => {
		const handled: Array<{ message: PaneMessage; at: number }> = [];
		const reg = new SelfRegistration(
			new OrchestratorClient(),
			() => ({ cwd: dir }),
			(message) => handled.push({ message, at: Date.now() }),
			"pane-wait-e2e",
		);
		reg.start();
		await waitFor(() =>
			expect(supervisor.listExternalInstances().some((e) => e.record.id === "pane-wait-e2e")).toBe(true),
		);
		// Its wait reaches the daemon right after the first register.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const sent = Date.now();
		expect(supervisor.sendExternal("pane-wait-e2e", { type: "prompt", text: "hi" })).toBe(true);
		await waitFor(() => expect(handled).toHaveLength(1));
		expect(handled[0].message).toEqual({ type: "prompt", text: "hi" });
		expect(handled[0].at - sent).toBeLessThan(500);
		await reg.stop();
		expect(supervisor.listExternalInstances().some((e) => e.record.id === "pane-wait-e2e")).toBe(false);
	});

	it("hands a pane several MB of images, and text cut across many reads, within its register's timeout", async () => {
		const client = new OrchestratorClient();
		await client.register({ id: "pane-images", cwd: dir });
		const png = Buffer.alloc(5 * 1024 * 1024, 7);
		png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const messages: PaneMessage[] = [
			{ type: "prompt", text: "look", images: [{ mimeType: "image/png", data: png.toString("base64") }] },
			// Three bytes a character: some fall across the socket's reads.
			{ type: "prompt", text: "✻".repeat(200_000) },
		];
		for (const message of messages) supervisor.sendExternal("pane-images", message);
		const { messages: delivered } = await client.register({ id: "pane-images", cwd: dir });
		expect(delivered).toEqual(messages);
		await client.unregister("pane-images");
	});

	it("keeps the messages a register drains while the pane is busy for over a second", async () => {
		const client = new OrchestratorClient();
		await client.register({ id: "pane-busy", cwd: dir });
		supervisor.sendExternal("pane-busy", { type: "prompt", text: "hi" });
		const registering = client.register({ id: "pane-busy", cwd: dir });
		const until = Date.now() + 1500;
		while (Date.now() < until) {
			// the pane's event loop is busy
		}
		await expect(registering).resolves.toMatchObject({ messages: [{ type: "prompt", text: "hi" }] });
		await client.unregister("pane-busy");
	});

	it("answers a pending wait at shutdown", async () => {
		const client = new OrchestratorClient();
		await client.register({ id: "pane-wait-settle", cwd: dir });
		const waiting = client.wait("pane-wait-settle", new AbortController().signal);
		await new Promise((resolve) => setTimeout(resolve, 50));
		supervisor.settleWaits();
		await expect(waiting).resolves.toBe(false);
		await client.unregister("pane-wait-settle");
	});

	it("ends an aborted wait at once", async () => {
		const client = new OrchestratorClient();
		await client.register({ id: "pane-wait-abort", cwd: dir });
		const controller = new AbortController();
		const waiting = client.wait("pane-wait-abort", controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 20));
		controller.abort();
		await expect(waiting).rejects.toThrow("aborted");
		await client.unregister("pane-wait-abort");
	});

	it("does not connect for a wait already aborted, and leaves no listener on a wait's signal", async () => {
		let connections = 0;
		server.on("connection", () => connections++);
		const client = new OrchestratorClient();
		await client.register({ id: "pane-wait-signal", cwd: dir });
		connections = 0;
		const controller = new AbortController();
		controller.abort();
		await expect(client.wait("pane-wait-signal", controller.signal)).rejects.toThrow("aborted");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(connections).toBe(0);

		const signal = new AbortController().signal;
		const waiting = client.wait("pane-wait-signal", signal);
		await new Promise((resolve) => setTimeout(resolve, 50));
		supervisor.settleWaits();
		await expect(waiting).resolves.toBe(false);
		expect(getEventListeners(signal, "abort")).toHaveLength(0);
		await client.unregister("pane-wait-signal");
	});

	it("does not loop on waits when two live registrations share a pane id", async () => {
		const waits = vi.spyOn(supervisor, "waitExternal");
		const regs = [0, 1].map(
			() =>
				new SelfRegistration(
					new OrchestratorClient(),
					() => ({ cwd: dir }),
					() => {},
					"pane-wait-shared",
				),
		);
		for (const reg of regs) reg.start();
		await new Promise((resolve) => setTimeout(resolve, 1000));
		for (const reg of regs) await reg.stop();
		expect(waits.mock.calls.length).toBeGreaterThan(0);
		expect(waits.mock.calls.length).toBeLessThan(10);
		waits.mockRestore();
	});
});
