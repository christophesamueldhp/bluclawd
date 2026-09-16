/**
 * `/web`: browse what webfetch and websearch stored this session, in the TUI.
 *
 * This is bluclawd's take on pi-web-access's curator. That one is a browser page
 * served from a local HTTP server, and its own author made it default-off; here
 * the same review happens in pi's own selector: pick an entry, read it, or hand
 * it to the next prompt.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { clearContent, getContent, listContent, type StoredContent } from "./store.ts";

function size(text: string): string {
	const chars = text.length;
	return chars < 1024 ? `${chars} chars` : `${(chars / 1024).toFixed(1)}K chars`;
}

function label(entry: StoredContent): string {
	return `${entry.id.padEnd(4)} ${entry.kind === "fetch" ? "page  " : "search"} ${entry.source}  (${size(entry.text)})`;
}

const VIEW = "View";
const REFERENCE = "Mention it in the prompt (id only)";
const PASTE = "Paste its text into the prompt";

export async function browseWeb(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (args.trim() === "clear") {
		clearContent();
		ctx.ui.notify("Stored web content cleared.", "info");
		return;
	}
	const entries = listContent();
	if (entries.length === 0) {
		ctx.ui.notify("Nothing fetched or searched yet this session.", "info");
		return;
	}
	const labels = entries.map(label);
	const picked = await ctx.ui.select("Web content this session", labels);
	if (picked === undefined) return;
	const entry = getContent(entries[labels.indexOf(picked)]?.id ?? "");
	if (!entry) return;
	const action = await ctx.ui.select(`${entry.id} ${entry.source}`, [VIEW, REFERENCE, PASTE]);
	if (action === VIEW) {
		// The editor is the scrollable text view pi offers; what is typed into it is discarded.
		await ctx.ui.editor(`${entry.id} ${entry.source} (read only: edits are discarded)`, entry.text);
	} else if (action === REFERENCE) {
		ctx.ui.pasteToEditor(`(web content ${entry.id}: ${entry.source}) `);
	} else if (action === PASTE) {
		ctx.ui.pasteToEditor(entry.text);
	}
}

export function registerWebCommand(pi: ExtensionAPI): void {
	pi.registerCommand("web", {
		description: "Browse pages and search results fetched this session (/web clear forgets them)",
		handler: async (args, ctx) => browseWeb(args, ctx),
	});
}
