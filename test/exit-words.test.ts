import { describe, expect, it } from "vitest";
import { isQuitAlias } from "../ext/agent-view/index.ts";

describe("exit words, as in Claude Code", () => {
	it("an exit word or /exit alone at the prompt stands for /quit", () => {
		for (const text of ["exit", "quit", ":q", ":q!", ":wq", ":wq!", "/exit", "  exit  "]) {
			expect(isQuitAlias(text)).toBe(true);
		}
	});

	it("anything else is left to the editor", () => {
		for (const text of ["", "exit now", "Exit", "!exit", "/exit now", "/quit"]) {
			expect(isQuitAlias(text)).toBe(false);
		}
	});
});
