import { describe, expect, it } from "vitest";
import { inheritedContext, SUBAGENT_EXIT_MESSAGE_TYPE } from "../ext/subagents/fork.ts";

const user = (text: string, timestamp: number) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (content: unknown[], timestamp: number) => ({ role: "assistant", content, timestamp });
const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });
const result = (toolCallId: string, toolName: string, timestamp: number) => ({
	role: "toolResult",
	toolCallId,
	toolName,
	content: [{ type: "text", text: "r" }],
	timestamp,
});

const run = (messages: unknown[], forkedAt: number) => inheritedContext(messages as never, forkedAt) as any[];

describe("inheritedContext", () => {
	it("keeps ordinary inherited turns, tool calls with results included", () => {
		const messages = [user("hi", 1), assistant([call("r1", "read")], 2), result("r1", "read", 3)];
		expect(run(messages, 10)).toEqual(messages);
	});

	it("drops the task call being made and any sibling call without a result, keeping the text beside them", () => {
		const out = run(
			[user("go", 1), assistant([{ type: "text", text: "delegating" }, call("t1", "task"), call("b1", "bash")], 2)],
			10,
		);
		expect(out).toHaveLength(2);
		expect(out[1].content).toEqual([{ type: "text", text: "delegating" }]);
	});

	it("drops the thinking of a turn that lost a call, and keeps it on untouched turns", () => {
		const thinking = { type: "thinking", thinking: "hmm", thinkingSignature: "sig" };
		const out = run(
			[
				user("go", 1),
				assistant([thinking, call("r1", "read")], 2),
				result("r1", "read", 3),
				assistant([thinking, call("t1", "task")], 4),
			],
			10,
		);
		expect(out).toHaveLength(3);
		expect(out[1].content[0]).toEqual(thinking);
	});

	it("drops earlier task calls with their results, and an assistant message left empty", () => {
		const out = run(
			[user("go", 1), assistant([call("t1", "task")], 2), result("t1", "task", 3), user("next", 4)],
			10,
		);
		expect(out.map((m) => m.role)).toEqual(["user", "user"]);
	});

	it("drops background-subagent completion messages", () => {
		const exit = {
			role: "custom",
			customType: SUBAGENT_EXIT_MESSAGE_TYPE,
			content: "x",
			display: true,
			timestamp: 2,
		};
		expect(run([user("go", 1), exit], 10)).toHaveLength(1);
	});

	it("leaves the child's own messages after the fork untouched", () => {
		const own = [user("Task: x", 20), assistant([call("t9", "task")], 21)];
		expect(run([user("go", 1), ...own], 10)).toEqual([user("go", 1), ...own]);
	});
});
