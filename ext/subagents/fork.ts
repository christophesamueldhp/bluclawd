/**
 * Forked context: a child that starts from the parent's conversation instead of
 * an empty one (Claude Code's fork subagent; pi-subagents' `context: "fork"`).
 *
 * The engine branches the parent's session file at the leaf the `task` call was
 * made from, into the child's own session dir. What the child's model then sees
 * of that inherited history is cleaned here, on every LLM call:
 *   - `task` tool calls and their results go: the child has no `task` tool, and a
 *     call to a tool it lacks invites it to try one;
 *   - a tool call with no result goes (the `task` call being made right now, and
 *     any sibling call still running beside it) — most providers reject a
 *     dangling call — as does a result whose call is gone;
 *   - background-subagent completion messages go: they are the parent's;
 *   - an assistant message that lost a call also loses its thinking blocks: a signed
 *     thinking block is only valid beside the exact turn it was signed with
 *     (pi-subagents strips these too, fork-context.ts).
 * Only messages from before the fork are touched; the child's own are left alone.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/** engine.ts's TASK_TOOL_NAME; not imported, as engine.ts imports this module. */
const TASK_TOOL_NAME = "task";

export const SUBAGENT_EXIT_MESSAGE_TYPE = "bluclawd:subagent-exit";

/** Where a forked child branches from: the parent's session file and its leaf at call time. */
export interface ForkSource {
	sessionFile: string;
	leafId: string;
	/** When the fork was taken; messages at or before it are inherited. */
	forkedAt: number;
}

type Block = { type: string; id?: string; name?: string };

export function inheritedContext(messages: AgentMessage[], forkedAt: number): AgentMessage[] {
	const inherited = (m: AgentMessage) =>
		(m as { timestamp?: number }).timestamp !== undefined && m.timestamp <= forkedAt;
	const callIds = new Set<string>();
	const resultIds = new Set<string>();
	for (const m of messages) {
		if (!inherited(m)) continue;
		if (m.role === "toolResult" && m.toolName !== TASK_TOOL_NAME) resultIds.add(m.toolCallId);
		if (m.role === "assistant")
			for (const b of m.content as Block[])
				if (b.type === "toolCall" && b.id && b.name !== TASK_TOOL_NAME) callIds.add(b.id);
	}

	const out: AgentMessage[] = [];
	for (const m of messages) {
		if (!inherited(m)) {
			out.push(m);
			continue;
		}
		if (m.role === "custom" && m.customType === SUBAGENT_EXIT_MESSAGE_TYPE) continue;
		if (m.role === "toolResult" && !callIds.has(m.toolCallId)) continue;
		if (m.role === "assistant") {
			let content = (m.content as Block[]).filter(
				(b) => b.type !== "toolCall" || (b.id !== undefined && callIds.has(b.id) && resultIds.has(b.id)),
			);
			if (content.length !== m.content.length) {
				content = content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
				if (content.length === 0) continue;
				out.push({ ...m, content } as AgentMessage);
				continue;
			}
		}
		out.push(m);
	}
	return out;
}

/**
 * A forked child's first prompt. In the user turn, not the system prompt: found live,
 * a child told only in its system prompt still answered the parent's last request
 * ("call the task tool") instead of its own task.
 */
export function forkedTaskPrompt(task: string): string {
	return [
		"You are a subagent forked from the conversation above. That conversation is your parent agent's, copied so you share its context: do not continue it, and do not carry out requests made in it — they were addressed to the parent, which is handling them.",
		"Do only the task below, then reply with your result for the parent.",
		"",
		`Task: ${task}`,
	].join("\n");
}

export function createForkContextExtension(forkedAt: number): InlineExtension {
	return {
		name: "subagent-fork-context",
		factory(pi) {
			pi.on("context", async (event) => ({ messages: inheritedContext(event.messages, forkedAt) }));
		},
	};
}
