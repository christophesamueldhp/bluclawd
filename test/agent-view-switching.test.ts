import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setSharedTheme } from "../ext/_shared/theme.ts";
import type { AgentView } from "../ext/agent-view/agent-view.ts";
import { CONTINUE_PROMPT } from "../ext/agent-view/hand-off.ts";
import agentView from "../ext/agent-view/index.ts";

const state = vi.hoisted(() => ({
	spawned: [] as unknown[],
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
			return [];
		}
		async stop() {}
		async spawn(options: unknown) {
			state.spawned.push(options);
			return { id: "outgoing" };
		}
	},
}));

const theme = {
	fg: (_c: string, text: string) => text,
	bg: (_c: string, text: string) => text,
	bold: (text: string) => text,
	getBgAnsi: () => "",
	getColorMode: () => "truecolor",
} as unknown as Theme;
let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	state.spawned = [];
});

function setup(create: boolean, cancelled = false) {
	setSharedTheme(theme);
	dir = mkdtempSync(join(tmpdir(), "bluclawd-switch-"));
	const outgoing = join(dir, "outgoing.jsonl");
	const incoming = join(dir, "incoming.jsonl");
	writeFileSync(outgoing, "");
	writeFileSync(incoming, "");
	let handler!: (_args: string, ctx: ExtensionCommandContext) => Promise<void>;
	agentView({
		on: () => {},
		registerCommand: (name, command) => {
			if (name === "agent-view") handler = command.handler as typeof handler;
		},
	} as unknown as ExtensionAPI);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let replacing = false;
	const messages: unknown[] = [];
	const replace = async (_pathOrOptions: unknown, options?: { withSession?: (fresh: unknown) => Promise<void> }) => {
		replacing = true;
		await gate;
		if (!cancelled) {
			const callback = create ? (_pathOrOptions as typeof options)?.withSession : options?.withSession;
			await callback?.({
				sendUserMessage: async (message: unknown) => {
					messages.push(message);
				},
				ui: { notify: () => {} },
			});
		}
		return { cancelled };
	};
	const ctx = {
		cwd: dir,
		model: { provider: "test", id: "model" },
		isIdle: () => false,
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
			custom: (
				factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (value?: unknown) => void) => AgentView,
			) =>
				new Promise<unknown>((resolve) => {
					const view = factory(
						{ terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI,
						theme,
						{},
						resolve,
					);
					if (create) {
						view.handleInput("\x16");
						queueMicrotask(() => view.handleInput("\x1b[13;5u"));
					} else {
						view.setInstancesForTest([{ id: "incoming", status: "stopped", cwd: dir, sessionFile: incoming }]);
						for (let i = 0; i < 5 && view.selectedKeyForTest() !== "incoming"; i++) view.handleInput("\x1b[B");
						view.handleInput("\r");
					}
				}),
		},
	} as unknown as ExtensionCommandContext;
	return { run: () => handler("", ctx), release, replacing: () => replacing, messages, outgoing };
}

describe("Agent View session replacement", () => {
	it("awaits the switch before completing its command and resumes the outgoing working session", async () => {
		const flow = setup(false);
		let finished = false;
		const running = flow.run().then(() => {
			finished = true;
		});
		await vi.waitFor(() => expect(flow.replacing()).toBe(true));
		expect(finished).toBe(false);
		expect(state.spawned).toEqual([]);
		flow.release();
		await running;
		expect(state.spawned).toEqual([expect.objectContaining({ sessionFile: flow.outgoing, prompt: CONTINUE_PROMPT })]);
	});
	it("does not hand off the session if replacement is cancelled", async () => {
		const flow = setup(false, true);
		const running = flow.run();
		await vi.waitFor(() => expect(flow.replacing()).toBe(true));
		flow.release();
		await running;
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(state.spawned).toEqual([]);
	});
	it("delivers Ctrl+V images to the fresh foreground context", async () => {
		const flow = setup(true);
		const running = flow.run();
		await vi.waitFor(() => expect(flow.replacing()).toBe(true));
		flow.release();
		await running;
		expect(flow.messages).toEqual([[{ type: "image", mimeType: "image/png", data: "AQID" }]]);
		expect(state.spawned).toEqual([expect.objectContaining({ sessionFile: flow.outgoing, prompt: CONTINUE_PROMPT })]);
	});
});
