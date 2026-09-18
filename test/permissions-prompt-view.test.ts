/**
 * The terminal permission dialog (Claude Code's layout): numbered rows, one `No`,
 * and a note typed on `No` with Tab.
 */
import { describe, expect, it } from "vitest";
import { type ProceedAnswer, ProceedPrompt } from "../ext/permissions/prompt-view.ts";

const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const TAB = "\t";

function open(options = ["Yes", "Yes, and don't ask again for npm test commands in ~/p"]) {
	const answers: ProceedAnswer[] = [];
	const view = new ProceedPrompt("Bash command\n\n  npm test\n\nDo you want to proceed?", options, plain, (a) =>
		answers.push(a),
	);
	const keys = (...data: string[]) => {
		for (const d of data) view.handleInput(d);
	};
	return { view, answers, keys };
}

describe("ProceedPrompt", () => {
	it("draws numbered rows with No last and the first row selected", () => {
		const { view } = open();
		const lines = view.render(100);
		expect(lines[0]).toBe("─".repeat(100));
		expect(lines.slice(1, 5)).toEqual([" Bash command", " ", "   npm test", " "]);
		expect(lines).toContain(" ❯ 1. Yes");
		expect(lines).toContain("   2. Yes, and don't ask again for npm test commands in ~/p");
		expect(lines).toContain("   3. No");
	});

	it("picks a row by its number", () => {
		const { answers, keys } = open();
		keys("2");
		expect(answers).toEqual([{ kind: "option", index: 1 }]);
	});

	it("picks No by its number, and ignores numbers past the last row", () => {
		const { answers, keys } = open();
		keys("9", "3");
		expect(answers).toEqual([{ kind: "no" }]);
	});

	it("moves with the arrows and confirms with Enter", () => {
		const { answers, keys } = open();
		keys(DOWN, DOWN, DOWN, UP, ENTER);
		expect(answers).toEqual([{ kind: "option", index: 1 }]);
	});

	it("treats Esc as No", () => {
		const { answers, keys } = open();
		keys(ESC);
		expect(answers).toEqual([{ kind: "no" }]);
	});

	it("types a note on No with Tab and sends it with Enter", () => {
		const { view, answers, keys } = open(["Yes"]);
		keys(DOWN, TAB, ..."use pnpm");
		expect(view.render(100).some((line) => line.includes("No,") && line.includes("use pnpm"))).toBe(true);
		keys(ENTER);
		expect(answers).toEqual([{ kind: "no", note: "use pnpm" }]);
	});

	it("leaves the note with Esc without answering, and Tab does nothing off the No row", () => {
		const { answers, keys } = open(["Yes"]);
		keys(TAB, DOWN, TAB, "x", ESC);
		expect(answers).toEqual([]);
		keys(ENTER);
		expect(answers).toEqual([{ kind: "no" }]);
	});

	it("an empty note is a plain No", () => {
		const { answers, keys } = open(["Yes"]);
		keys(DOWN, TAB, "  ", ENTER);
		expect(answers).toEqual([{ kind: "no", note: undefined }]);
	});
});
