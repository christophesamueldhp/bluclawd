import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setSharedTheme } from "../ext/_shared/theme.ts";
import { AgentView } from "../ext/agent-view/agent-view.ts";
import { NativeAttachment } from "../ext/agent-view/native-attachment.ts";
import type { InstanceSummary, OrchestratorClient } from "../ext/agent-view/orchestrator-client.ts";
import { attachRpc } from "../ext/agent-view/rpc-attachment.ts";

const plain = {
	fg: (_: string, text: string) => text,
	bg: (_: string, text: string) => text,
	bold: (text: string) => text,
	getBgAnsi: () => "",
	getColorMode: () => "truecolor",
} as unknown as Theme;
const worker: InstanceSummary = {
	id: "worker",
	cwd: "/p",
	status: "online",
	activity: "working",
	sessionFile: "/p/session.jsonl",
	label: "Live task",
};
const tui = { terminal: { rows: 30, columns: 100 }, requestRender: vi.fn() } as unknown as TUI;
beforeAll(() => {
	initTheme("dark", false);
	setSharedTheme(plain);
});
afterEach(() => vi.useRealTimers());

describe("Agent View attach/detach", () => {
	it.each(["working", "awaiting_input", "idle"] as const)(
		"opens a %s worker without stopping it or replacing the foreground runtime",
		async (activity) => {
			const row = { ...worker, activity };
			let detach!: () => void;
			const connection = {
				connect: vi.fn(async () => {}),
				close: vi.fn(),
				render: () => ["Native live conversation"],
				handleInput: vi.fn(),
				invalidate: () => {},
			};
			const attachSession = vi.fn((_instance, close) => {
				detach = close;
				return connection;
			});
			const client = { list: async () => [row], stop: vi.fn(), releaseIdle: vi.fn(), spawn: vi.fn() };
			const nativeSwitch = vi.fn();
			const view = new AgentView({
				ui: tui,
				client: client as unknown as OrchestratorClient,
				appName: "bluclawd",
				cwd: "/p",
				home: "/home",
				onClose: () => {},
				onOpen: nativeSwitch,
				attachSession,
			});
			view.setInstancesForTest([row]);
			view.handleInput("\r");
			await vi.waitFor(() => expect(connection.connect).toHaveBeenCalledOnce());
			expect(view.render(100)).toEqual(["Native live conversation"]);
			expect(client.stop).not.toHaveBeenCalled();
			expect(client.releaseIdle).not.toHaveBeenCalled();
			expect(client.spawn).not.toHaveBeenCalled();
			expect(nativeSwitch).not.toHaveBeenCalled();
			detach();
			expect(connection.close).toHaveBeenCalledOnce();
			expect(view.render(100).join("\n")).toContain("Live task");
			view.handleInput("\r");
			await vi.waitFor(() => expect(connection.connect).toHaveBeenCalledTimes(2));
			view.close();
		},
	);
	it("cancelling an attachment closes only the viewer when its handshake eventually finishes", async () => {
		let complete!: () => void;
		let detach!: () => void;
		const connection = {
			connect: () =>
				new Promise<void>((resolve) => {
					complete = resolve;
				}),
			close: vi.fn(),
			render: () => [],
			handleInput: () => detach(),
			invalidate: () => {},
		};
		const view = new AgentView({
			ui: tui,
			client: { list: async () => [worker] } as unknown as OrchestratorClient,
			appName: "bluclawd",
			cwd: "/p",
			home: "/home",
			onClose: () => {},
			onOpen: vi.fn(),
			attachSession: (_row, close) => {
				detach = close;
				return connection;
			},
		});
		view.setInstancesForTest([worker]);
		view.handleInput("\r");
		await vi.waitFor(() => expect(complete).toBeDefined());
		view.handleInput("\x1b[D");
		complete();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(connection.close).toHaveBeenCalled();
		expect(view.render(100).join("\n")).toContain("Live task");
		view.close();
	});
});

