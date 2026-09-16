/**
 * The prompt editor with bash mode: while it is on, Enter sends the line to the
 * persistent shell instead of the model, Up/Down walk this session's shell
 * commands, Escape leaves bash mode and Ctrl+C interrupts a running command.
 * Outside bash mode it is pi's editor, unchanged.
 */
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

export type BashModeKeyAction = "submit" | "exit" | "interrupt" | "history-back" | "history-forward";

/** What a key does in bash mode, or undefined when the normal editor should handle it. */
export function bashModeKeyAction(
	keybindings: Pick<KeybindingsManager, "matches">,
	data: string,
	state: { bashMode: boolean; running: boolean },
): BashModeKeyAction | undefined {
	if (!state.bashMode) return undefined;
	if (keybindings.matches(data, "app.interrupt")) return "exit";
	if (keybindings.matches(data, "app.clear")) return state.running ? "interrupt" : undefined;
	if (keybindings.matches(data, "tui.editor.cursorUp")) return "history-back";
	if (keybindings.matches(data, "tui.editor.cursorDown")) return "history-forward";
	if (keybindings.matches(data, "tui.input.submit") && !keybindings.matches(data, "tui.input.newLine")) {
		return "submit";
	}
	return undefined;
}

export interface ShellEditorHooks {
	bashMode(): boolean;
	running(): boolean;
	exitBashMode(): void;
	interrupt(): void;
	submit(command: string): void;
	/** Shell commands of this session, oldest first. */
	history(): readonly string[];
	notify(message: string): void;
}

export class ShellEditor extends CustomEditor {
	private readonly keys: KeybindingsManager;
	private readonly hooks: ShellEditorHooks;
	/** Position while walking history: `history().length` means "the draft". */
	private shellHistoryIndex: number | undefined;
	private shellHistoryDraft = "";

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, hooks: ShellEditorHooks) {
		super(tui, theme, keybindings);
		this.keys = keybindings;
		this.hooks = hooks;
	}

	handleInput(data: string): void {
		const action = bashModeKeyAction(this.keys, data, {
			bashMode: this.hooks.bashMode(),
			running: this.hooks.running(),
		});
		switch (action) {
			case "exit":
				this.shellHistoryIndex = undefined;
				this.hooks.exitBashMode();
				return;
			case "interrupt":
				this.hooks.interrupt();
				return;
			case "history-back":
			case "history-forward":
				this.walkHistory(action === "history-back" ? -1 : 1);
				return;
			case "submit": {
				const command = this.getExpandedText().trim();
				if (!command) return;
				if (this.hooks.running()) {
					this.hooks.notify("A shell command is still running — Ctrl+C interrupts it.");
					return;
				}
				this.shellHistoryIndex = undefined;
				this.hooks.submit(command);
				this.setText("");
				return;
			}
			default:
				super.handleInput(data);
		}
	}

	private walkHistory(step: -1 | 1): void {
		const history = this.hooks.history();
		if (history.length === 0) return;
		if (this.shellHistoryIndex === undefined) {
			if (step === 1) return;
			this.shellHistoryDraft = this.getText();
			this.shellHistoryIndex = history.length;
		}
		const next = Math.max(0, Math.min(history.length, this.shellHistoryIndex + step));
		this.shellHistoryIndex = next;
		this.setText(next === history.length ? this.shellHistoryDraft : history[next]);
		if (next === history.length) this.shellHistoryIndex = undefined;
	}
}
