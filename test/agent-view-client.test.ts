import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type IpcRequestHandler, startIpcServer } from "../daemon/ipc/server.ts";
import type { ViewEvent, ViewTerminal } from "../daemon/view-types.ts";
import { OrchestratorClient } from "../ext/agent-view/orchestrator-client.ts";
import { SessionViewClient } from "../ext/agent-view/view-client.ts";
import { FakeViewChild } from "./support/fake-view-child.ts";
import { textDelta } from "./support/view-fixtures.ts";

vi.mock("../daemon/rpc-process.ts", () => ({
	createRpcProcessInstance: (opts: { sessionFile?: string }) => new FakeViewChild(opts),
}));
const { supervisor } = await import("../daemon/supervisor.ts");
const { handleIpcRequest, openRpcStream, openViewStream } = await import("../daemon/handler.ts");
let dir: string;
let path: string;
let server: Server | undefined;
let handles: Array<{ close(): void }>;
let sockets: Socket[];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "view-client-"));
	path = join(dir, "server.sock");
	vi.stubEnv("PI_SERVER_DIR", dir);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(dir, "agent"));
	vi.stubEnv("RADIUS_API_KEY", "");
	FakeViewChild.children = [];
	handles = [];
	sockets = [];
});
afterEach(async () => {
	vi.useRealTimers();
	for (const h of handles) h.close();
	for (const s of sockets) s.destroy();
	await supervisor.shutdown();
	if (server) await new Promise<void>((r) => server!.close(() => r()));
	server = undefined;
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});
async function daemon(earlyEvent = false) {
	const handler = Object.assign(((request) => handleIpcRequest(request)) as IpcRequestHandler, {
		openRpcStream,
		openViewStream: (id: string, onRecord: (record: ViewEvent | ViewTerminal) => void) => {
			const result = openViewStream(id, onRecord);
			if (earlyEvent) FakeViewChild.children[0].emit({ type: "agent_start" });
			return result;
		},
	});
	server = await startIpcServer(handler);
	const row = await supervisor.spawnInstance({ cwd: dir });
	return row.id;
}
async function view(
	id: string,
	onRecord: (record: ViewEvent | ViewTerminal) => void = () => {},
	onDisconnect: (error?: Error) => void = () => {},
) {
	const h = await new SessionViewClient(path).open(id, { onRecord, onDisconnect });
	handles.push(h);
	return h;
}
async function wire(first: unknown[]) {
	const socket = createConnection(path);
	sockets.push(socket);
	const frames: Array<Record<string, unknown>> = [];
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += decoder.write(chunk);
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			frames.push(JSON.parse(buffer.slice(0, nl)));
			buffer = buffer.slice(nl + 1);
		}
	});
	socket.on("error", () => {});
	await new Promise<void>((r) =>
		socket.once("connect", () => {
			socket.write(first.map((x) => JSON.stringify(x) + "\n").join(""));
			r();
		}),
	);
	return { socket, frames };
}
describe("persistent view JSONL transport", () => {
	it("handshake deadline closes a silent socket", async () => {
		await daemon();
		server!.close();
		await new Promise<void>((resolve) => server!.once("close", resolve));
		server = createServer((socket) => socket.on("data", () => {}));
		await new Promise<void>((resolve) => server!.listen(path, resolve));
		vi.useFakeTimers();
		const onDisconnect = vi.fn();
		const opening = new SessionViewClient(path).open("silent", { onRecord: () => {}, onDisconnect });
		const rejection = expect(opening).rejects.toThrow("handshake timed out");
		await vi.advanceTimersByTimeAsync(10_000);
		await rejection;
		expect(onDisconnect).not.toHaveBeenCalled();
		expect(FakeViewChild.children[0].disposed).toBe(false);
	});
	it("times out an unacknowledged command but never stops the child", async () => {
		const id = await daemon();
		const errors: Error[] = [];
		const h = await view(
			id,
			() => {},
			(error) => {
				if (error) errors.push(error);
			},
		);
		let seen = false;
		FakeViewChild.children[0].send = () => {
			seen = true;
			return new Promise(() => {});
		};
		vi.useFakeTimers();
		const pending = h.send({ type: "prompt", message: "do not resend" });
		const rejection = expect(pending).rejects.toThrow("may have been accepted");
		await vi.waitFor(() => expect(seen).toBe(true));
		await vi.advanceTimersByTimeAsync(30_000);
		await rejection;
		expect(errors).toHaveLength(1);
		expect(FakeViewChild.children[0].disposed).toBe(false);
	});

	it("ready precedes live events", async () => {
		const id = await daemon(true);
		const { frames } = await wire([{ type: "view_stream", instanceId: id, viewProtocol: 1 }]);
		await vi.waitFor(() => expect(frames).toHaveLength(2));
		expect(frames.map((x) => x.type)).toEqual(["view_ready", "view_event"]);
		expect(frames[1].sequence).toBe(Number(frames[0].sequence) + 1);
	});
	it("early buffered command is not dropped", async () => {
		const id = await daemon();
		const { frames } = await wire([
			{ type: "view_stream", instanceId: id, viewProtocol: 1 },
			{ type: "prompt", id: "early", message: "hi" },
		]);
		await vi.waitFor(() => expect(frames.some((x) => x.id === "early")).toBe(true));
		expect(frames[0].type).toBe("view_ready");
		expect(FakeViewChild.children[0].sent).toContainEqual({ type: "prompt", id: "early", message: "hi" });
	});
	it("split UTF8 and coalesced JSONL frames", async () => {
		const id = await daemon();
		const sourceHandle = supervisor.openViewStream(id, () => {})!;
		const source = sourceHandle.ready;
		sourceHandle.close();
		server!.close();
		await new Promise<void>((r) => server!.once("close", r));
		server = createServer((socket) =>
			socket.once("data", () => {
				const event = {
					type: "view_event",
					generation: source.generation,
					sequence: 1,
					event: textDelta("👋\u2028done"),
				};
				const bytes = Buffer.from(JSON.stringify(source) + "\n" + JSON.stringify(event) + "\n");
				const emoji = bytes.indexOf(Buffer.from("👋"));
				socket.write(bytes.subarray(0, emoji + 1));
				setImmediate(() => socket.write(bytes.subarray(emoji + 1)));
			}),
		);
		await new Promise<void>((r) => server!.listen(path, r));
		const events: Array<ViewEvent | ViewTerminal> = [];
		await view(id, (e) => events.push(e));
		await vi.waitFor(() => expect(events).toHaveLength(1));
		expect(events[0]).toMatchObject({ event: { assistantMessageEvent: { delta: "👋\u2028done" } } });
	});
	it("out of order responses match ids", async () => {
		const id = await daemon();
		const h = await view(id);
		const queued: RpcCommand[] = [];
		FakeViewChild.children[0].send = (command) => {
			queued.push(command);
			return new Promise<RpcResponse>((resolve) => {
				setTimeout(
					() => resolve({ type: "response", id: command.id, command: command.type, success: true } as RpcResponse),
					command.type === "get_messages" ? 30 : 1,
				);
			});
		};
		const [a, b] = await Promise.all([h.send({ type: "get_messages" }), h.send({ type: "get_state" })]);
		expect(a.command).toBe("get_messages");
		expect(b.command).toBe("get_state");
		expect(a.id).not.toBe(b.id);
		expect(queued).toHaveLength(2);
	});
	it("dialog answer bypasses slow command", async () => {
		const id = await daemon();
		const h = await view(id);
		const child = FakeViewChild.children[0];
		const send = child.send.bind(child);
		let release!: (response: RpcResponse) => void;
		child.send = (command) => {
			if (command.type === "compact") {
				child.sent.push(command);
				return new Promise((r) => {
					release = r;
				});
			}
			return send(command);
		};
		const command = h.send({ type: "compact" });
		await vi.waitFor(() => expect(release).toBeTypeOf("function"));
		child.ui({ type: "extension_ui_request", method: "confirm", id: "q", title: "confirm", message: "yes?" });
		expect(await h.answer({ type: "extension_ui_response", id: "q", confirmed: true })).toBe(true);
		expect(await h.answer({ type: "extension_ui_response", id: "q", confirmed: false })).toBe(false);
		release({
			type: "response",
			id: child.sent.find((x) => x.type === "compact")?.id,
			command: "compact",
			success: true,
			data: { summary: "done", firstKeptEntryId: "entry", tokensBefore: 1 },
		});
		expect((await command).success).toBe(true);
		h.close();
		expect(child.disposed).toBe(false);
	});
	it("close rejects pending requests without resending", async () => {
		const id = await daemon();
		const h = await view(id);
		FakeViewChild.children[0].send = () => new Promise(() => {});
		const pending = h.send({ type: "prompt", message: "only once" });
		h.close();
		h.close();
		await expect(pending).rejects.toThrow("closed");
		expect(FakeViewChild.children[0].disposed).toBe(false);
	});
	it("unknown protocol fails without stopping child", async () => {
		const id = await daemon();
		const { frames } = await wire([{ type: "view_stream", instanceId: id, viewProtocol: 99 }]);
		await vi.waitFor(() => expect(frames).toHaveLength(1));
		expect(frames[0]).toMatchObject({ type: "error", ok: false });
		expect(FakeViewChild.children[0].disposed).toBe(false);
	});
	it("raw rpc_stream remains compatible with buffered commands", async () => {
		const id = await daemon();
		const { frames } = await wire([
			{ type: "rpc_stream", instanceId: id },
			{ type: "get_state", id: "old" },
		]);
		await vi.waitFor(() => expect(frames.some((x) => x.id === "old")).toBe(true));
		expect(frames[0].type).toBe("rpc_ready");
		expect(FakeViewChild.children[0].disposed).toBe(false);
	});
	it("malformed frames detach without stopping child", async () => {
		const id = await daemon();
		const { socket, frames } = await wire([{ type: "view_stream", instanceId: id, viewProtocol: 1 }]);
		await vi.waitFor(() => expect(frames).toHaveLength(1));
		socket.write("{oops\n");
		await new Promise<void>((r) => socket.once("close", () => r()));
		expect(FakeViewChild.children[0].disposed).toBe(false);
		expect((await new OrchestratorClient(path).getDaemonInfo()).running).toBe(true);
	});
	it("aborted handshake and oversized frames fail explicitly", async () => {
		await daemon();
		const abort = new AbortController();
		abort.abort();
		await expect(
			new SessionViewClient(path).open("none", { signal: abort.signal, onRecord: () => {}, onDisconnect: () => {} }),
		).rejects.toThrow("abort");
		const id = supervisor.listInstances()[0].id;
		const errors: Error[] = [];
		await view(
			id,
			() => {},
			(e) => {
				if (e) errors.push(e);
			},
		);
		FakeViewChild.children[0].emit(textDelta("x".repeat(16 * 1024 * 1024)));
		await vi.waitFor(() => expect(errors).toHaveLength(1));
		expect(FakeViewChild.children[0].disposed).toBe(false);
	});
	it("history and metadata advertise version one", async () => {
		await daemon();
		const client = new OrchestratorClient(path);
		expect((await client.getDaemonInfo()).viewProtocol).toBe(1);
		const file = join(dir, "history.jsonl");
		const entries = [
			{ type: "session", id: "h", version: 3, cwd: dir, timestamp: "2026-10-05T00:00:00Z" },
			...Array.from({ length: 205 }, (_, i) => ({
				type: "message",
				id: String(i),
				parentId: i ? String(i - 1) : null,
				timestamp: "2026-10-05T00:00:00Z",
				message: { role: "user", content: [{ type: "text", text: String(i) }], timestamp: i },
			})),
		];
		writeFileSync(file, entries.map((x) => JSON.stringify(x)).join("\n") + "\n");
		const row = supervisor.saveInstance({ cwd: dir, sessionFile: file });
		const page = await client.history(row.id);
		expect(page.messages).toHaveLength(200);
		expect((await client.history(row.id, page.before)).messages).toHaveLength(5);
	});
});
