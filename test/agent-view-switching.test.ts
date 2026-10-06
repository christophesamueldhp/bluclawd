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
import { CONTINUE_COMMAND, CONTINUE_PROMPT } from "../ext/agent-view/hand-off.ts";
import agentView from "../ext/agent-view/index.ts";

const state = vi.hoisted(() => ({
	spawned: [] as unknown[],
	rows: [] as Array<Record<string, unknown>>,
	handedOver: [] as string[],
	deleted: [] as string[],
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
		async delete(id: string) {
			state.deleted.push(id);
		}
		async handOver(id: string) {
			state.handedOver.push(id);
			return true;
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
	state.handedOver = [];
	state.deleted = [];
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
	const events: Record<string, (event: unknown) => void> = {};
	agentView({
		on: (name: string, fn: (event: unknown) => void) => {
			events[name] = fn;
		},
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
	const replaced = {
		sendMessage: vi.fn(async () => {}),
		sendUserMessage: vi.fn(async () => {}),
		ui: { notify: () => {} },
	};
	const replace = vi.fn(async (_target?: unknown, options?: { withSession?: (ctx: unknown) => Promise<void> }) => {
		await options?.withSession?.(replaced);
		return { cancelled: false };
	});
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
		newSession: (options: unknown) => replace(undefined, options as Parameters<typeof replace>[1]),
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
		events,
		replaced,
		outgoing,
		incoming,
		view: () => view,
		finishTurn,
		waitForIdle,
		abort,
		replace,
	};
}
describe("Agent View native foreground and live background", () => {
	it("swaps a working target in as this window's own pi session; both turns carry on", async () => {
		const flow = setup();
		flow.events.agent_start({ type: "agent_start" });
		const running = flow.run();
		await vi.waitFor(() => expect(flow.view()?.selectedKeyForTest()).toBe("self:self"));
		await vi.waitFor(() => expect(flow.view().render(100).join("\n")).toContain("incoming"));
		flow.view().handleInput("\x1b2");
		await vi.waitFor(() => expect(state.handedOver).toEqual(["incoming"]));
		// This window's turn first lets its running tool finish.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(flow.replace).not.toHaveBeenCalled();
		flow.events.turn_end({ type: "turn_end", toolResults: [{}] });
		await running;
		expect(flow.abort).not.toHaveBeenCalled();
		expect(flow.replace).toHaveBeenCalledWith(flow.incoming, expect.anything());
		expect(state.spawned).toEqual([expect.objectContaining({ sessionFile: flow.outgoing, prompt: CONTINUE_PROMPT })]);
		expect(flow.replaced.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: CONTINUE_COMMAND, display: false }),
			{ triggerTurn: true },
		);
	});
	it("ctrl+x twice on this window's own session deletes it and moves to a new one, still in agent view", async () => {
		const flow = setup();
		state.rows.push({ id: "twin", status: "stopped", cwd: flow.outgoing, sessionFile: flow.outgoing });
		const running = flow.run();
		await vi.waitFor(() => expect(flow.view()?.selectedKeyForTest()).toBe("self:self"));
		flow.view().handleInput("\x18");
		flow.view().handleInput("\x18");
		flow.finishTurn();
		await running;
		// The first press stops it, as Claude Code's does; the delete stops it again, harmlessly.
		expect(flow.abort).toHaveBeenCalled();
		expect(flow.replace).toHaveBeenCalledWith(undefined, expect.anything());
		expect(state.deleted).toEqual(["twin"]);
		expect(state.spawned).toEqual([]);
		expect(flow.replaced.sendUserMessage).toHaveBeenCalledWith("/agent-view", { expandPromptTemplates: true });
	});
	it("ctrl+enter starts an image-only conversation here, as a new pi session", async () => {
		const flow = setup();
		const running = flow.run();
		flow.view().handleInput("\x16");
		await new Promise((resolve) => setTimeout(resolve, 0));
		flow.view().handleInput("\x1b[13;5u");
		await running;
		expect(flow.replace).toHaveBeenCalledOnce();
		expect(flow.replaced.sendUserMessage).toHaveBeenCalledWith([state.image]);
		expect(flow.abort).not.toHaveBeenCalled();
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
