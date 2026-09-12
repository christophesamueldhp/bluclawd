import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleIpcRequest, setShutdownHook, shutdownRefusal } from "../daemon/handler.ts";
import { OrchestratorClient } from "../ext/fleet/orchestrator-client.ts";

describe("daemon `shutdown` request", () => {
	afterEach(() => setShutdownHook(undefined));

	it("refuses while spawned sessions are still running, and says how many", () => {
		expect(shutdownRefusal(0)).toBeUndefined();
		expect(shutdownRefusal(1)).toBe("1 running session");
		expect(shutdownRefusal(3)).toBe("3 running sessions");
	});

	it("answers ok and then hands off to the process's shutdown hook", async () => {
		let called = 0;
		setShutdownHook(() => {
			called++;
		});
		const response = await handleIpcRequest({ type: "shutdown" });
		expect(response).toMatchObject({ type: "shutdown_result", ok: true });
		expect(called).toBe(0); // deferred, so the reply is written first
		await new Promise((r) => setTimeout(r, 150));
		expect(called).toBe(1);
	});

	it("is an error when no shutdown hook is installed", async () => {
		const response = await handleIpcRequest({ type: "shutdown" });
		expect(response.ok).toBe(false);
	});
});

describe("OrchestratorClient.shutdownDaemon", () => {
	let dir: string;
	let server: Server | undefined;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bluclawd-shutdown-"));
	});
	afterEach(async () => {
		server?.close();
		server = undefined;
		await rm(dir, { recursive: true, force: true });
	});

	/** A daemon stand-in: answers list/shutdown; on shutdown, stops listening shortly after. */
	function fakeDaemon(socketPath: string, onShutdown: () => { ok: boolean; error?: string }) {
		server = createServer((socket) => {
			socket.on("data", (chunk) => {
				const req = JSON.parse(chunk.toString().trim()) as { type: string };
				if (req.type === "list")
					socket.end(`${JSON.stringify({ type: "list_result", ok: true, instances: [] })}\n`);
				else if (req.type === "shutdown") {
					const verdict = onShutdown();
					socket.end(`${JSON.stringify({ type: verdict.ok ? "shutdown_result" : "error", ...verdict })}\n`);
					if (verdict.ok) setTimeout(() => server?.close(), 50);
				} else socket.end(`${JSON.stringify({ type: "error", ok: false, error: "unknown" })}\n`);
			});
		});
		return new Promise<void>((resolve) => server?.listen(socketPath, resolve));
	}

	it("resolves once the daemon has actually gone away", async () => {
		const socketPath = join(dir, "server.sock");
		await fakeDaemon(socketPath, () => ({ ok: true }));
		const client = new OrchestratorClient(socketPath);
		expect(await client.shutdownDaemon()).toEqual({ ok: true });
		expect(await client.isRunning()).toBe(false);
	});

	it("reports the daemon's refusal instead of waiting", async () => {
		const socketPath = join(dir, "server.sock");
		await fakeDaemon(socketPath, () => ({ ok: false, error: "2 running sessions" }));
		const client = new OrchestratorClient(socketPath);
		expect(await client.shutdownDaemon()).toEqual({ ok: false, reason: "2 running sessions" });
		expect(await client.isRunning()).toBe(true);
	});

	it("recognises a pre-verb daemon by its typeless reply and says to restart it by hand", async () => {
		const socketPath = join(dir, "server.sock");
		server = createServer((socket) => {
			socket.on("data", () => socket.end(`${JSON.stringify({ version: "0.85.1", buildId: "old" })}\n`));
		});
		await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
		const client = new OrchestratorClient(socketPath);
		const result = await client.shutdownDaemon();
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("predates");
	});

	it("treats a daemon that does not know the verb as a refusal, not a crash", async () => {
		const socketPath = join(dir, "server.sock");
		server = createServer((socket) => {
			socket.on("data", () =>
				socket.end(`${JSON.stringify({ type: "error", ok: false, error: "Unknown request" })}\n`),
			);
		});
		await new Promise<void>((resolve) => server?.listen(socketPath, resolve));
		const client = new OrchestratorClient(socketPath);
		expect((await client.shutdownDaemon()).ok).toBe(false);
	});
});
