import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
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

	it("sends a replay snapshot once and keeps subsequent assistant updates as compact wire deltas", async () => {
		const handler = (async () => ({
			type: "rpc_ready",
			ok: true,
			instance: { id: "worker" },
		})) as unknown as IpcRequestHandler;
		const message = fauxAssistantMessage("Earlier");
		let emit!: (event: AgentSessionEvent) => void;
		handler.openRpcStream = (_id, _response, onEvent) => {
			emit = onEvent;
			onEvent({ type: "message_start", message });
			return { handleRequest: async () => {}, close: () => {} };
		};
		server = await startIpcServer(handler);
		const socket = createConnection(join(tempDir, "server.sock"));
		const frames: Array<Record<string, unknown>> = [];
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const index = buffer.indexOf("\n");
				frames.push(JSON.parse(buffer.slice(0, index)));
				buffer = buffer.slice(index + 1);
			}
		});
		try {
			await new Promise<void>((resolve) => socket.on("connect", resolve));
			socket.write(`${JSON.stringify({ type: "rpc_stream", instanceId: "worker" })}\n`);
			await vi.waitFor(() => expect(frames.some((frame) => frame.type === "rpc_ready")).toBe(true));
			emit({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " more" },
			} as AgentSessionEvent);
			await vi.waitFor(() => expect(frames.some((frame) => frame.type === "message_update")).toBe(true));
			expect(frames.find((frame) => frame.type === "message_start")).toMatchObject({
				message: { content: [{ text: "Earlier" }] },
			});
			const delta = frames.find((frame) => frame.type === "message_update");
			expect(delta).not.toHaveProperty("message");
			expect(delta).toMatchObject({ assistantMessageEvent: { type: "text_delta", delta: " more" } });
		} finally {
			socket.destroy();
		}
	});
});
