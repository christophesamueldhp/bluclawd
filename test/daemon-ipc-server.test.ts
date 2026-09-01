import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILD_ID, VERSION } from "../daemon/config.ts";
import { type IpcRequestHandler, startIpcServer } from "../daemon/ipc/server.ts";

/**
 * Every response the daemon sends should carry its own version/buildId, so a
 * client can detect a stale (already-running, since-rebuilt) daemon.
 *
 * Isolation: PI_SERVER_DIR is stubbed to a fresh tmpdir per test so this never
 * touches a real running daemon on the machine.
 */
describe("startIpcServer — version echo", () => {
	let tempDir: string;
	let server: Server | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "bluclawd-ipc-server-test-"));
		vi.stubEnv("PI_SERVER_DIR", tempDir);
	});

	afterEach(async () => {
		server?.close();
		server = undefined;
		vi.unstubAllEnvs();
		await rm(tempDir, { recursive: true, force: true });
	});

	function fakeHandler(): IpcRequestHandler {
		const handler = (async (request: { type: string }) => {
			if (request.type === "list") return { type: "list_result", ok: true, instances: [] };
			return { type: "error", ok: false, error: "unsupported in this test" };
		}) as IpcRequestHandler;
		handler.openRpcStream = () => undefined;
		return handler;
	}

	async function sendRaw(socketPath: string, line: string): Promise<Record<string, unknown>> {
		return new Promise((resolve, reject) => {
			const socket = createConnection(socketPath);
			let buffer = "";
			socket.on("connect", () => socket.write(`${line}\n`));
			socket.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const nl = buffer.indexOf("\n");
				if (nl === -1) return;
				resolve(JSON.parse(buffer.slice(0, nl)));
				socket.end();
			});
			socket.on("error", reject);
		});
	}

	it("echoes version and buildId on a normal response", async () => {
		server = await startIpcServer(fakeHandler());
		const response = await sendRaw(join(tempDir, "server.sock"), JSON.stringify({ type: "list" }));

		expect(response.type).toBe("list_result");
		expect(response.version).toBe(VERSION);
		expect(response.buildId).toBe(BUILD_ID);
		expect(typeof response.buildId).toBe("string");
	});

	it("echoes version and buildId even on a parse-error response", async () => {
		server = await startIpcServer(fakeHandler());
		const response = await sendRaw(join(tempDir, "server.sock"), "not json");

		expect(response.ok).toBe(false);
		expect(response.version).toBe(VERSION);
		expect(response.buildId).toBe(BUILD_ID);
	});
});
