import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAgentClipboard } from "../ext/agent-view/clipboard.ts";

let root: string | undefined;
afterEach(() => {
	vi.unstubAllEnvs();
	if (root) rmSync(root, { recursive: true, force: true });
});

function clipboardModules(image: string) {
	root = mkdtempSync(join(tmpdir(), "bluclawd-clipboard-"));
	mkdirSync(join(root, "dist/utils"), { recursive: true });
	writeFileSync(join(root, "package.json"), '{"type":"module"}');
	writeFileSync(
		join(root, "dist/utils/clipboard-image.js"),
		`export async function readClipboardImage() { return ${image}; }`,
	);
	writeFileSync(
		join(root, "dist/utils/clipboard.js"),
		'export async function readClipboardText() { return "clipboard text"; }',
	);
	vi.stubEnv("PI_PACKAGE_ROOT", root);
}

describe("Agent View clipboard bridge", () => {
	it("uses the active Pi clipboard reader and encodes image bytes for model messages", async () => {
		clipboardModules('{ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" }');
		expect(await readAgentClipboard()).toEqual({ image: { type: "image", data: "AQID", mimeType: "image/png" } });
	});
	it("uses text when the clipboard has no image", async () => {
		clipboardModules("null");
		expect(await readAgentClipboard()).toEqual({ text: "clipboard text" });
	});
});
