import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIpcRequest } from "../daemon/handler.ts";
import { startIpcServer } from "../daemon/ipc/server.ts";
import { supervisor } from "../daemon/supervisor.ts";
import { OrchestratorClient, type PaneMessage } from "../ext/agent-view/orchestrator-client.ts";
import { SelfRegistration } from "../ext/agent-view/self-registration.ts";

/** A real daemon socket in a temp PI_SERVER_DIR, with a pane's registration as its client. */
describe("instant delivery to a pane", () => {
	let dir: string;
	let server: Server;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bluclawd-wait-"));
		vi.stubEnv("PI_SERVER_DIR", dir);
		server = await startIpcServer(handleIpcRequest);
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
		await vi.waitFor(() =>
			expect(supervisor.listExternalInstances().some((e) => e.record.id === "pane-wait-e2e")).toBe(true),
		);
		// Its wait reaches the daemon right after the first register.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const sent = Date.now();
		expect(supervisor.sendExternal("pane-wait-e2e", { type: "prompt", text: "hi" })).toBe(true);
		await vi.waitFor(() => expect(handled).toHaveLength(1), { timeout: 1000, interval: 5 });
		expect(handled[0].message).toEqual({ type: "prompt", text: "hi" });
		expect(handled[0].at - sent).toBeLessThan(100);
		await reg.stop();
		expect(supervisor.listExternalInstances().some((e) => e.record.id === "pane-wait-e2e")).toBe(false);
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
});
