import { describe, expect, it } from "vitest";
import { createForkContextExtension, FORK_STARTED, forkDirective, inheritedContext } from "../ext/subagents/fork.ts";

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
const started = (toolCallId: string, toolName: string, timestamp: number) => ({
	role: "toolResult",
	toolCallId,
	toolName,
	content: [{ type: "text", text: FORK_STARTED }],
	isError: false,
	timestamp,
});

const run = (messages: unknown[], forkedAt: number) => inheritedContext(messages as never, forkedAt) as any[];

describe("inheritedContext", () => {
	it("keeps ordinary inherited turns, tool calls with results included, as they are", () => {
		const messages = [user("hi", 1), assistant([call("r1", "read")], 2), result("r1", "read", 3)];
		expect(run(messages, 10)).toEqual(messages);
	});

	it("answers the agent call being made, and any sibling call without a result, right after its message", () => {
		const turn = assistant([{ type: "text", text: "delegating" }, call("t1", "agent"), call("b1", "bash")], 2);
		expect(run([user("go", 1), turn], 10)).toEqual([
			user("go", 1),
			turn,
			started("t1", "agent", 2),
			started("b1", "bash", 2),
		]);
	});

	it("removes nothing: thinking, earlier agent calls and their results all stay", () => {
		const thinking = { type: "thinking", thinking: "hmm", thinkingSignature: "sig" };
		const messages = [
			user("go", 1),
			assistant([thinking, call("t1", "agent")], 2),
			result("t1", "agent", 3),
			assistant([thinking, call("r1", "read")], 4),
			result("r1", "read", 5),
		];
		expect(run(messages, 10)).toEqual(messages);
	});

	it("leaves the fork's own messages after the fork point untouched, answered or not", () => {
		const own = [user("directive", 20), assistant([call("t9", "bash")], 21)];
		expect(run([user("go", 1), ...own], 10)).toEqual([user("go", 1), ...own]);
	});

	it("is registered as the child's context hook", async () => {
		const handlers: Record<string, (event: any) => Promise<any>> = {};
		const ext = createForkContextExtension(10) as unknown as { factory: (pi: unknown) => void };
		ext.factory({
			on: (name: string, h: any) => {
				handlers[name] = h;
			},
		});
		const out = await handlers.context({ messages: [user("go", 1), assistant([call("t1", "agent")], 2)] });
		expect(out.messages.at(-1)).toEqual(started("t1", "agent", 2));
	});
});

describe("forkDirective", () => {
	it("frames the directive in Claude Code's fork boilerplate", () => {
		const text = forkDirective("find the bug");
		expect(text.startsWith("<fork-boilerplate>\nYou are a worker fork.")).toBe(true);
		expect(text).toContain("Do NOT spawn subagents with the agent tool.");
		expect(text).toContain("</fork-boilerplate>\nYour directive: find the bug");
		expect(text).not.toContain("isolated git worktree");
	});

	it("tells a fork in a worktree to translate the parent's paths", () => {
		const text = forkDirective("fix it", { parentCwd: "/repo", path: "/repo/.pi/worktrees/agent-a1" });
		expect(text).toContain(
			"You've inherited the conversation context above from a parent agent working in /repo. You are operating in an isolated git worktree at /repo/.pi/worktrees/agent-a1",
		);
		expect(text.endsWith("Your directive: fix it")).toBe(true);
	});
});
