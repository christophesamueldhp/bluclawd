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
	rows: [] as Array<{
		id: string;
		status: string;
		cwd: string;
		sessionFile?: string;
		label?: string;
		activity?: string;
		external?: boolean;
	}>,
	protocol: 1,
	sent: [] as RpcCommand[],
	spawns: [] as unknown[],
	close: vi.fn(),
	restart: vi.fn(async (): Promise<{ restarted: boolean; reason?: string }> => ({ restarted: false })),
	stop: vi.fn(async (_id: string) => {}),
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
		stop = mock.stop;
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
	mock.restart.mockReset();
	mock.restart.mockResolvedValue({ restarted: false });
	mock.stop.mockReset();
	mock.stop.mockImplementation(async (id) => {
		const row = mock.rows.find((row) => row.id === id);
		if (row) row.status = "stopped";
	});
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
	const select = vi.fn(async (_title: string, options: string[]): Promise<string | undefined> => options[0]);
	const confirm = vi.fn(async () => false);
	const offGate = vi.fn();
	const ctx = {
		mode: "tui",
		cwd: dir,
		model: { provider: "test", id: "model" },
		shutdown: vi.fn(),
		reload: vi.fn(async () => {}),
		newSession: vi.fn(),
		ui: {
			notify,
			select,
			confirm,
			onTerminalInput: () => offGate,
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
	return { runtime, state, ctx, notify, select, confirm, offGate, sendUserMessage };
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
		expect(mock.stop).not.toHaveBeenCalled();
		expect(f.select).toHaveBeenCalledWith(expect.stringContaining("1 live session"), [
			"Keep sessions running",
			"Check again",
			"Stop daemon sessions and upgrade",
		]);
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("/agent-view to retry"), "info");
	});
	it("deferred upgrade retains startup input and releases the terminal gate", async () => {
		mock.protocol = 0;
		mock.rows = [{ id: "a", status: "online", cwd: dir }];
		const input = { text: "do this once", images: [] };
		const f = fixture({ phase: "managed", drafts: {}, pendingInput: [input] });
		f.runtime.sessionStart(f.ctx);
		f.select.mockImplementationOnce(async () => {
			expect(f.offGate).toHaveBeenCalledOnce();
			return undefined;
		});
		await f.runtime.bootstrap(f.ctx);
		expect(f.offGate).toHaveBeenCalledOnce();
		expect(f.state.pendingInput).toEqual([input]);
		expect(mock.sent).toEqual([]);
		mock.protocol = 1;
		await f.runtime.agents(f.ctx);
		expect(mock.sent.filter((command) => command.type === "prompt")).toEqual([
			expect.objectContaining({ message: input.text }),
		]);
		expect(f.state.pendingInput).toEqual([]);
	});
	it("checks again without stopping a live session", async () => {
		mock.protocol = 0;
		mock.rows = [{ id: "a", status: "online", cwd: dir }];
		const f = fixture();
		f.select.mockImplementationOnce(async () => {
			mock.protocol = 1;
			return "Check again";
		});
		await f.runtime.bootstrap(f.ctx);
		expect(mock.stop).not.toHaveBeenCalled();
		expect(mock.restart).not.toHaveBeenCalled();
		expect(f.ctx.ui.custom).toHaveBeenCalledOnce();
	});
	it("requires confirmation before stopping sessions for an upgrade", async () => {
		mock.protocol = 0;
		mock.rows = [{ id: "a", status: "online", cwd: dir }];
		const f = fixture();
		f.select.mockResolvedValueOnce("Stop daemon sessions and upgrade");
		await f.runtime.bootstrap(f.ctx);
		expect(f.confirm).toHaveBeenCalledOnce();
		expect(mock.stop).not.toHaveBeenCalled();
		expect(mock.restart).not.toHaveBeenCalled();
	});
	it("confirmed upgrade stops owned sessions, preserves drafts, and restarts", async () => {
		mock.protocol = 0;
		mock.rows = [
			{ id: "a", status: "online", activity: "working", label: "build", cwd: dir },
			{ id: "b", status: "starting", cwd: dir },
			{ id: "c", status: "stopping", cwd: dir },
			{ id: "saved", status: "stopped", cwd: dir },
			{ id: "window", status: "online", external: true, cwd: dir },
		];
		mock.restart.mockImplementationOnce(async () => {
			expect(mock.rows.filter((row) => !row.external && row.status !== "stopped")).toEqual([]);
			mock.protocol = 1;
			return { restarted: true };
		});
		const f = fixture({ phase: "managed", drafts: { a: { text: "unsent", images: [] } }, pendingInput: [] });
		f.select.mockResolvedValueOnce("Stop daemon sessions and upgrade");
		f.confirm.mockResolvedValueOnce(true);
		await f.runtime.bootstrap(f.ctx);
		expect(mock.stop.mock.calls).toEqual([["a"], ["b"], ["c"]]);
		expect(f.confirm).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("build · working"));
		expect(mock.restart).toHaveBeenCalledOnce();
		expect(f.state.drafts.a.text).toBe("unsent");
		expect(f.ctx.ui.custom).toHaveBeenCalledOnce();
		expect(mock.spawns).toEqual([]);
	});
	it("external windows do not block a daemon with no owned sessions from upgrading", async () => {
		mock.protocol = 0;
		mock.rows = [{ id: "window", status: "online", external: true, cwd: dir }];
		mock.restart.mockImplementationOnce(async () => {
			mock.protocol = 1;
			return { restarted: true };
		});
		const f = fixture();
		await f.runtime.bootstrap(f.ctx);
		expect(f.select).not.toHaveBeenCalled();
		expect(mock.stop).not.toHaveBeenCalled();
		expect(mock.restart).toHaveBeenCalledOnce();
		expect(f.ctx.ui.custom).toHaveBeenCalledOnce();
	});
	it("rechecks new sessions before restarting rather than stopping them without confirmation", async () => {
		mock.protocol = 0;
		mock.rows = [{ id: "a", status: "online", cwd: dir }];
		mock.stop.mockImplementationOnce(async () => {
			mock.rows = [{ id: "new-owner", status: "online", cwd: dir }];
		});
		const f = fixture();
		f.select.mockResolvedValueOnce("Stop daemon sessions and upgrade");
		f.confirm.mockResolvedValueOnce(true);
		await f.runtime.bootstrap(f.ctx);
		expect(f.select).toHaveBeenCalledTimes(2);
		expect(mock.stop.mock.calls).toEqual([["a"]]);
		expect(mock.restart).not.toHaveBeenCalled();
	});
	it("a failed stop retains input and prevents restart", async () => {
		mock.protocol = 0;
		mock.rows = [{ id: "a", status: "online", cwd: dir }];
		mock.stop.mockRejectedValueOnce(new Error("stop refused"));
		const input = { text: "pending", images: [] };
		const f = fixture({ phase: "managed", drafts: {}, pendingInput: [input] });
		f.select.mockResolvedValueOnce("Stop daemon sessions and upgrade");
		f.confirm.mockResolvedValueOnce(true);
		await f.runtime.bootstrap(f.ctx);
		expect(mock.restart).not.toHaveBeenCalled();
		expect(f.state.pendingInput).toEqual([input]);
		expect(f.notify).toHaveBeenCalledWith("stop refused", "error");
	});
	it("reports the daemon restart refusal and retains input", async () => {
		mock.protocol = 0;
		mock.restart.mockResolvedValueOnce({ restarted: false, reason: "2 running sessions" });
		const input = { text: "pending", images: [] };
		const f = fixture({ phase: "managed", drafts: {}, pendingInput: [input] });
		await f.runtime.bootstrap(f.ctx);
		expect(f.state.pendingInput).toEqual([input]);
		expect(f.ctx.ui.custom).not.toHaveBeenCalled();
		expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("2 running sessions"), "error");
	});
	it("compatible daemon attach does not restart any process", async () => {
		const f = fixture();
		await f.runtime.bootstrap(f.ctx);
		expect(mock.restart).not.toHaveBeenCalled();
	});
});
