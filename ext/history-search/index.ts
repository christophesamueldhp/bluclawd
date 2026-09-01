/**
 * Ctrl+R reverse incremental history search for the main input editor.
 *
 * Two pi mechanisms carry it, both public: `ctx.ui.setEditorComponent` swaps in
 * `HistorySearchEditor` (a `CustomEditor` subclass — pi's own documented path
 * for replacing the editor), and the `input` event supplies the history it
 * searches, since the base editor does not expose its own.
 */
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { HistorySearchEditor } from "./editor.ts";

const MAX_HISTORY = 100;

const historySearch: InlineExtension = {
	name: "history-search",
	factory: (pi) => {
		const history: string[] = [];

		pi.on("input", (event) => {
			if (event.source === "interactive" && event.text.trim()) {
				if (history[0] !== event.text) history.unshift(event.text);
				if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
			}
			return { action: "continue" };
		});

		pi.on("session_start", (_event, ctx) => {
			ctx.ui.setEditorComponent(
				(tui, theme, keybindings) => new HistorySearchEditor(tui, theme, keybindings, history, ctx),
			);
		});
	},
};

export default historySearch;
