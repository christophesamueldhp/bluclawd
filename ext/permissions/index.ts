/**
 * Deny rules and the project-trust badge.
 *
 * pi asks nothing before a tool runs; this adds one thing on top: a tool call that
 * matches a `permissions.deny` rule (global or project settings) is blocked outright.
 * The footer shows pi's `defaultProjectTrust`, and Alt+M cycles it.
 *
 * Registered first so a denied call is blocked before any other extension sees it.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { monitorSource } from "../_shared/monitor-source.ts";
import * as forkSettings from "../_shared/settings.ts";
import { STATUS_KEYS } from "../_shared/status-keys.ts";
import { deniedBy, displayRule, searchQueries } from "./rules.ts";

export type ProjectTrust = "always" | "ask" | "never";

export const TRUST_CYCLE: readonly ProjectTrust[] = ["always", "ask", "never"];

const AMBER = "\x1b[38;2;255;193;7m";

/** The footer badge for a `defaultProjectTrust` value. */
export function trustStatusText(ctx: ExtensionContext, trust: ProjectTrust): string {
	const theme = ctx.ui.theme;
	const badge =
		trust === "always"
			? theme.getColorMode() === "truecolor"
				? `${AMBER}⏵⏵ always\x1b[39m`
				: theme.fg("warning", "⏵⏵ always")
			: trust === "ask"
				? theme.fg("muted", "⏸ ask")
				: theme.fg("error", "✕ never");
	return `${badge} ${theme.fg("dim", "(alt+m to cycle)")}`;
}

/**
 * The tool name and input deny rules are matched against: `monitor` runs a shell like
 * bash, or opens a WebSocket judged as a fetch; MCP resources count as their server's tools.
 */
function governed(tool: string, input: Record<string, unknown>): { tool: string; input: Record<string, unknown> } {
	if (tool === "monitor") {
		const source = monitorSource(input);
		return source.kind === "ws" ? { tool: "webfetch", input: { url: source.url } } : { tool: "bash", input };
	}
	if (tool === "mcp_read_resource" || tool === "mcp_list_resources") {
		const server = typeof input.server === "string" ? input.server : "";
		if (server) return { tool: `mcp__${server}__${tool.slice("mcp_".length)}`, input };
	}
	return { tool, input };
}

export function factory(pi: ExtensionAPI): void {
	let deny: string[] = [];

	function settings(ctx: ExtensionContext): SettingsManager {
		return SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
	}

	function loadDeny(ctx: ExtensionContext): void {
		try {
			deny = forkSettings.denyRules(settings(ctx));
		} catch {
			deny = [];
		}
	}

	function refreshBadge(ctx: ExtensionContext): void {
		try {
			ctx.ui.setStatus(STATUS_KEYS.mode, trustStatusText(ctx, settings(ctx).getDefaultProjectTrust()));
		} catch {
			// Stale extension instance after a reload — nothing to draw on.
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		loadDeny(ctx);
		refreshBadge(ctx);
	});

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		const { tool, input } = governed(event.toolName, event.input as Record<string, unknown>);
		// A websearch batch is matched query by query, so `queries` cannot carry one past a rule.
		const rule =
			tool === "websearch" && Array.isArray(input.queries)
				? searchQueries(input)
						.map((query) => deniedBy(deny, tool, { query }, ctx.cwd))
						.find((r) => r !== undefined)
				: deniedBy(deny, tool, input, ctx.cwd);
		if (rule === undefined) return undefined;
		return { block: true, reason: `Blocked by permission rule (deny): ${displayRule(rule)}` };
	});

	pi.registerShortcut(Key.alt("m"), {
		description: "Cycle defaultProjectTrust (always / ask / never)",
		handler: async (ctx) => {
			const sm = settings(ctx);
			const next = TRUST_CYCLE[(TRUST_CYCLE.indexOf(sm.getDefaultProjectTrust()) + 1) % TRUST_CYCLE.length];
			sm.setDefaultProjectTrust(next);
			await sm.flush();
			refreshBadge(ctx);
			ctx.ui.notify(`defaultProjectTrust: ${next} — applies to projects opened from now on`, "info");
		},
	});
}

const permissionsExtension: InlineExtension = { name: "permissions", factory };
export default permissionsExtension.factory;
