import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	initTheme,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setSharedTheme } from "../ext/_shared/theme.ts";
import type { AgentView } from "../ext/agent-view/agent-view.ts";
import agentView from "../ext/agent-view/index.ts";

const state = vi.hoisted(() => ({
	spawned: [] as unknown[],
	rows: [] as Array<Record<string, unknown>>,
	attached: [] as string[],
	requests: [] as unknown[],
	image: { type: "image" as const, mimeType: "image/png", data: "AQID" },
}));
vi.mock("../ext/agent-view/clipboard.ts", () => ({ readAgentClipboard: async () => ({ image: state.image }) }));
vi.mock("../ext/agent-view/orchestrator-client.ts", async (original) => ({
	...(await original<object>()),
	OrchestratorClient: class {
		async ensureDaemon() {
			return true;
		}
		async getDaemonInfo() {
			return { running: false };
		}
		async list() {
			return state.rows;
		}
		async attach(id: string) {
			state.attached.push(id);
			return {
				close: () => {},
				answer: () => {},
				request: async (request: { type: string }) => {
					state.requests.push(request);
					if (request.type === "get_entries")
						return { success: true, command: "get_entries", data: { entries: [], leafId: null } };
					if (request.type === "get_state")
						return { success: true, command: "get_state", data: { isStreaming: true } };
					return { success: true, command: request.type };
				},
			};
		}
		async spawn(options: Record<string, unknown>) {
			state.spawned.push(options);
			const row = {
				id: "new",
				status: "online",
				activity: "working",
				cwd: options.cwd,
				sessionFile: options.sessionFile ?? "/new.jsonl",
			};
			state.rows.push(row);
			return row;
		}
	},
}));
const theme = {
	fg: (_: string, text: string) => text,
	bg: (_: string, text: string) => text,
	bold: (text: string) => text,
	getBgAnsi: () => "",
	getColorMode: () => "truecolor",
} as unknown as Theme;
let dir: string | undefined;
beforeAll(() => initTheme("dark", false));
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	state.spawned = [];
	state.attached = [];
	state.requests = [];
	state.rows = [];
});
function setup() {
	setSharedTheme(theme);
	dir = mkdtempSync(join(tmpdir(), "bluclawd-switch-"));
	const outgoing = join(dir, "outgoing.jsonl");
	const incoming = join(dir, "incoming.jsonl");
	writeFileSync(outgoing, "");
	writeFileSync(incoming, "");
	state.rows = [
		{ id: "incoming", label: "incoming", status: "online", activity: "working", cwd: dir, sessionFile: incoming },
	];
	let handler!: (_args: string, ctx: ExtensionCommandContext) => Promise<void>;
	let releaseHandler!: typeof handler;
	agentView({
		on: () => {},
		registerCommand: (name, command) => {
			if (name === "agent-view") handler = command.handler as typeof handler;
			if (name === "agent-view-release") releaseHandler = command.handler as typeof handler;
		},
	} as unknown as ExtensionAPI);
	let view!: AgentView;
	let finishTurn!: () => void;
	const turn = new Promise<void>((resolve) => {
		finishTurn = resolve;
	});
	const waitForIdle = vi.fn(() => turn);
	const abort = vi.fn();
	const replace = vi.fn(async () => ({ cancelled: false }));
	const ctx = {
		cwd: dir,
		model: { provider: "test", id: "model" },
		isIdle: () => false,
		waitForIdle,
		abort,
		sessionManager: {
			getSessionFile: () => outgoing,
			getCwd: () => dir,
			getSessionName: () => "working task",
			getEntries: () => [],
			getSessionId: () => "self",
			getHeader: () => undefined,
		},
		switchSession: replace,
		newSession: replace,
		ui: {
			notify: () => {},
			setTitle: () => {},
			custom: (factory) =>
				new Promise((resolve) => {
					view = factory(
						{ terminal: { rows: 40, columns: 100 }, requestRender: () => {} } as TUI,
						theme,
						getKeybindings(),
						resolve,
					);
				}),
		},
	} as unknown as ExtensionCommandContext;
	return {
		run: () => handler("", ctx),
		runRelease: () => releaseHandler("", ctx),
		view: () => view,
		finishTurn,
		waitForIdle,
		abort,
		replace,
	};
}
describe("Agent View native foreground and live background", () => {
	it("attaches a working target immediately while the native foreground turn keeps running", async () => {
		const flow = setup();
		const running = flow.run();
		await vi.waitFor(() => expect(flow.view()?.selectedKeyForTest()).toBe("self:self"));
		await vi.waitFor(() => expect(flow.view().render(100).join("\n")).toContain("incoming"));
		flow.view().handleInput("\x1b2");
		await vi.waitFor(() => expect(state.attached).toEqual(["incoming"]));
		expect(flow.waitForIdle).not.toHaveBeenCalled();
		expect(flow.abort).not.toHaveBeenCalled();
		expect(flow.replace).not.toHaveBeenCalled();
		expect(state.spawned).toEqual([]);
		flow.view().handleInput("\x1b[D");
		flow.view().close();
		await running;
		expect(state.requests.some((request: { type: string }) => request.type === "abort")).toBe(false);
	});
	it("creates and attaches an image-only background conversation instead of replacing the native runtime", async () => {
		const flow = setup();
		const running = flow.run();
		flow.view().handleInput("\x16");
		await new Promise((resolve) => setTimeout(resolve, 0));
		flow.view().handleInput("\x1b[13;5u");
		await vi.waitFor(() => expect(state.attached).toEqual(["new"]));
		expect(state.spawned).toEqual([expect.objectContaining({ images: [state.image], prompt: "" })]);
		expect(flow.replace).not.toHaveBeenCalled();
		expect(flow.abort).not.toHaveBeenCalled();
		expect(flow.waitForIdle).not.toHaveBeenCalled();
		flow.view().close();
		await running;
	});
	it("another terminal's ownership transfer still waits rather than aborting the native turn", async () => {
		const flow = setup();
		const running = flow.runRelease();
		await vi.waitFor(() => expect(flow.waitForIdle).toHaveBeenCalledOnce());
		expect(flow.abort).not.toHaveBeenCalled();
		expect(flow.replace).not.toHaveBeenCalled();
		flow.finishTurn();
		await running;
		expect(flow.replace).toHaveBeenCalledOnce();
		expect(state.spawned).toEqual([]);
	});
});
