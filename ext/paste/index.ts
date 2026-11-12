/**
 * bluclawd's image paste in pi's prompt: a ctrl+v image shows as `[Image #N]` where pi's own
 * editor inserts the image's file path, and the image goes with the prompt as an image block.
 * Pasting the same image again right after shows its path. Pasted text is left to pi, which
 * collapses a long paste into its own `[paste #N …]` marker and expands it on send.
 *
 * pi's editor keeps its internals private, so this patches the few internal methods it needs on
 * each editor instance. When a pi update renames them, the default editor stays.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
	CustomEditor,
	type ExtensionAPI,
	type InlineExtension,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { PasteTokens } from "../_shared/paste-tokens.ts";
import { timed } from "../_shared/timing.ts";

interface Segment {
	segment: string;
	index: number;
	input: string;
}

/** The internals of pi-tui's Editor this relies on. */
interface EditorInternals {
	state: { lines: string[]; cursorLine: number; cursorCol: number };
	lastAction: unknown;
	segment(text: string, mode: "grapheme" | "word"): Iterable<Segment>;
	submitValue(): void;
	insertTextAtCursorInternal(text: string): void;
	pushUndoSnapshot(): void;
	setCursorCol(col: number): void;
	cancelAutocomplete(): void;
	exitHistoryBrowsing(): void;
}

const INTERNALS = [
	"segment",
	"submitValue",
	"insertTextAtCursorInternal",
	"pushUndoSnapshot",
	"setCursorCol",
	"cancelAutocomplete",
	"exitHistoryBrowsing",
] as const;

export function editorSupportsPasteTokens(): boolean {
	const proto = Editor.prototype as unknown as Record<string, unknown>;
	return INTERNALS.every((name) => typeof proto[name] === "function");
}

/** pi's clipboard image: written to the temp dir as `pi-clipboard-<uuid>.<ext>`. */
const CLIPBOARD_IMAGE = /(^|[/\\])pi-clipboard-[\w-]+\.(png|jpe?g|gif|webp)$/i;

const MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
};

function sameBytes(a: string, b: string): boolean {
	try {
		return readFileSync(a).equals(readFileSync(b));
	} catch {
		return false;
	}
}

export class PasteEditor extends CustomEditor {
	private readonly tokens = new PasteTokens();
	/** The images whose tokens were in the prompt just submitted, for the input event. */
	submittedImages: string[] = [];

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		const self = this as unknown as EditorInternals;
		const baseSegment = self.segment.bind(this);
		const baseSubmit = self.submitValue.bind(this);
		const baseSetText = this.setText.bind(this);
		const baseInsert = this.insertTextAtCursor.bind(this);

		// A token moves, wraps and deletes as one unit, as pi's own paste markers do.
		self.segment = (text, mode) => {
			const ranges = this.tokens.ranges(text);
			const base = [...baseSegment(text, mode)];
			if (ranges.length === 0) return base;
			const out: Segment[] = [];
			for (const seg of base) {
				const range = ranges.find((r) => seg.index >= r.start && seg.index < r.end);
				if (!range) out.push(seg);
				else if (seg.index === range.start)
					out.push({ segment: text.slice(range.start, range.end), index: range.start, input: text });
			}
			return out;
		};
		self.submitValue = () => {
			this.submittedImages = this.tokens.imagesIn(this.getText());
			baseSubmit();
			this.tokens.clear();
		};
		this.setText = (text) => {
			this.tokens.clear();
			baseSetText(text);
		};
		// pi's ctrl+v inserts a clipboard image's path, or the clipboard's text, through here.
		this.insertTextAtCursor = (text) => {
			if (CLIPBOARD_IMAGE.test(text.trim())) {
				if (this.expandRepeat(text.trim())) return;
				this.insertToken(this.tokens.addImage(text.trim()));
				return;
			}
			this.tokens.settle();
			baseInsert(text);
		};
	}

	private insertToken(token: string): void {
		const self = this as unknown as EditorInternals;
		self.cancelAutocomplete();
		self.exitHistoryBrowsing();
		self.lastAction = null;
		self.pushUndoSnapshot();
		self.insertTextAtCursorInternal(token);
	}

	/** The same image again, right after its token: the token gives way to the image's path. */
	private expandRepeat(path: string): boolean {
		const repeat = this.tokens.repeatOf("image", path, sameBytes);
		if (!repeat) return false;
		const self = this as unknown as EditorInternals;
		const line = self.state.lines[self.state.cursorLine] ?? "";
		const before = line.slice(0, self.state.cursorCol);
		if (!before.endsWith(repeat.token)) return false;
		self.pushUndoSnapshot();
		const start = before.length - repeat.token.length;
		self.state.lines[self.state.cursorLine] = line.slice(0, start) + line.slice(self.state.cursorCol);
		self.setCursorCol(start);
		self.insertTextAtCursorInternal(repeat.content);
		this.tokens.settle();
		return true;
	}
}

/** The images a prompt's `[Image #N]` tokens stand for, as image blocks. */
export function imageBlocks(paths: string[]): ImageContent[] {
	const blocks: ImageContent[] = [];
	for (const path of paths) {
		try {
			blocks.push({
				type: "image",
				data: readFileSync(path).toString("base64"),
				mimeType: MIME[extname(path).toLowerCase()] ?? "image/png",
			});
		} catch {
			// gone from the temp dir: the token stays as text
		}
	}
	return blocks;
}

function factory(pi: ExtensionAPI): void {
	let editor: PasteEditor | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !editorSupportsPasteTokens()) return;
		// Another extension's editor wins: replacing it would drop its behaviour.
		if (ctx.ui.getEditorComponent()) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			editor = new PasteEditor(tui, theme, keybindings);
			return editor;
		});
	});

	pi.on("input", (event) => {
		const paths = editor?.submittedImages ?? [];
		if (!editor || paths.length === 0) return { action: "continue" };
		editor.submittedImages = [];
		const images = imageBlocks(paths);
		if (images.length === 0) return { action: "continue" };
		return { action: "transform", text: event.text, images: [...(event.images ?? []), ...images] };
	});
}

const pasteExtension: InlineExtension = { name: "paste", factory };
export default timed("paste", pasteExtension.factory);
