import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	initTheme,
	type KeybindingsManager,
	type RpcCommand,
	type RpcResponse,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	stripTerminalSequences,
	type Terminal,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewProjection } from "../daemon/view-projection.ts";
import type { ViewReady } from "../daemon/view-types.ts";
import type { InstanceSummary, OrchestratorClient } from "../ext/agent-view/orchestrator-client.ts";
import { SessionController } from "../ext/agent-view/session-controller.ts";
import { SessionShell } from "../ext/agent-view/session-shell.ts";
import type { SessionViewClient } from "../ext/agent-view/view-client.ts";

let dir: string;
const clean: Array<() => void> = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "view-shell-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	initTheme("dark");
});
afterEach(() => {
	for (const dispose of clean.splice(0)) dispose();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});
async function fixture(mode: "fullscreen" | "inline" = "fullscreen") {
	const theme = {
		fg: (_c: string, s: string) => s,
		bg: (_c: string, s: string) => s,
		bold: (s: string) => s,
		getBgAnsi: () => "",
		getColorMode: () => "truecolor",
	} as unknown as Theme;
	const rows: InstanceSummary[] = [{ id: "a", cwd: dir, status: "online", sessionFile: join(dir, "a.jsonl") }];
	const prompts: RpcCommand[] = [];
	const closes = vi.fn();
	const client = {
		list: vi.fn(async () => rows),
		history: vi.fn(async () => ({ messages: [] })),
		ensureDaemon: vi.fn(async () => true),
		getDaemonInfo: vi.fn(async () => ({ running: true, viewProtocol: 1 })),
		spawn: vi.fn(async (options) => {
			const instance = { id: "new", cwd: options.cwd, status: "online", sessionFile: join(dir, "new.jsonl") };
			rows.push(instance as InstanceSummary);
			return instance as InstanceSummary;
		}),
		delete: vi.fn(async (id: string) => {
			rows.splice(
				rows.findIndex((row) => row.id === id),
				1,
			);
		}),
		stop: vi.fn(async () => {}),
		reply: vi.fn(async () => {}),
		answer: vi.fn(async () => {}),
		restartDaemon: vi.fn(async () => ({ restarted: false, reason: "live sessions" })),
	};
	let shell: SessionShell | undefined;
	const views = {
		open: vi.fn(async (id: string) => {
			const ready: ViewReady = {
				type: "view_ready",
				ok: true,
				viewProtocol: 1,
				instance: rows.find((row) => row.id === id)!,
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
				close: closes,
				answer: async () => true,
				send: async (command: RpcCommand): Promise<RpcResponse> => {
					prompts.push(command);
					if (command.type === "get_commands")
						return { type: "response", command: "get_commands", success: true, data: { commands: [] } };
					return { type: "response", command: command.type, success: true } as RpcResponse;
				},
			};
		}),
	};
	const controller = new SessionController({
		client,
		views: views as Pick<SessionViewClient, "open">,
		cwd: dir,
		onChange: () => shell?.refresh(),
	});
	await controller.select({ instanceId: "a" });
	const terminal = { rows: 30, columns: 100, setTitle: () => {}, hideCursor: () => {} };
	const Renderer = mode === "fullscreen" ? TuiAltScreen : TuiMainScreen;
	const tui = new Renderer(terminal as unknown as Terminal);
	vi.spyOn(tui, "requestRender").mockImplementation(() => {});
	shell = new SessionShell({
		tui,
		theme,
		keybindings: { matches: () => false } as unknown as KeybindingsManager,
		controller,
		client: client as unknown as OrchestratorClient,
		cwd: dir,
		home: dir,
		version: "test",
		onLocalAction: () => {},
		readClipboard: async () => ({ image: { type: "image", mimeType: "image/png", data: "AA==" } }),
	});
	shell.focused = true;
	clean.push(() => {
		shell?.dispose();
		controller.dispose();
	});
	return { shell, controller, client, views, prompts, closes, tui, terminal };
}
/** Exercise Pi's actual overlay composition, including the idle host's focused editor. */
function visibleScreen(tui: TUI, rows: number, width: number): string[] {
	const host = Array.from({ length: rows + 10 }, () => "native host content");
	host[host.length - 2] = `native editor${CURSOR_MARKER}`;
	host[host.length - 1] = "native host status";
	return (
		tui as unknown as {
			compositeOverlays(lines: string[], width: number, height: number): string[];
		}
	)
		.compositeOverlays(host, width, rows)
		.slice(-rows);
}
describe("managed session shell", () => {
	it.each(["fullscreen", "inline"] as const)(
		"%s blank conversation covers the host screen with one bottom editor",
		async (mode) => {
			const f = await fixture(mode);
			f.controller.blank();
			f.tui.showOverlay(f.shell, { width: "100%", maxHeight: "100%" });
			const screen = visibleScreen(f.tui, f.terminal.rows, f.terminal.columns);
			expect(stripTerminalSequences(screen.join("\n"))).not.toContain("native");
			expect(stripTerminalSequences(screen[0])).toContain("Blank composer");
			expect(screen.filter((line) => line.includes(CURSOR_MARKER))).toHaveLength(1);
			expect(screen.findIndex((line) => line.includes(CURSOR_MARKER))).toBeGreaterThanOrEqual(f.terminal.rows - 5);
			expect(stripTerminalSequences(screen.at(-1)!)).toContain("agents");
		},
	);
	it("short conversation and local dialogs keep covering the host after terminal resize", async () => {
		const f = await fixture();
		f.controller.setDraft({ text: "line one\nline two", images: [] });
		f.tui.showOverlay(f.shell, { width: "100%", maxHeight: "100%" });
		for (const rows of [50, 12, 30]) {
			f.terminal.rows = rows;
			f.terminal.columns = 40;
			const screen = visibleScreen(f.tui, rows, 40);
			expect(stripTerminalSequences(screen.join("\n"))).not.toContain("native");
			expect(screen.filter((line) => line.includes(CURSOR_MARKER))).toHaveLength(1);
			expect(screen.findIndex((line) => line.includes(CURSOR_MARKER))).toBeGreaterThanOrEqual(rows - 6);
		}
		const choice = f.shell.choose("Choose a theme", ["dark", "light"]);
		expect(stripTerminalSequences(visibleScreen(f.tui, 30, 40).join("\n"))).not.toContain("native");
		f.shell.handleInput("\x1b");
		await choice;
		expect(f.controller.draft().text).toBe("line one\nline two");
		expect(stripTerminalSequences(visibleScreen(f.tui, 30, 40).join("\n"))).not.toContain("native");
	});
	it("selected deletion shows a blank composer and only detaches", async () => {
		const f = await fixture();
		f.controller.setDraft({ text: "old", images: [] });
		f.shell.showAgents();
		await vi.waitFor(() => expect(f.client.list.mock.calls.length).toBeGreaterThan(1));
		f.shell.handleInput?.("\x18");
		await vi.waitFor(() => expect(f.client.stop).toHaveBeenCalledWith("a"));
		f.shell.handleInput?.("\x18");
		await vi.waitFor(() => expect(f.controller.selected()).toBeUndefined());
		expect(f.controller.draft()).toEqual({ text: "", images: [] });
		expect(f.shell.render(80).join("\n")).toContain("Blank composer");
		expect(f.prompts.some((command) => command.type === "abort")).toBe(false);
	});
	it("opening roster and returning does not detach or stop selection", async () => {
		const f = await fixture();
		f.shell.showAgents();
		f.shell.showConversation();
		expect(f.controller.selected()?.instance.id).toBe("a");
		expect(f.closes).not.toHaveBeenCalled();
		expect(f.client.stop).not.toHaveBeenCalled();
	});
	it("CtrlEnter attaches child with chosen model and images", async () => {
		const f = await fixture();
		f.shell.showAgents();
		for (const ch of "/model chosen/model") f.shell.handleInput?.(ch);
		f.shell.handleInput?.("\r");
		for (const ch of "describe image") f.shell.handleInput?.(ch);
		f.shell.handleInput?.("\x16");
		await Promise.resolve();
		await Promise.resolve();
		f.shell.handleInput?.("\x1b[13;5u");
		await vi.waitFor(() => expect(f.controller.selected()?.instance.id).toBe("new"));
		expect(f.client.spawn).toHaveBeenCalledWith(
			expect.objectContaining({ model: { provider: "chosen", id: "model" } }),
		);
		await vi.waitFor(() => expect(f.prompts.some((command) => command.type === "prompt")).toBe(true));
		expect(f.prompts.find((command) => command.type === "prompt")).toMatchObject({
			message: "describe image",
			images: [{ type: "image", mimeType: "image/png", data: "AA==" }],
		});
	});
});
