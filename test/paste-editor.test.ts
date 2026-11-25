import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editorSupportsPasteTokens, imageBlocks, PasteEditor } from "../ext/paste/index.ts";

const PASTE = (text: string) => `\x1b[200~${text}\x1b[201~`;
const BACKSPACE = "\x7f";
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

function editor() {
	const tui = { requestRender: () => {}, terminal: { rows: 40, columns: 100 } };
	const theme = { borderColor: (s: string) => s, selectList: {} };
	const keybindings = { matches: () => false, getKeys: () => [] };
	const e = new PasteEditor(tui as never, theme as never, keybindings as never);
	let submitted: string | undefined;
	e.onSubmit = (text) => {
		submitted = text;
	};
	return { e, submitted: () => submitted };
}

function clipboardImage(bytes: string): string {
	const file = join(mkdtempSync(join(tmpdir(), "paste-")), `pi-clipboard-${Math.random().toString(16).slice(2)}.png`);
	writeFileSync(file, bytes);
	return file;
}

describe("bluclawd's paste in pi's prompt", () => {
	it("runs on this pi's editor", () => {
		expect(editorSupportsPasteTokens()).toBe(true);
	});

	it("a long paste is pi's own marker, deleted in one go, sent in full", () => {
		const { e, submitted } = editor();
		e.handleInput("see ");
		e.handleInput(PASTE(lines(12)));
		expect(e.getText()).toBe("see [paste #1 +12 lines]");
		e.handleInput(BACKSPACE);
		expect(e.getText()).toBe("see ");
		e.handleInput(PASTE(lines(11)));
		e.handleInput("\r");
		expect(submitted()).toBe(`see ${lines(11)}`);
	});

	it("a ctrl+v image is an [Image #N] token; the same image again shows its path; the image goes along on send", () => {
		const { e } = editor();
		const first = clipboardImage("png-bytes");
		e.insertTextAtCursor(first);
		expect(e.getText()).toBe("[Image #1]");
		e.insertTextAtCursor(clipboardImage("png-bytes"));
		expect(e.getText()).toBe(first);

		const other = editor();
		const image = clipboardImage("other-bytes");
		other.e.insertTextAtCursor(image);
		other.e.handleInput(" what is this?");
		other.e.handleInput("\r");
		expect(other.submitted()).toBe("[Image #1] what is this?");
		expect(other.e.submittedImages).toEqual([image]);
		expect(imageBlocks(other.e.submittedImages)).toEqual([
			{ type: "image", data: Buffer.from("other-bytes").toString("base64"), mimeType: "image/png" },
		]);
	});

	it("shows pi's working spinner in its top border, as pi's own editor does", () => {
		const { e } = editor();
		e.setWorkingStatusIndicator({
			renderInBorder: () => "⠋ Pondering…",
			renderSpinnerInBorder: () => "⠋",
		} as never);
		expect(e.render(40)[0]).toBe(`── ⠋ Pondering… ${"─".repeat(24)}`);
	});
});
