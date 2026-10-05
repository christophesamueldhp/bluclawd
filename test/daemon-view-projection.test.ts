import { describe, expect, it } from "vitest";
import { createViewProjection, reduceViewProjection } from "../daemon/view-projection.ts";
import type { ViewInput } from "../daemon/view-types.ts";
import { assistant, textDelta } from "./support/view-fixtures.ts";

function run(events: ViewInput[]) {
	return events.reduce((s, e, i) => reduceViewProjection(s, e, String(i)), createViewProjection());
}
describe("persistent view projection", () => {
	it("shows partially streamed tool arguments", () => {
		const s = run([
			{ type: "message_start", message: assistant("") },
			{
				type: "message_update",
				usage: assistant("").usage,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call", toolName: "bash" },
			},
			{
				type: "message_update",
				usage: assistant("").usage,
				assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"command":"pw' },
			},
		]);
		expect(s.partial?.content[1]).toMatchObject({ arguments: { command: "pw" } });
	});
	it("appends a compaction summary without discarding earlier messages", () => {
		const s = run([
			{ type: "message_end", message: assistant("before") },
			{ type: "compaction_start", reason: "manual" },
			{
				type: "compaction_end",
				reason: "manual",
				aborted: false,
				willRetry: false,
				result: { summary: "short summary", firstKeptEntryId: "a", tokensBefore: 42 },
			},
		]);
		expect(s.messages).toHaveLength(2);
		expect(s.messages[1].message).toMatchObject({ role: "compactionSummary", summary: "short summary" });
		expect(s.compacting).toBe(false);
	});
	it("reconstructs text thinking and toolcall deltas", () => {
		const events = [
			{ type: "message_start", message: assistant("") },
			textDelta("hello"),
			{
				type: "message_update",
				usage: assistant("").usage,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "reason" },
			},
			{
				type: "message_update",
				usage: assistant("").usage,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "call", toolName: "bash" },
			},
			{
				type: "message_update",
				usage: assistant("").usage,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 2,
					toolCall: { type: "toolCall", id: "call", name: "bash", arguments: { command: "pwd" } },
				},
			},
		] as ViewInput[];
		expect(run(events).partial?.content).toEqual([
			{ type: "text", text: "hello" },
			{ type: "thinking", thinking: "reason" },
			{ type: "toolCall", id: "call", name: "bash", arguments: { command: "pwd" } },
		]);
	});
	it("message_end replaces partial", () => {
		const s = run([
			{ type: "message_start", message: assistant("") },
			textDelta("partial"),
			{ type: "message_end", message: assistant("authoritative") },
		]);
		expect(s.partial).toBeUndefined();
		expect(s.messages).toHaveLength(1);
		expect(s.messages[0].message).toMatchObject({ content: [{ type: "text", text: "authoritative" }] });
	});
	it("does not mutate snapshots", () => {
		const s = run([{ type: "message_start", message: assistant("") }]);
		const next = reduceViewProjection(s, textDelta("hi"), "next");
		expect(s.partial?.content).toEqual([{ type: "text", text: "" }]);
		expect(next.partial?.content).toEqual([{ type: "text", text: "hi" }]);
	});
	it("keeps 200 finalized messages and complete partial", () => {
		let s = createViewProjection();
		for (let i = 0; i < 201; i++)
			s = reduceViewProjection(s, { type: "message_end", message: assistant(String(i), i) }, String(i));
		s = reduceViewProjection(s, { type: "message_start", message: assistant("long".repeat(1000)) }, "p");
		expect(s.messages).toHaveLength(200);
		expect(s.partial?.content).toEqual([{ type: "text", text: "long".repeat(1000) }]);
	});
	it("nested tools have distinct ids", () => {
		const s = run([
			{ type: "tool_execution_start", toolCallId: "call", toolName: "codemode", args: {} },
			{ type: "tool_execution_start", toolCallId: "call/1", toolName: "bash", args: {} },
		]);
		expect(Object.keys(s.tools)).toEqual(["call", "call/1"]);
		expect(
			reduceViewProjection(
				s,
				{
					type: "tool_execution_end",
					toolCallId: "call/1",
					toolName: "bash",
					result: { content: [], details: undefined },
					isError: false,
				},
				"e",
			).tools.call,
		).toBeDefined();
	});
	it("agent_end does not settle retries", () => {
		expect(run([{ type: "agent_start" }, { type: "agent_end", messages: [], willRetry: true }]).activity).toBe(
			"working",
		);
		expect(run([{ type: "agent_start" }, { type: "agent_settled" }]).activity).toBe("idle");
	});
	it("dialog detach does not cancel", () => {
		const s = run([
			{ type: "extension_ui_request", id: "q", method: "confirm", title: "continue?", message: "yes?" },
		]);
		expect(s.pendingDialog?.id).toBe("q");
		expect(s.activity).toBe("awaiting_input");
		expect(reduceViewProjection(s, { type: "view_ui_resolved", requestId: "q" }, "r").pendingDialog).toBeUndefined();
	});
	it("retains queues and compaction while a dialog waits", () => {
		const s = run([
			{ type: "agent_start" },
			{ type: "compaction_start", reason: "manual" },
			{ type: "extension_ui_request", method: "setStatus", id: "status", statusKey: "x", statusText: "hello" },
		] as ViewInput[]);
		expect(s.compacting).toBe(true);
		expect(s.statuses.x).toBe("hello");
	});
});
