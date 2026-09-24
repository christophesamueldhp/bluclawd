/**
 * Keys for `ctx.ui.setStatus`. pi's footer, and pistatusline under its status line,
 * order the statuses by key, so these keys spell Claude Code's order: the permission
 * mode first, background tasks beside it, the agent view hint last. Subagent rows sort
 * just before that hint, which is where pi's one-line footer puts them.
 */
export const STATUS_KEYS = {
	mode: "1-mode",
	tasks: "2-tasks",
	mcp: "3-mcp",
	plugin: "3-plugin",
	sandbox: "3-sandbox",
	shell: "3-shell",
	stash: "3-stash",
	subagents: "8-subagents",
	agents: "9-agents",
} as const;
