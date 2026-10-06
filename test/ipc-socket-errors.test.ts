import { mkdtemp, rm } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendIpcRequest } from "../daemon/ipc/client.ts";
import { startIpcServer } from "../daemon/ipc/server.ts";
import { OrchestratorClient } from "../ext/agent-view/orchestrator-client.ts";

/** Every client socket the code under test opens, so a test can fail one after the reply. */
const clientSockets: net.Socket[] = [];
vi.mock("node:net", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:net")>();
	const createConnection = ((...args: Parameters<typeof actual.createConnection>) => {
		const socket = actual.createConnection(...args);
		clientSockets.push(socket);
		return socket;
	}) as typeof actual.createConnection;
	return { ...actual, createConnection };
});

/**
 * A connection reset (a client timing out, a pi exiting mid-request) surfaces as an
 * `'error'` event; with no listener Node rethrows it, which kills the daemon or the pi.
 */
describe("IPC socket errors", () => {
	let dir: string;
	let server: net.Server | undefined;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bluclawd-ipc-errors-"));
		vi.stubEnv("PI_SERVER_DIR", dir);
		clientSockets.length = 0;
	});
	afterEach(async () => {
		server?.close();
		server = undefined;
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	});

	const listHandler = async () => ({ type: "list_result", ok: true, instances: [] }) as never;

	it("the daemon survives an error on a client's connection", async () => {
		server = await startIpcServer(listHandler);
		const connected = new Promise<net.Socket>((resolve) => server?.once("connection", resolve));
		const client = net.createConnection(join(dir, "server.sock"));
		const daemonSide = await connected;
		expect(() => daemonSide.emit("error", Object.assign(new Error("reset"), { code: "ECONNRESET" }))).not.toThrow();
		client.destroy();
	});

	it("sendIpcRequest leaves no socket that can throw after the reply", async () => {
		server = await startIpcServer(listHandler);
		await sendIpcRequest({ type: "list" });
		expect(clientSockets).toHaveLength(1);
		expect(() => clientSockets[0].emit("error", new Error("late reset"))).not.toThrow();
	});

	it("OrchestratorClient leaves no socket that can throw after the reply", async () => {
		server = await startIpcServer(listHandler);
		await new OrchestratorClient(join(dir, "server.sock")).list();
		expect(clientSockets).toHaveLength(1);
		expect(() => clientSockets[0].emit("error", new Error("late reset"))).not.toThrow();
	});
});