describe("native Pi conversation components", () => {
	function setup() {
		let event!: (event: unknown) => void;
		let uiRequest!: (request: unknown) => void;
		const commands: Array<Record<string, unknown>> = [];
		const answers: unknown[] = [];
		const assistant = {
			role: "assistant",
			timestamp: 2,
			content: [{ type: "text", text: "**Native markdown**" }],
			api: "openai-responses",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		};
		const connection = {
			request: vi.fn(async (command: Record<string, unknown>) => {
				commands.push(command);
				if (command.type === "get_state")
					return {
						type: "response",
						success: true,
						command: "get_state",
						data: { isStreaming: true, model: { name: "Test model" }, thinkingLevel: "medium" },
					};
				if (command.type === "get_entries") {
					// The same final message can arrive in the snapshot and the event stream.
					event({ type: "message_end", message: assistant });
					return {
						type: "response",
						success: true,
						command: "get_entries",
						data: {
							leafId: "a",
							entries: [
								{
									id: "u",
									parentId: null,
									type: "message",
									message: { role: "user", content: "hello", timestamp: 1 },
								},
								{
									id: "abandoned",
									parentId: "u",
									type: "message",
									message: { role: "user", content: "Abandoned branch", timestamp: 3 },
								},
								{ id: "a", parentId: "u", type: "message", message: assistant },
							],
						},
					};
				}
				return { type: "response", command: command.type, success: true };
			}),
			answer: (answer: unknown) => answers.push(answer),
			close: vi.fn(),
		};
		const client = {
			attach: async (_id, onEvent, onUiRequest) => {
				event = onEvent;
				uiRequest = onUiRequest;
				return connection;
			},
		};
		let view!: NativeAttachment;
		const detach = vi.fn(() => view.close());
		view = new NativeAttachment(
			tui,
			client as unknown as OrchestratorClient,
			worker,
			detach,
			getKeybindings() as KeybindingsManager,
		);
		return {
			view,
			event: (value: unknown) => event(value),
			uiRequest: (value: unknown) => uiRequest(value),
			commands,
			answers,
			connection,
			detach,
		};
	}
	it("renders native markdown on the active branch once, queues a reply, then detaches without abort", async () => {
		const { view, commands, detach, connection } = setup();
		await view.connect();
		const text = view
			.render(100)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		expect(text.match(/Native markdown/g)).toHaveLength(1);
		expect(text).not.toContain("**Native markdown**");
		expect(text).not.toContain("Abandoned branch");
		expect(text).not.toMatch(/\nassistant\n|\nuser\n|Blank composer/);
		view.handleInput("follow up");
		view.handleInput("\r");
		await vi.waitFor(() =>
			expect(commands).toContainEqual(
				expect.objectContaining({ type: "prompt", message: "follow up", streamingBehavior: "followUp" }),
			),
		);
		await vi.waitFor(() => expect(view.render(100).join("\n")).not.toContain("follow up"));
		view.handleInput("\x1b[D");
		expect(detach).toHaveBeenCalledOnce();
		expect(connection.close).toHaveBeenCalledOnce();
		expect(commands.some((command) => command.type === "abort")).toBe(false);
	});
	it("leaves a pending question alive on detach and answers it after reattachment", async () => {
		const first = setup();
		await first.view.connect();
		first.uiRequest({
			type: "extension_ui_request",
			id: "q",
			method: "select",
			title: "Allow bash?",
			options: ["Yes", "No"],
		});
		first.view.handleInput("\x1a");
		expect(first.answers).toEqual([]);
		const second = setup();
		await second.view.connect();
		second.uiRequest({
			type: "extension_ui_request",
			id: "q",
			method: "select",
			title: "Allow bash?",
			options: ["Yes", "No"],
		});
		expect(second.view.render(100).join("\n")).toContain("Allow bash?");
		second.view.handleInput("\r");
		expect(second.answers).toEqual([{ type: "extension_ui_response", id: "q", value: "Yes" }]);
		second.view.close();
	});
	it("does not let left-arrow editing detach a nonempty draft", async () => {
		const { view, detach } = setup();
		await view.connect();
		view.handleInput("unsent draft");
		view.handleInput("\x1b[D");
		expect(detach).not.toHaveBeenCalled();
		view.close();
	});
	it("clears a stale dialog and reports a worker failure without interrupting another session", async () => {
		const { view, uiRequest, answers, commands } = setup();
		await view.connect();
		uiRequest({
			type: "extension_ui_request",
			id: "q",
			method: "select",
			title: "Pending question",
			options: ["Yes"],
		});
		view.update([{ ...worker, status: "stopped", outcome: "failed", detail: "Worker exited unexpectedly" }]);
		const text = view.render(100).join("\n");
		expect(text).toContain("Worker exited unexpectedly");
		expect(text).not.toContain("Pending question");
		expect(answers).toEqual([]);
		expect(commands.some((command) => command.type === "abort")).toBe(false);
		view.close();
	});
});

describe("persistent daemon attachment transport", () => {
	it("handles a split UTF-8 event, matching RPC responses and detach without any stop request", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bluclawd-attach-"));
		const path = join(dir, "server.sock");
		const requests: Array<Record<string, unknown>> = [];
		const sockets = new Set<Socket>();
		const server = createServer((socket) => {
			sockets.add(socket);
			socket.setEncoding("utf8");
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk;
				while (buffer.includes("\n")) {
					const index = buffer.indexOf("\n");
					const request = JSON.parse(buffer.slice(0, index));
					buffer = buffer.slice(index + 1);
					requests.push(request);
					if (request.type === "rpc_stream") {
						const event = Buffer.from(`${JSON.stringify({ type: "test_event", text: "日本語" })}\n`);
						const offset = event.indexOf(Buffer.from("日")) + 1;
						socket.write(`${JSON.stringify({ type: "rpc_ready", ok: true })}\n`);
						socket.write(event.subarray(0, offset));
						setTimeout(() => socket.write(event.subarray(offset)), 5);
					} else
						setTimeout(
							() =>
								socket.write(
									`${JSON.stringify({ type: "response", id: request.id, command: request.type, success: true })}\n`,
								),
							10,
						);
				}
			});
		});
		try {
			await new Promise<void>((resolve) => server.listen(path, resolve));
			const events: unknown[] = [];
			const disconnect = vi.fn();
			const attachment = await attachRpc(
				path,
				"worker",
				(event) => events.push(event),
				() => {},
				disconnect,
			);
			await expect(attachment.request({ type: "get_state" })).resolves.toMatchObject({
				command: "get_state",
				success: true,
			});
			await vi.waitFor(() => expect(events).toContainEqual({ type: "test_event", text: "日本語" }));
			attachment.close();
			expect(disconnect).not.toHaveBeenCalled();
			expect(requests.map((request) => request.type)).toEqual(["rpc_stream", "get_state"]);
		} finally {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
