import type {
	KeybindingsManager as CodingAgentKeybindingsManager,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
// `KeybindingsManager` is type-only in @earendil-works/pi-coding-agent's public
// entry; pi-tui's own (the base class it extends) is a real export, and works
// here because nothing this test exercises calls the three members
// coding-agent's subclass adds (configPath, reload, getEffectiveConfig) — only
// `.matches()`/`.getKeys()`, which the base class already implements. Built
// with empty definitions: HistorySearchEditor's own Ctrl+R check is a direct
// `matchesKey(data, "ctrl+r")`, not routed through this manager, so no
// default binding table is needed for these tests to be meaningful.
import { KeybindingsManager, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { HistorySearchEditor } from "../ext/history-search/editor.ts";
import { defaultEditorTheme } from "./fixtures/test-themes.ts";
import { VirtualTerminal } from "./fixtures/virtual-terminal.ts";

function makeKeybindings(): CodingAgentKeybindingsManager {
	return new KeybindingsManager({}) as unknown as CodingAgentKeybindingsManager;
}

/** Records every `setWidget` call so tests can assert what the status line showed. */
function makeCtxStub() {
	const widgets: Array<string[] | undefined> = [];
	const ctx = {
		ui: {
			setWidget: (_key: string, content: string[] | undefined) => {
				widgets.push(content);
			},
			theme: { fg: (_color: string, text: string) => text },
		},
	} as unknown as ExtensionContext;
	return { ctx, widgets };
}

function makeEditor(history: string[]) {
	const { ctx, widgets } = makeCtxStub();
	const keybindings = makeKeybindings();
	const editor = new HistorySearchEditor(
		new TuiMainScreen(new VirtualTerminal()),
		defaultEditorTheme,
		keybindings,
		history,
		ctx,
	);
	return { editor, widgets };
}

describe("HistorySearchEditor", () => {
	afterEach(() => {
		setKeybindings(new KeybindingsManager({}));
	});

	it("does nothing to normal typing — falls through to the base editor", () => {
		const { editor } = makeEditor([]);
		editor.handleInput("h");
		editor.handleInput("i");
		expect(editor.getText()).toBe("hi");
	});

	it("Ctrl+R with an empty query shows the search widget but changes no text", () => {
		const { editor, widgets } = makeEditor(["old message"]);
		editor.setText("draft");
		editor.handleInput("\x12"); // Ctrl+R
		expect(editor.getText()).toBe("draft");
		expect(widgets.at(-1)?.[0]).toContain("(reverse-i-search)");
	});

	it("typing a query finds the most recent matching history entry", () => {
		const { editor, widgets } = makeEditor(["second message here", "hello world test"]);
		editor.handleInput("\x12");
		for (const ch of "hello") editor.handleInput(ch);
		expect(editor.getText()).toBe("hello world test");
		expect(widgets.at(-1)?.[0]).toContain("(reverse-i-search)`hello'");
	});

	it("repeat Ctrl+R jumps to the next older match", () => {
		const { editor } = makeEditor(["match two", "no", "match one"]);
		editor.handleInput("\x12");
		for (const ch of "match") editor.handleInput(ch);
		expect(editor.getText()).toBe("match two");
		editor.handleInput("\x12");
		expect(editor.getText()).toBe("match one");
	});

	it("backspace narrows the query and re-searches from the most recent entry", () => {
		const { editor } = makeEditor(["hello recent", "hello old"]);
		editor.handleInput("\x12");
		for (const ch of "hello o") editor.handleInput(ch);
		// "hello recent" doesn't contain "hello o"; only the older entry does.
		expect(editor.getText()).toBe("hello old");
		editor.handleInput("\x7f"); // backspace: query becomes "hello "
		// Re-search restarts from index 0, so the most recent entry wins again.
		expect(editor.getText()).toBe("hello recent");
	});

	it("no match leaves the editor text as-is and flags the widget", () => {
		const { editor, widgets } = makeEditor(["one", "two"]);
		editor.handleInput("\x12");
		for (const ch of "zzz") editor.handleInput(ch);
		expect(widgets.at(-1)?.[0]).toContain("(no match)");
	});

	it("Escape restores the pre-search draft and clears the widget", () => {
		const { editor, widgets } = makeEditor(["stored"]);
		editor.setText("my draft");
		editor.handleInput("\x12");
		for (const ch of "stored") editor.handleInput(ch);
		expect(editor.getText()).toBe("stored");
		editor.handleInput("\x1b"); // Escape
		expect(editor.getText()).toBe("my draft");
		expect(widgets.at(-1)).toBeUndefined();
	});

	it("Enter accepts the match, keeps the text, and clears the widget", () => {
		const { editor, widgets } = makeEditor(["accepted message"]);
		editor.handleInput("\x12");
		for (const ch of "accepted") editor.handleInput(ch);
		editor.handleInput("\r"); // Enter
		expect(editor.getText()).toBe("accepted message");
		expect(widgets.at(-1)).toBeUndefined();
	});
});
