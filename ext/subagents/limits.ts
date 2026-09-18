/**
 * Per-child limits beyond turns and wall time (pi-subagents' toolBudget and
 * toolTimeoutMs, plus a token cap):
 *
 *   - toolBudget {soft, hard, block}: at `soft` tool calls the child is told to wrap
 *     up; past `hard`, calls to the `block` tools are refused. The default block list
 *     is the read/search tools, not edits: refusing an edit halfway through a change
 *     would leave it half-made, while refusing more reading only forces a conclusion.
 *   - toolTimeoutMs: one tool call running longer stops the child, its output partial.
 *     Time a permission question spends in front of the user does not count.
 *   - maxTokens: input + output + cache tokens across the child's run.
 *
 * All opt-in, from a def's frontmatter or `subagents.*` settings — never task-tool
 * parameters, which models fill with defaults.
 */

import type { ExtensionAPI, InlineExtension, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { GatePrompt } from "../permissions/subagent-gate.ts";
import { STRUCTURED_OUTPUT_TOOL } from "./structured-output.ts";

export interface ToolBudget {
	soft?: number;
	hard: number;
	block: string[] | "*";
}

export const DEFAULT_BUDGET_BLOCK = ["read", "grep", "find", "ls"];

/**
 * Tools that wait on a person or on other children by design, and the call that ends
 * a structured child's run: never counted or timed.
 */
export const UNLIMITED_TOOLS = new Set(["contact_supervisor", "task", STRUCTURED_OUTPUT_TOOL]);

const positiveInt = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

/** A `toolBudget` value from frontmatter or settings; anything malformed is no budget. */
export function parseToolBudget(raw: unknown): ToolBudget | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const { soft, hard, block } = raw as Record<string, unknown>;
	const h = positiveInt(hard);
	if (!h) return undefined;
	const s = positiveInt(soft);
	const list =
		block === "*"
			? "*"
			: Array.isArray(block)
				? block
						.filter((t): t is string => typeof t === "string" && t.trim() !== "")
						.map((t) => t.trim().toLowerCase())
				: [];
	return {
		...(s !== undefined && s <= h ? { soft: s } : {}),
		hard: h,
		block: list === "*" || list.length > 0 ? list : DEFAULT_BUDGET_BLOCK,
	};
}

/** Counts the child's tool calls: a nudge once at `soft`, refusals past `hard`. */
export function createToolBudgetExtension(budget: ToolBudget): InlineExtension {
	function factory(pi: ExtensionAPI): void {
		let count = 0;
		let nudged = false;
		pi.on("tool_call", async (event): Promise<ToolCallEventResult | undefined> => {
			if (UNLIMITED_TOOLS.has(event.toolName)) return undefined;
			count++;
			if (count > budget.hard && (budget.block === "*" || budget.block.includes(event.toolName))) {
				return {
					block: true,
					reason: `Tool budget spent: ${budget.hard} tool calls. \`${event.toolName}\` is no longer available; finish from what you already have.`,
				};
			}
			return undefined;
		});
		pi.on("tool_result", async (event) => {
			if (nudged || budget.soft === undefined || count < budget.soft) return undefined;
			nudged = true;
			const note = `[Tool budget: ${count} of ${budget.hard} calls used. Stop starting new searches and finish from the context you have.]`;
			return { content: [...event.content, { type: "text" as const, text: note }] };
		});
	}
	return { name: "subagent-tool-budget", factory };
}

/** A prompt bridge that keeps count of the questions open right now. */
export function countingPrompt(prompt: GatePrompt | undefined, open: { count: number }): GatePrompt | undefined {
	if (!prompt) return undefined;
	return async (request) => {
		open.count++;
		try {
			return await prompt(request);
		} finally {
			open.count--;
		}
	};
}

/**
 * Times each tool call. On the deadline, a call whose child has a question open
 * gets a fresh period instead: a permission prompt the user is still reading is
 * not a hung tool.
 */
export function createToolTimer(options: { ms: number; paused: () => boolean; onTimeout: (tool: string) => void }) {
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const arm = (id: string, tool: string): void => {
		timers.set(
			id,
			setTimeout(() => {
				if (options.paused()) return arm(id, tool);
				timers.delete(id);
				options.onTimeout(tool);
			}, options.ms),
		);
	};
	return {
		start(id: string, tool: string): void {
			if (!UNLIMITED_TOOLS.has(tool)) arm(id, tool);
		},
		end(id: string): void {
			clearTimeout(timers.get(id));
			timers.delete(id);
		},
		clear(): void {
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
		},
	};
}
