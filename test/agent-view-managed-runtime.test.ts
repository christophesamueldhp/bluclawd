import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	initTheme,
	type RpcCommand,
	type RpcResponse,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewProjection } from "../daemon/view-projection.ts";
import type { ViewReady } from "../daemon/view-types.ts";
import { createManagedRuntime } from "../ext/agent-view/managed-runtime.ts";
import type { ManagedUiState } from "../ext/agent-view/managed-state.ts";

const mock = vi.hoisted(() => ({
	rows: [] as Array<{ id: string; status: string; cwd: string; sessionFile?: string }>,
	protocol: 1,
	sent: [] as RpcCommand[],
	spawns: [] as unknown[],
	close: vi.fn(),
	restart: vi.fn(async () => ({ restarted: false })),
	opens: [] as string[],
}));
vi.mock("../ext/agent-view/orchestrator-client.ts", async (original) => ({
	...(await original<object>()),
	OrchestratorClient: class {
		async ensureDaemon() {
			return true;
		}
		async getDaemonInfo() {
			return { running: true, viewProtocol: mock.protocol };
		}
		async list() {
			return mock.rows;
		}
		async spawn(options: { cwd: string }) {
			mock.spawns.push(options);
			const row = { id: "new", status: "online", cwd: options.cwd };
			mock.rows.push(row);
			return row;
		}
		async history() {
			return { messages: [] };
		}
		restartDaemon = mock.restart;
	},
}));
vi.mock("../ext/agent-view/view-client.ts", () => ({
	SessionViewClient: class {
		async open(id: string) {
			mock.opens.push(id);
			const ready: ViewReady = {
				type: "view_ready",
				ok: true,
				viewProtocol: 1,
				instance: mock.rows.find((row) => row.id === id)! as never,
				generation: `g-${id}`,
				sequence: 0,
				projection: createViewProjection(),
				state: {
					sessionId: id,
					thinkingLevel: "off",
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "all",
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0,
				},
			};
			return {
				ready,
				close: mock.close,
				answer: async () => true,
				send: async (command: RpcCommand): Promise<RpcResponse> => {
					mock.sent.push(command);
					if (command.type === "get_commands")
						return { type: "response", command: "get_commands", success: true, data: { commands: [] } };
					return { type: "response", command: command.type, success: true } as RpcResponse;
				},
			};
		}
	},
}));
let dir: string;
const dispose: Array<() => void> = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "managed-runtime-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	initTheme("dark");
	mock.rows = [];
	mock.protocol = 1;
	mock.sent = [];
	mock.spawns = [];
	mock.opens = [];
	mock.close.mockClear();
	mock.restart.mockClear();
});
afterEach(() => {
	for (const fn of dispose.splice(0)) fn();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});
