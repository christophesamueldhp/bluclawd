/**
 * Deny rules and the project-trust badge.
 *
 * pi asks nothing before a tool runs; this adds one thing on top: a tool call that
 * matches a `permissions.deny` rule (global or project settings) is blocked outright.
 * The footer shows pi's `defaultProjectTrust`; Alt+M cycles it, and the phone's status sheet sets it.
 *
 * Registered first so a denied call is blocked before any other extension sees it.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
	ToolCallEventResult,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { monitorSource } from "../_shared/monitor-source.ts";
import * as forkSettings from "../_shared/settings.ts";
import { STATUS_KEYS } from "../_shared/status-keys.ts";
import { type ProjectTrust, trustBadge } from "../_shared/trust-badge.ts";
import { deniedBy, displayRule, grepOutputWithoutDenied, searchQueries } from "./rules.ts";

export const TRUST_CYCLE: readonly ProjectTrust[] = ["always", "ask", "never"];
/** On pi's event bus whenever `defaultProjectTrust` is set here, so remote control reports it. */
export const TRUST_CHANGED = "bluclawd:trust-changed";

/** The footer badge for a `defaultProjectTrust` value. */
export function trustStatusText(ctx: ExtensionContext, trust: ProjectTrust): string {
	return `${trustBadge(ctx.ui.theme, trust)} ${ctx.ui.theme.fg("dim", "(alt+m to cycle)")}`;
}

function settings(ctx: ExtensionContext): SettingsManager {
	return SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
}

export function projectTrust(ctx: ExtensionContext): ProjectTrust {
	return settings(ctx).getDefaultProjectTrust();
}

function refreshBadge(ctx: ExtensionContext): void {
	try {
		ctx.ui.setStatus(STATUS_KEYS.mode, trustStatusText(ctx, projectTrust(ctx)));
	} catch {
		// Stale extension instance after a reload — nothing to draw on.
	}
}

/** Alt+M's, and the phone's: saved to global settings, the badge redrawn, and announced. */
export async function setProjectTrust(
	pi: Pick<ExtensionAPI, "events">,
	ctx: ExtensionContext,
	trust: ProjectTrust,
): Promise<void> {
	const sm = settings(ctx);
	sm.setDefaultProjectTrust(trust);
	await sm.flush();
	refreshBadge(ctx);
	ctx.ui.notify(`defaultProjectTrust: ${trust} — applies to projects opened from now on`, "info");
	pi.events.emit(TRUST_CHANGED, trust);
}

/**
 * The tool name and input deny rules are matched against: `monitor` and `powershell` run a
 * shell like bash, or `monitor` opens a WebSocket judged as a fetch; MCP resources count as
 * their server's tools.
 */
function governed(tool: string, input: Record<string, unknown>): { tool: string; input: Record<string, unknown> } {
	if (tool === "monitor") {
		const source = monitorSource(input);
		return source.kind === "ws" ? { tool: "webfetch", input: { url: source.url } } : { tool: "bash", input };
	}
	if (tool === "powershell") return { tool: "bash", input };
	if (tool === "mcp_read_resource" || tool === "mcp_list_resources") {
		const server = typeof input.server === "string" ? input.server : "";
		if (server) return { tool: `mcp__${server}__${tool.slice("mcp_".length)}`, input };
	}
	return { tool, input };
}

function factory(pi: ExtensionAPI): void {
	let deny: string[] = [];

	function loadDeny(ctx: ExtensionContext): void {
		const sm = settings(ctx);
		deny = forkSettings.denyRules(sm);
		for (const scope of forkSettings.invalidDenyScopes(sm)) {
			ctx.ui.notify(`${scope} permissions.deny is not a list of rules: none of it is in effect`, "warning");
		}
		// pi reads an unparseable settings file as empty, which would drop its deny rules silently.
		for (const { path, scope } of sm.drainErrors()) {
			ctx.ui.notify(`${path ?? `${scope} settings`} could not be read: its deny rules are not in effect`, "warning");
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

	// A folder grep reads every file in it, so a denied file's lines are dropped from what it found.
	pi.on("tool_result", async (event, ctx): Promise<ToolResultEventResult | undefined> => {
		if (event.toolName !== "grep" || event.isError) return undefined;
		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text") return part;
			const text = grepOutputWithoutDenied(deny, event.input, part.text, ctx.cwd);
			if (text === undefined) return part;
			changed = true;
			return { ...part, text };
		});
		return changed ? { content } : undefined;
	});

	pi.registerShortcut(Key.alt("m"), {
		description: "Cycle defaultProjectTrust (always / ask / never)",
		handler: async (ctx) => {
			const next = TRUST_CYCLE[(TRUST_CYCLE.indexOf(projectTrust(ctx)) + 1) % TRUST_CYCLE.length];
			await setProjectTrust(pi, ctx, next);
		},
	});
}

const permissionsExtension: InlineExtension = { name: "permissions", factory };
export default permissionsExtension.factory;
