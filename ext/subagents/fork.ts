/**
 * Claude Code's fork subagent (`subagent_type: "fork"`): a child that starts from the
 * parent's conversation and its rendered system prompt instead of an empty context.
 *
 * The engine branches the parent's session file at the leaf the `agent` call was made
 * from, into the child's own session dir. That leaf's assistant message still holds the
 * call that spawned the fork (and any sibling calls) with no results yet; Claude Code
 * pairs every such tool use with a `Fork started — processing in background` result, then
 * gives the fork its directive inside `<fork-boilerplate>`. The context hook here adds
 * those results on every LLM call, for inherited messages only.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_EXIT_MESSAGE_TYPE = "bluclawd:subagent-exit";

/** What a fork's inherited, still-unanswered tool calls get as their result. */
export const FORK_STARTED = "Fork started — processing in background";

/** Where a fork branches from: the parent's session file and its leaf at call time. */
export interface ForkSource {
	sessionFile: string;
	leafId: string;
	/** When the fork was taken; messages at or before it are inherited. */
	forkedAt: number;
}

type Block = { type: string; id?: string; name?: string };

/** The inherited history with every unanswered tool call answered, as Claude Code does it. */
export function inheritedContext(messages: AgentMessage[], forkedAt: number): AgentMessage[] {
	const inherited = (m: AgentMessage) =>
		(m as { timestamp?: number }).timestamp !== undefined && m.timestamp <= forkedAt;
	const answered = new Set<string>();
	for (const m of messages) if (m.role === "toolResult") answered.add(m.toolCallId);

	const out: AgentMessage[] = [];
	for (const m of messages) {
		out.push(m);
		if (!inherited(m) || m.role !== "assistant") continue;
		for (const block of m.content as Block[]) {
			if (block.type !== "toolCall" || !block.id || answered.has(block.id)) continue;
			out.push({
				role: "toolResult",
				toolCallId: block.id,
				toolName: block.name ?? "",
				content: [{ type: "text", text: FORK_STARTED }],
				isError: false,
				timestamp: m.timestamp,
			} as AgentMessage);
		}
	}
	return out;
}

/** Claude Code's `<fork-boilerplate>` directive: the fork's first user message. */
export function forkDirective(directive: string, worktree?: { parentCwd: string; path: string }): string {
	const lines = [
		"<fork-boilerplate>",
		"You are a worker fork. The transcript above is the parent's history — inherited reference, not your situation. You are NOT a continuation of that agent. Execute ONE directive, then stop.",
		"Hard rules:",
		'- Do NOT spawn subagents with the agent tool. The "default to forking" guidance is for the parent; you ARE the fork, execute directly.',
		"- One shot: report once and stop. No follow-up questions, no proposed next steps, no waiting for the user.",
		"Guidelines (your directive may override any of these):",
		"- Stay in scope. Other forks may be handling adjacent work; if you spot something outside your directive, note it in a sentence and move on.",
		"- Open with one line restating your task, so the parent can spot scope drift at a glance.",
		"- Be concise — as short as the answer allows, no shorter. Plain text, no preamble, no meta-commentary.",
		"- If you committed changes, list the paths and commit hashes in your report.",
		"</fork-boilerplate>",
	];
	if (worktree) {
		lines.push(
			`You've inherited the conversation context above from a parent agent working in ${worktree.parentCwd}. You are operating in an isolated git worktree at ${worktree.path} — same repository, same relative file structure, separate working copy. Paths in the inherited context refer to the parent's working directory; translate them to your worktree root. Re-read files before editing if the parent may have modified them since they appear in the context. Your changes stay in this worktree and will not affect the parent's files.`,
		);
	}
	lines.push(`Your directive: ${directive}`);
	return lines.join("\n");
}

export function createForkContextExtension(forkedAt: number): InlineExtension {
	return {
		name: "subagent-fork-context",
		factory(pi) {
			pi.on("context", async (event) => ({ messages: inheritedContext(event.messages, forkedAt) }));
		},
	};
}
