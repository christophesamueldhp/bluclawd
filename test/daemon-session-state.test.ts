import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lastLine, readSessionTail, toolActivity } from "../daemon/session-state.ts";

describe("lastLine", () => {
	it("strips list markers and skips blanks", () => {
		expect(lastLine("one\n\n- two  \n")).toBe("two");
		expect(lastLine("")).toBeUndefined();
	});
});

describe("toolActivity", () => {
	it("a running tool as one line: its description, else its command or path, else its name", () => {
		expect(toolActivity("bash", { command: "sleep 40", description: "Wait, then print" })).toBe("Wait, then print");
		expect(toolActivity("read", { path: "src/a.ts" })).toBe("src/a.ts");
		expect(toolActivity("todo", {})).toBe("todo");
	});
});

describe("readSessionTail", () => {
	const write = (lines: unknown[]) => {
		const file = join(mkdtempSync(join(tmpdir(), "tail-")), "s.jsonl");
		writeFileSync(file, `${"x".repeat(20_000)}\n${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		return file;
	};
	const reply = (text: string, extra: Record<string, unknown> = {}) => ({
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text }], ...extra },
	});

	it("picks up where a transcript left off, past a cut first line: Done, its last line the detail", () => {
		const file = write([
			{ type: "message", message: { role: "user", content: "write a haiku" } },
			reply("Done.\nwrote haiku.txt"),
		]);
		expect(readSessionTail(file)).toEqual({ detail: "wrote haiku.txt", outcome: "done", turns: 1 });
	});

	it("a question in the reply text is still Done: only pi's own signals set the outcome", () => {
		expect(readSessionTail(write([reply("needs input: double jump or wall climb?")]))?.outcome).toBe("done");
	});

	it("a model error is Failed with its message; an interrupted turn is Stopped", () => {
		expect(readSessionTail(write([reply("", { stopReason: "error", errorMessage: "429 rate limited" })]))).toEqual({
			detail: "429 rate limited",
			outcome: "failed",
			turns: 1,
		});
		expect(readSessionTail(write([reply("Halfway there", { stopReason: "aborted" })]))).toEqual({
			detail: "Halfway there",
			outcome: "stopped",
			turns: 1,
		});
	});

	it("reports a session with no assistant reply as never run, and a missing file as unknown", () => {
		expect(readSessionTail(write([{ type: "message", message: { role: "user", content: "hi" } }]))).toEqual({
			turns: 0,
		});
		expect(readSessionTail("/nonexistent/s.jsonl")).toBeUndefined();
	});
});