function fixture(state: ManagedUiState = { phase: "managed", drafts: {}, pendingInput: [] }) {
	const theme = {
		fg: (_c: string, s: string) => s,
		bg: (_c: string, s: string) => s,
		bold: (s: string) => s,
		getBgAnsi: () => "",
		getColorMode: () => "truecolor",
	} as unknown as Theme;
	const notify = vi.fn();
	const ctx = {
		mode: "tui",
		cwd: dir,
		model: { provider: "test", id: "model" },
		shutdown: vi.fn(),
		reload: vi.fn(async () => {}),
		newSession: vi.fn(),
		ui: {
			notify,
			onTerminalInput: () => () => {},
			getEditorText: () => "",
			setEditorText: () => {},
			custom: vi.fn(
				(factory) =>
					new Promise<void>((resolve) => {
						factory(
							{
								terminal: { rows: 24, columns: 80, setTitle: () => {} },
								requestRender: () => {},
							} as unknown as TUI,
							theme,
							{ matches: () => false },
							resolve,
						);
					}),
			),
			getAllThemes: () => [{ name: "dark" }],
		},
	} as unknown as ExtensionCommandContext;
	const sendUserMessage = vi.fn();
	const runtime = createManagedRuntime({ sendUserMessage } as unknown as ExtensionAPI, state, async () => []);
	dispose.push(runtime.dispose);
	return { runtime, state, ctx, notify, sendUserMessage };
}
describe("managed UI runtime lifecycle", () => {
	it("startup slash commands disclose unavailable screens instead of becoming prompts", async () => {
		const f = fixture({ phase: "managed", drafts: {}, pendingInput: [{ text: "/tasks", images: [] }] });
		await f.runtime.bootstrap(f.ctx);
		expect(mock.sent.some((command) => command.type === "prompt")).toBe(false);
		expect(mock.spawns).toHaveLength(0);
	});
	it("bootstrap dispatch enables extension-command handling, never a model prompt", async () => {
		vi.useFakeTimers();
		try {
			const f = fixture({ phase: "native", drafts: {}, pendingInput: [] });
			f.runtime.sessionStart(f.ctx);
			await vi.advanceTimersByTimeAsync(0);
			expect(f.sendUserMessage).toHaveBeenCalledWith("/agent-view-bootstrap", { expandPromptTemplates: true });
		} finally {
			vi.useRealTimers();
		}
	});
	it("input after an initially empty startup queue is delivered once", async () => {
		const f = fixture();
		await f.runtime.bootstrap(f.ctx);
		f.runtime.input({ type: "input", source: "interactive", text: "later input" }, f.ctx);
		await vi.waitFor(() => expect(mock.sent.filter((command) => command.type === "prompt")).toHaveLength(1));
	});
	it("first input before ready goes to child once including CLI startup images", async () => {
		const f = fixture({ phase: "managed", drafts: {}, pendingInput: [] });
		const image = { type: "image" as const, mimeType: "image/png", data: "AA==" };
		expect(
			f.runtime.input({ type: "input", source: "interactive", text: "initial CLI prompt", images: [image] }, f.ctx),
		).toEqual({ action: "handled" });
		await f.runtime.bootstrap(f.ctx);
		expect(mock.sent.filter((command) => command.type === "prompt")).toEqual([
			expect.objectContaining({ message: "initial CLI prompt", images: [image] }),
		]);
		expect(f.state.pendingInput).toEqual([]);
	});
	it("reload reconnects without continuation", async () => {
		mock.rows = [{ id: "a", status: "online", cwd: dir }];
		const state: ManagedUiState = {
			phase: "managed",
			selectedId: "a",
			drafts: { a: { text: "unsent", images: [] } },
			pendingInput: [],
		};
		const first = fixture(state);
		await first.runtime.bootstrap(first.ctx);
		first.runtime.shutdown();
		const next = fixture(state);
		await next.runtime.bootstrap(next.ctx);
		expect(mock.opens).toEqual(["a", "a"]);
		expect(mock.spawns).toEqual([]);
		expect(mock.sent.filter((command) => command.type === "prompt")).toEqual([]);
		expect(state.drafts.a.text).toBe("unsent");
	});
	it("quit only detaches and blank host produces no self row or handoff", async () => {
		const f = fixture();
		await f.runtime.bootstrap(f.ctx);
		expect(f.runtime.shutdown()).toBe(true);
		expect(mock.spawns).toEqual([]);
		expect(mock.sent.some((command) => command.type === "abort")).toBe(false);
		expect(f.sendUserMessage).not.toHaveBeenCalled();
	});
	it("stale daemon with live sessions is not restarted", async () => {
		mock.protocol = 0;
		mock.rows = [{ id: "a", status: "online", cwd: dir }];
		const f = fixture();
		await f.runtime.bootstrap(f.ctx);
		expect(mock.restart).not.toHaveBeenCalled();
		expect(mock.opens).toEqual([]);
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("live sessions were not restarted"), "error");
	});
	it("compatible daemon attach does not restart any process", async () => {
		const f = fixture();
		await f.runtime.bootstrap(f.ctx);
		expect(mock.restart).not.toHaveBeenCalled();
	});
});
