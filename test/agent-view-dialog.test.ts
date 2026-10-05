import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationDialog } from "../ext/agent-view/conversation-dialog.ts";

let dir: string;
const dialogs: Array<{ dispose(): void }> = [];
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "view-dialog-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	initTheme("dark");
});
afterEach(() => {
	for (const d of dialogs.splice(0)) d.dispose();
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});
function options(answers: RpcExtensionUIResponse[]) {
	return {
		theme,
		onAnswer: (answer: RpcExtensionUIResponse) => answers.push(answer),
		tui: { terminal: { rows: 24, columns: 80 }, requestRender: () => {} } as TUI,
	};
}
describe("remote conversation dialogs", () => {
	it("detach dialog sends no cancel", () => {
		const answers: RpcExtensionUIResponse[] = [];
		const d = createConversationDialog(
			{
				type: "extension_ui_request",
				id: "pending-request",
				method: "confirm",
				title: "permission",
				message: "allow",
			},
			options(answers),
		);
		dialogs.push(d);
		d.dispose();
		d.handleInput?.("\x1b");
		expect(answers).toEqual([]);
	});
	it("cancel dialog sends exactly matching response", () => {
		const answers: RpcExtensionUIResponse[] = [];
		const d = createConversationDialog(
			{ type: "extension_ui_request", id: "pending-request", method: "input", title: "answer" },
			options(answers),
		);
		dialogs.push(d);
		d.handleInput?.("\x1b");
		d.handleInput?.("\x1b");
		expect(answers).toEqual([{ type: "extension_ui_response", id: "pending-request", cancelled: true }]);
	});
	it("confirm and select return their protocol values once", () => {
		const answers: RpcExtensionUIResponse[] = [];
		const yes = createConversationDialog(
			{ type: "extension_ui_request", id: "yes", method: "confirm", title: "confirm", message: "continue?" },
			options(answers),
		);
		dialogs.push(yes);
		yes.handleInput?.("\r");
		yes.handleInput?.("\r");
		const select = createConversationDialog(
			{ type: "extension_ui_request", id: "select", method: "select", title: "pick", options: ["first", "second"] },
			options(answers),
		);
		dialogs.push(select);
		select.handleInput?.("\x1b[B");
		select.handleInput?.("\r");
		expect(answers).toEqual([
			{ type: "extension_ui_response", id: "yes", confirmed: true },
			{ type: "extension_ui_response", id: "select", value: "second" },
		]);
	});
	it("input propagates focused IME cursor and fits narrow Unicode", () => {
		const answers: RpcExtensionUIResponse[] = [];
		const d = createConversationDialog(
			{ type: "extension_ui_request", id: "input", method: "input", title: "回答 👋", placeholder: "text" },
			options(answers),
		);
		dialogs.push(d);
		d.focused = true;
		d.handleInput?.("界👋");
		const lines = d.render(24);
		expect(lines.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
		expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
		d.handleInput?.("\r");
		expect(answers[0]).toMatchObject({ id: "input", value: "界👋" });
	});
	it("editor preserves multiline text and submits on Ctrl Enter", () => {
		const answers: RpcExtensionUIResponse[] = [];
		const d = createConversationDialog(
			{ type: "extension_ui_request", id: "editor", method: "editor", title: "edit", prefill: "first" },
			options(answers),
		);
		dialogs.push(d);
		d.focused = true;
		d.handleInput?.("\r");
		d.handleInput?.("second");
		expect(d.render(40).some((line) => line.includes(CURSOR_MARKER))).toBe(true);
		d.handleInput?.("\x1b[13;5u");
		expect(answers[0]).toEqual({ type: "extension_ui_response", id: "editor", value: "first\nsecond" });
	});
});
