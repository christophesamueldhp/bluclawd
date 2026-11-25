/**
 * Keys for `ctx.ui.setStatus`. pi's footer, and pistatusline under its status line,
 * order the statuses by key, so these keys spell the display order.
 */
export const STATUS_KEYS = {
	mode: "1-mode",
	tasks: "2-tasks",
	subagents: "8-subagents",
	agents: "9-agents",
} as const;
