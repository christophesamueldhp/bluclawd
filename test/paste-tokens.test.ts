import { describe, expect, it } from "vitest";
import { PasteTokens, shouldCollapse } from "../ext/_shared/paste-tokens.ts";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("Claude Code's paste tokens", () => {
	it("collapses a paste over 800 characters or over 2 lines", () => {
		expect(shouldCollapse("short")).toBe(false);
		expect(shouldCollapse(lines(2))).toBe(false);
		expect(shouldCollapse(lines(3))).toBe(true);
		expect(shouldCollapse("x".repeat(801))).toBe(true);
	});

	it("numbers text and images in one sequence, as [Pasted text #N +L lines] and [Image #N]", () => {
		const tokens = new PasteTokens();
		expect(tokens.addText(lines(5))).toBe("[Pasted text #1 +4 lines]");
		expect(tokens.addText("x".repeat(900))).toBe("[Pasted text #2]");
		expect(tokens.addImage("/tmp/a.png")).toBe("[Image #3]");
	});

	it("expands text tokens on send and keeps image tokens, whose images travel separately", () => {
		const tokens = new PasteTokens();
		const text = tokens.addText(lines(3));
		const image = tokens.addImage("/tmp/a.png");
		const draft = `look: ${text} and ${image} [Image #9]`;
		expect(tokens.expandText(draft)).toBe(`look: ${lines(3)} and ${image} [Image #9]`);
		expect(tokens.imagesIn(draft)).toEqual(["/tmp/a.png"]);
		expect(tokens.imagesIn("no tokens left")).toEqual([]);
	});

	it("pasting the same content right after shows what the last token holds", () => {
		const tokens = new PasteTokens();
		const token = tokens.addText(lines(3));
		expect(tokens.repeatOf("text", lines(3))).toEqual({ token, content: lines(3) });
		expect(tokens.repeatOf("text", lines(4))).toBeUndefined();
		const image = tokens.addImage("/tmp/a.png");
		expect(tokens.repeatOf("image", "/tmp/a.png")).toEqual({ token: image, content: "/tmp/a.png" });
		expect(tokens.repeatOf("text", lines(3))).toBeUndefined(); // only the latest token
	});

	it("knows where each token sits, so a cursor can treat it as one unit", () => {
		const tokens = new PasteTokens();
		const token = tokens.addText(lines(3));
		expect(tokens.ranges(`ab ${token} cd [Pasted text #7]`)).toEqual([{ start: 3, end: 3 + token.length }]);
	});
});
