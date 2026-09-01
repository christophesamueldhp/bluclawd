/**
 * Ctrl+R reverse incremental history search, readline-style.
 *
 * pi's own `Editor` keeps its input history (`history`/`state`/`historyDraft`)
 * private, and `navigateHistory` (Up/Down) only steps by ±1 — there is no public
 * way to jump to an arbitrary match. So this keeps its own parallel history
 * array (fed by the `input` event in `index.ts`) instead of reaching into the
 * base editor, and drives the visible text through the public `setText`/`getText`.
 */

import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, matchesKey, type TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "history-search";

export class HistorySearchEditor extends CustomEditor {
	private active = false;
	private query = "";
	private matchIndex = -1; // index into historyLog of the current match, -1 = none
	private draft: string | null = null;
	private readonly historyLog: readonly string[];
	private readonly ctx: ExtensionContext;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		history: readonly string[],
		ctx: ExtensionContext,
	) {
		super(tui, theme, keybindings);
		this.historyLog = history;
		this.ctx = ctx;
	}

	private renderStatus(): void {
		if (!this.active) {
			this.ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const noMatch = this.query.length > 0 && this.matchIndex === -1;
		const line = `(reverse-i-search)\`${this.query}'${noMatch ? "  (no match)" : ""}`;
		this.ctx.ui.setWidget(WIDGET_KEY, [this.ctx.ui.theme.fg("dim", line)], { placement: "belowEditor" });
	}

	/** First history entry at or after `from` containing the query (case-insensitive). */
	private find(from: number): void {
		const query = this.query.toLowerCase();
		if (!query) return;
		for (let i = Math.max(0, from); i < this.historyLog.length; i++) {
			if (this.historyLog[i].toLowerCase().includes(query)) {
				this.matchIndex = i;
				this.setText(this.historyLog[i]);
				return;
			}
		}
	}

	private enter(): void {
		this.draft = this.getText();
		this.active = true;
		this.query = "";
		this.matchIndex = -1;
		this.renderStatus();
	}

	/** @param restore Put back the text that was being typed before search started. */
	private exit(restore: boolean): void {
		this.active = false;
		if (restore && this.draft !== null) this.setText(this.draft);
		this.query = "";
		this.matchIndex = -1;
		this.draft = null;
		this.renderStatus();
	}

	handleInput(data: string): void {
		if (this.active) {
			if (matchesKey(data, "ctrl+r")) {
				this.find(this.matchIndex + 1); // repeat: jump to the next older match
				this.renderStatus();
				return;
			}
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
				this.exit(true); // cancel: restore what was being typed
				return;
			}
			if (matchesKey(data, "return") || matchesKey(data, "enter")) {
				this.exit(false); // accept: keep the match for editing/submission
				return;
			}
			if (matchesKey(data, "backspace")) {
				if (this.query.length > 0) {
					this.query = this.query.slice(0, -1);
					this.matchIndex = -1;
					this.find(0);
				}
				this.renderStatus();
				return;
			}
			if (data.length === 1 && data.charCodeAt(0) >= 0x20 && data.charCodeAt(0) < 0x7f) {
				this.query += data;
				// Re-check from the current match first: it may still satisfy the
				// longer query; otherwise the scan continues to older entries.
				this.find(this.matchIndex === -1 ? 0 : this.matchIndex);
				this.renderStatus();
				return;
			}
			// Any other key (arrows, etc.) accepts the current match and falls
			// through so the base editor still handles it normally.
			this.exit(false);
		}

		if (matchesKey(data, "ctrl+r")) {
			this.enter();
			return;
		}

		super.handleInput(data);
	}
}
