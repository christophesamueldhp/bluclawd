import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	lastLine,
	needsFromRequest,
	readSessionTail,
	SessionStateTracker,
	scanSentinel,
} from "../daemon/session-state.ts";

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text }], ...extra },
});

describe("scanSentinel", () => {
	it("finds the last sentinel line, case-insensitive, markdown-tolerant", () => {
		expect(scanSentinel("did stuff\nresult: tests pass")).toEqual({ kind: "result", text: "tests pass" });
		expect(scanSentinel("**Needs input:** double jump or wall climb?")).toEqual({
			kind: "needs",
			text: "double jump or wall climb?",
		});
		expect(scanSentinel("result: first\nfailed: build broke")).toEqual({ kind: "failed", text: "build broke" });
		expect(scanSentinel("no sentinel here")).toBeUndefined();
	});

	it("does not match the word mid-sentence", () => {
		expect(scanSentinel("the result: is fine")).toBeUndefined();
	});
});

describe("lastLine", () => {
	it("strips list markers and skips blanks", () => {
		expect(lastLine("one\n\n- two  \n")).toBe("two");
		expect(lastLine("")).toBeUndefined();
	});
});

describe("SessionStateTracker", () => {
	it("a settled turn with a result line is Done with that result as detail", () => {
		const t = new SessionStateTracker();
		t.apply({ type: "agent_start" });
		t.apply(assistant("Working on it.\nresult: menu, options, and credits done"));
		t.apply({ type: "agent_settled" }, new Date("2026-09-23T10:00:00Z"));
		expect(t.outcome).toBe("done");
		expect(t.detail).toBe("result: menu, options, and credits done");
		expect(t.turns).toBe(1);
		expect(t.finishedAt).toBe("2026-09-23T10:00:00.000Z");
	});

	it("a needs-input line leaves the session waiting, not done", () => {
		const t = new SessionStateTracker();
		t.apply({ type: "agent_start" });
		t.apply(assistant("needs input: double jump or wall climb?"));
		t.apply({ type: "agent_settled" });
		expect(t.outcome).toBeUndefined();
		expect(t.needsText).toBe("double jump or wall climb?");
	});

	it("a failed line or a model error is Failed", () => {
		const a = new SessionStateTracker();
		a.apply(assistant("failed: could not reach the database"));
		a.apply({ type: "agent_settled" });
		expect(a.outcome).toBe("failed");
		expect(a.detail).toBe("could not reach the database");

		const b = new SessionStateTracker();
		b.apply(assistant("", { stopReason: "error", errorMessage: "429 rate limited" }));
		b.apply({ type: "agent_settled" });
		expect(b.outcome).toBe("failed");
		expect(b.detail).toBe("429 rate limited");
	});

	it("without a sentinel the last line of assistant text is the detail", () => {
		const t = new SessionStateTracker();
		t.apply({ type: "message_start", message: { role: "user", content: "fix the flaky test" } });
		expect(t.detail).toBe("> fix the flaky test");
		t.apply(assistant("Adding swept-AABB checks to CollisionSystem"));
		expect(t.detail).toBe("Adding swept-AABB checks to CollisionSystem");
		t.apply({ type: "tool_execution_end", isError: true, result: { content: [{ type: "text", text: "ENOENT" }] } });
		expect(t.detail).toBe("✗ ENOENT");
		t.apply({ type: "agent_settled" });
		expect(t.outcome).toBe("done");
	});

	it("a new run clears the previous outcome and question", () => {
		const t = new SessionStateTracker({ outcome: "done", turns: 2 });
		t.apply({ type: "agent_start" });
		expect(t.outcome).toBeUndefined();
		expect(t.turns).toBe(2);
	});
});

describe("needsFromRequest", () => {
	it("keeps the options of a select and drops fire-and-forget methods", () => {
		expect(
			needsFromRequest({
				type: "extension_ui_request",
				id: "r1",
				method: "select",
				title: "Run npm test?",
				options: ["Yes", "No"],
			}),
		).toEqual({ requestId: "r1", method: "select", title: "Run npm test?", options: ["Yes", "No"] });
		expect(
			needsFromRequest({ type: "extension_ui_request", id: "r2", method: "notify", message: "hi" }),
		).toBeUndefined();
	});
});

describe("readSessionTail", () => {
	const write = (lines: unknown[]) => {
		const file = join(mkdtempSync(join(tmpdir(), "tail-")), "s.jsonl");
		writeFileSync(file, `${"x".repeat(20_000)}\n${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		return file;
	};

	it("picks up where a transcript left off, past a cut first line", () => {
		const file = write([
			{ type: "message", message: { role: "user", content: "write a haiku" } },
			{
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "Done.\nresult: wrote haiku.txt" }] },
			},
		]);
		expect(readSessionTail(file)).toEqual({
			detail: "result: wrote haiku.txt",
			outcome: "done",
			question: undefined,
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
