import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import { initTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewProjection } from "../daemon/view-projection.ts";
import type { HistoryPage, ManagedDraft, ViewReady } from "../daemon/view-types.ts";
import type { AgentClipboard } from "../ext/agent-view/clipboard.ts";
import { ConversationView } from "../ext/agent-view/conversation-view.ts";
import type { SessionController } from "../ext/agent-view/session-controller.ts";
import { assistant } from "./support/view-fixtures.ts";

let dir: string;
const mounted: ConversationView[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "conversation-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	initTheme("dark");
});
afterEach(() => {
	for (const view of mounted.splice(0)) view.dispose();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});
function fixture(readClipboard?: () => Promise<AgentClipboard>) {
	let color = "\x1b[31m";
	const theme = {
		fg: (_color: string, text: string) => `${color + text}\x1b[0m`,
		bold: (text: string) => text,
	} as Theme;
	const tui = { terminal: { rows: 30, columns: 80, setTitle: vi.fn() }, requestRender: vi.fn() } as unknown as TUI;
	const keys: Record<string, string> = {
		"app.interrupt": "escape",
		"app.tools.expand": "ctrl+o",
		"app.thinking.toggle": "ctrl+t",
		"app.clipboard.pasteImage": "ctrl+v",
		"app.model.select": "ctrl+l",
		"app.thinking.cycle": "shift+tab",
		"app.message.followUp": "alt+enter",
	};
	const keybindings = {
		matches: (data: string, action: string) =>
			keys[action] ? matchesKey(data, keys[action] as Parameters<typeof matchesKey>[1]) : false,
	} as KeybindingsManager;
	let ready: ViewReady = {
		type: "view_ready",
		ok: true,
		viewProtocol: 1,
		instance: { id: "a", cwd: dir, status: "online" },
		generation: "g-a",
		sequence: 0,
		projection: createViewProjection(),
		state: {
			sessionId: "a",
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
	const drafts = new Map<string, ManagedDraft>();
	let view: ConversationView | undefined;
	const controller = {
		selected: () => ready,
		projection: () => ready.projection,
		draft: () => structuredClone(drafts.get(ready.instance.id) ?? { text: "", images: [] }),
		setDraft: vi.fn((draft: ManagedDraft) => {
			drafts.set(ready.instance.id, structuredClone(draft));
			view?.refresh();
		}),
		connectionState: () => "connected",
		notice: () => undefined,
		submit: vi.fn(async () => "accepted" as const),
		answer: vi.fn(async () => true),
		history: vi.fn(async (): Promise<HistoryPage> => ({ messages: [] })),
		send: vi.fn(async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type === "get_commands")
				return { type: "response", command: "get_commands", success: true, data: { commands: [] } };
			if (command.type === "clear_queue")
				return {
					type: "response",
					command: "clear_queue",
					success: true,
					data: { steering: [], followUp: ["queued"] },
				};
			return { type: "response", command: command.type, success: true } as RpcResponse;
		}),
		reconnect: vi.fn(async () => true),
	};
	const onAgents = vi.fn();
	const onLocalAction = vi.fn();
	view = new ConversationView({
		tui,
		theme,
		keybindings,
		controller: controller as unknown as SessionController,
		onAgents,
		onLocalAction,
		readClipboard,
	});
	mounted.push(view);
	return {
		view,
		controller,
		onAgents,
		onLocalAction,
		tui,
		ready: () => ready,
		choose: (id: string, projection = createViewProjection()) => {
			ready = { ...ready, instance: { ...ready.instance, id }, generation: `g-${id}`, projection };
			view!.refresh();
		},
		changeTheme: () => {
			color = "\x1b[32m";
		},
		text: () => stripTerminalSequences(view!.render(70).join("\n")),
	};
}
describe("daemon-owned conversation screen", () => {
	it("stock submit reset cannot erase uncertain text or images", async () => {
		const f = fixture();
		const images: ManagedDraft["images"] = [{ type: "image", data: "AA==", mimeType: "image/png" }];
		f.controller.setDraft({ text: "keep this", images });
		f.controller.submit.mockResolvedValueOnce("uncertain" as never);
		f.view.handleInput?.("\r");
		await vi.waitFor(() => expect(f.controller.submit).toHaveBeenCalled());
		expect(f.controller.draft()).toEqual({ text: "keep this", images });
	});
	it("hidden messages and unknown roles do not corrupt the screen", () => {
		const f = fixture();
		f.ready().projection.messages = [
			{ key: "hidden-system", message: { role: "system", content: "hidden system", timestamp: 1 } as never },
			{
				key: "hidden-custom",
				message: { role: "custom", display: false, content: "hidden custom", timestamp: 1 } as never,
			},
			{ key: "future", message: { role: "future", content: "future text", timestamp: 1 } as never },
		];
		f.view.refresh();
		expect(f.text()).not.toContain("hidden system");
		expect(f.text()).not.toContain("hidden custom");
		expect(f.text()).toContain("future text");
	});
	it("scrolled up view does not jump to new streaming output", () => {
		const f = fixture();
		const text = Array.from({ length: 100 }, (_, i) => `paragraph_${i}`).join("\n\n");
		f.ready().projection.partial = assistant(text);
		f.view.refresh();
		f.view.render(70);
		f.view.handleInput?.("\x1b[5~");
		const before = f.text();
		f.ready().projection.partial = assistant(`${text}\n\nnew paragraph`);
		f.view.refresh();
		expect(f.text()).toBe(before);
	});
	it("clipboard result does not overwrite a newer draft edit", async () => {
		let resolve!: (clip: AgentClipboard) => void;
		const f = fixture(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		f.view.handleInput?.("\x16");
		f.controller.setDraft({ text: "newer edit", images: [] });
		resolve({ text: "old clipboard" });
		await Promise.resolve();
		await Promise.resolve();
		expect(f.controller.draft().text).toBe("newer edit");
	});
	it("older page cache remains bounded while the live snapshot remains separate", async () => {
		const f = fixture();
		(f.tui.terminal as unknown as { rows: number }).rows = 2000;
		const page = (prefix: string) => ({
			messages: Array.from({ length: 200 }, (_, i) => ({
				key: prefix + i,
				entryId: prefix + i,
				message: { role: "user", content: prefix + i, timestamp: 1 } as const,
			})),
		});
		f.controller.history.mockResolvedValueOnce(page("page-one-")).mockResolvedValueOnce(page("page-two-"));
		await f.view.loadOlder();
		await f.view.loadOlder();
		expect(f.text()).toContain("page-two-0");
		expect(f.text()).not.toContain("page-one-0");
	});
	it("long dialog remains within a small terminal viewport", () => {
		const f = fixture();
		(f.tui.terminal as unknown as { rows: number }).rows = 8;
		f.ready().projection.pendingDialog = {
			type: "extension_ui_request",
			method: "confirm",
			id: "long",
			title: "permission",
			message: Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"),
		};
		f.view.refresh();
		expect(f.view.render(24).length).toBeLessThanOrEqual(8);
	});
	it("complete partial text and tool output survive switching", () => {
		const f = fixture();
		const p = createViewProjection();
		p.running = true;
		p.partial = assistant("earlier partial output");
		p.tools.call = {
			toolCallId: "call",
			toolName: "bash",
			args: { command: "slow" },
			partialResult: { content: [{ type: "text", text: "first output\nsecond output" }] },
		};
		f.choose("a", p);
		f.view.handleInput?.("\x0f");
		expect(f.text()).toContain("earlier partial output");
		expect(f.text()).toContain("first output");
		f.choose("b");
		f.choose("a", p);
		expect(f.text()).toContain("earlier partial output");
		expect(f.text()).toContain("second output");
	});
	it("left left changes view not work", () => {
		const f = fixture();
		f.ready().projection.running = true;
		f.view.handleInput?.("\x1b[D");
		f.view.handleInput?.("\x1b[D");
		expect(f.onAgents).toHaveBeenCalledOnce();
		expect(f.controller.send.mock.calls.some(([c]) => ["abort", "clear_queue"].includes(c.type))).toBe(false);
	});
	it("explicit stop preserves queued draft", async () => {
		const f = fixture();
		f.controller.setDraft({ text: "draft", images: [{ type: "image", data: "AA==", mimeType: "image/png" }] });
		f.ready().projection.running = true;
		f.view.handleInput?.("\x1b");
		await vi.waitFor(() => expect(f.controller.send.mock.calls.some(([c]) => c.type === "abort")).toBe(true));
		expect(f.controller.draft()).toEqual({
			text: "queued\n\ndraft",
			images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
		});
	});
	it("detach dialog sends no cancel", () => {
		const f = fixture();
		f.ready().projection.pendingDialog = {
			type: "extension_ui_request",
			method: "confirm",
			id: "pending-request",
			title: "permission",
			message: "allow?",
		};
		f.view.refresh();
		f.view.dispose();
		expect(f.controller.answer).not.toHaveBeenCalled();
	});
	it("cancel dialog sends exactly matching response", () => {
		const f = fixture();
		f.ready().projection.pendingDialog = {
			type: "extension_ui_request",
			method: "confirm",
			id: "pending-request",
			title: "permission",
			message: "allow?",
		};
		f.view.refresh();
		f.view.handleInput?.("\x1b");
		f.view.handleInput?.("\x1b");
		expect(f.controller.answer.mock.calls).toEqual([
			[{ type: "extension_ui_response", id: "pending-request", cancelled: true }],
		]);
	});
	it("async clipboard cannot cross session or newer edit", async () => {
		let resolve!: (clip: AgentClipboard) => void;
		const f = fixture(
			() =>
				new Promise((r) => {
					resolve = r;
				}),
		);
		f.view.handleInput?.("\x16");
		f.choose("b");
		resolve({ image: { type: "image", data: "AA==", mimeType: "image/png" } });
		await Promise.resolve();
		await Promise.resolve();
		expect(f.controller.draft().images).toEqual([]);
	});
	it("narrow Unicode lines fit and resize/theme invalidate cached lines", () => {
		const f = fixture();
		f.ready().projection.partial = assistant("界👋 very long Unicode line wrapped safely");
		f.view.refresh();
		expect(f.view.render(24).every((line) => visibleWidth(line) <= 24)).toBe(true);
		const first = f.view.render(24).join("\n");
		f.changeTheme();
		f.view.invalidate();
		const next = f.view.render(12);
		expect(next.every((line) => visibleWidth(line) <= 12)).toBe(true);
		expect(next.join("\n")).not.toBe(first);
		expect(next.join("\n")).toContain("\x1b[32m");
	});
	it("multiline editor propagates focused cursor", () => {
		const f = fixture();
		f.controller.setDraft({ text: "first\n界👋 second", images: [] });
		f.view.focused = true;
		expect(f.view.render(40).some((line) => line.includes(CURSOR_MARKER))).toBe(true);
		f.view.focused = false;
		expect(f.view.render(40).some((line) => line.includes(CURSOR_MARKER))).toBe(false);
	});
	it("load older history preserves streaming state", async () => {
		const f = fixture();
		f.ready().projection.running = true;
		f.ready().projection.partial = assistant("still streaming");
		f.controller.history.mockResolvedValueOnce({
			messages: [{ key: "old", entryId: "old", message: { role: "user", content: "older page", timestamp: 1 } }],
		});
		await f.view.loadOlder();
		expect(f.ready().projection.partial?.content).toEqual([{ type: "text", text: "still streaming" }]);
		expect(f.ready().projection.running).toBe(true);
		expect(f.text()).toContain("older page");
	});
});
