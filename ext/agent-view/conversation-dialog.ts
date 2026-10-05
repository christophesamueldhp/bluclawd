import type { RpcExtensionUIRequest, RpcExtensionUIResponse, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type Focusable,
	Input,
	matchesKey,
	SelectList,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
export interface ConversationDialogOptions {
	theme: Theme;
	onAnswer: (response: RpcExtensionUIResponse) => void;
	tui?: TUI;
}
class ConversationDialog implements Component, Focusable {
	private readonly request: RpcExtensionUIRequest;
	private readonly options: ConversationDialogOptions;
	private readonly child: Input | Editor | SelectList;
	private disposed = false;
	private answered = false;
	private focus = false;
	private messageScroll = 0;
	private messageLines: string[] = [];
	private messageHeight = 0;
	constructor(request: RpcExtensionUIRequest, options: ConversationDialogOptions) {
		this.request = request;
		this.options = options;
		const t = options.theme;
		if (request.method === "select" || request.method === "confirm") {
			const labels = request.method === "select" ? request.options : ["Yes", "No"];
			const list = new SelectList(
				labels.map((label, i) => ({ value: String(i), label: stripTerminalSequences(label) })),
				Math.max(1, Math.min(6, Math.floor(((options.tui?.terminal.rows ?? 24) - 5) / 2))),
				{
					selectedPrefix: (s) => t.fg("accent", s),
					selectedText: (s) => t.fg("accent", s),
					description: (s) => t.fg("muted", s),
					scrollInfo: (s) => t.fg("dim", s),
					noMatch: (s) => t.fg("muted", s),
				},
			);
			list.onSelect = (item) =>
				this.answer(
					request.method === "confirm" ? { confirmed: item.value === "0" } : { value: labels[Number(item.value)] },
				);
			list.onCancel = () => this.answer({ cancelled: true });
			this.child = list;
		} else if (request.method === "input") {
			const input = new Input();
			input.onSubmit = (value) => this.answer({ value });
			input.onEscape = () => this.answer({ cancelled: true });
			this.child = input;
		} else if (request.method === "editor") {
			// This adapter supplies only editor layout/invalidation, never another renderer.
			const tui = options.tui ?? ({ terminal: { rows: 24, columns: 80 }, requestRender: () => {} } as TUI);
			const editor = new Editor(tui, {
				borderColor: (s) => t.fg("border", s),
				selectList: {
					selectedPrefix: (s) => t.fg("accent", s),
					selectedText: (s) => t.fg("accent", s),
					description: (s) => t.fg("muted", s),
					scrollInfo: (s) => t.fg("dim", s),
					noMatch: (s) => t.fg("muted", s),
				},
			});
			editor.setText(stripTerminalSequences(request.prefill ?? ""));
			editor.onSubmit = (value) => this.answer({ value });
			this.child = editor;
		} else throw new Error(`Not an interactive dialog: ${request.method}`);
	}
	get focused() {
		return this.focus;
	}
	set focused(value: boolean) {
		this.focus = value;
		if ("focused" in this.child) this.child.focused = value;
	}
	private answer(fields: { value: string } | { confirmed: boolean } | { cancelled: true }) {
		if (this.disposed || this.answered) return;
		this.answered = true;
		this.options.onAnswer({ type: "extension_ui_response", id: this.request.id, ...fields });
	}
	handleInput(data: string): void {
		if (this.disposed || this.answered) return;
		if (
			this.request.method === "confirm" &&
			this.messageLines.length > this.messageHeight &&
			(matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))
		) {
			this.messageScroll = Math.max(
				0,
				Math.min(
					this.messageLines.length - this.messageHeight,
					this.messageScroll + (matchesKey(data, "pageDown") ? 1 : -1) * Math.max(1, this.messageHeight),
				),
			);
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.answer({ cancelled: true });
			return;
		}
		if (this.request.method === "editor" && this.child instanceof Editor) {
			if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+s")) {
				this.answer({ value: this.child.getExpandedText() });
				return;
			}
			if (matchesKey(data, "enter")) {
				this.child.insertTextAtCursor("\n");
				return;
			}
		}
		this.child.handleInput(data);
	}
	render(width: number): string[] {
		const w = Math.max(1, width);
		const t = this.options.theme;
		const title = "title" in this.request ? this.request.title : "Question";
		const lines = [t.fg("accent", stripTerminalSequences(title).replace(/[\r\n]+/g, " "))];
		const child = this.child.render(w);
		const rows = this.options.tui?.terminal.rows ?? 24;
		const budget = Math.max(4, rows - (rows < 10 ? 1 : 2) - (rows >= 16 ? 1 : 0) - 1);
		if (this.request.method === "confirm") {
			this.messageLines = wrapTextWithAnsi(stripTerminalSequences(this.request.message), w);
			this.messageHeight = Math.max(0, budget - child.length - 2);
			this.messageScroll = Math.min(this.messageScroll, Math.max(0, this.messageLines.length - this.messageHeight));
			lines.push(...this.messageLines.slice(this.messageScroll, this.messageScroll + this.messageHeight));
		}
		if (this.request.method === "input" && this.request.placeholder)
			lines.push(t.fg("dim", stripTerminalSequences(this.request.placeholder)));
		lines.push(...child);
		lines.push(
			t.fg(
				"dim",
				this.answered
					? "Answer sent; waiting for owner"
					: this.request.method === "editor"
						? "Ctrl+Enter save · Esc cancel"
						: this.messageLines.length > this.messageHeight
							? `PgUp/PgDn text (${this.messageScroll + 1}/${this.messageLines.length}) · Enter answer · Esc cancel`
							: "Enter answer · Esc cancel",
			),
		);
		return lines.map((line) => truncateToWidth(line, w, ""));
	}
	invalidate(): void {
		this.child.invalidate();
	}
	dispose(): void {
		this.disposed = true;
		this.focused = false;
	}
}
export function createConversationDialog(
	request: RpcExtensionUIRequest,
	options: ConversationDialogOptions,
): Component & Focusable & { dispose(): void } {
	return new ConversationDialog(request, options);
}
