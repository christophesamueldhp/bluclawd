import type { ToolCallEventResult, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { monitorSource } from "../_shared/monitor-source.ts";
import {
	deniedBy,
	deniesMcpToolOnSomeServer,
	displayRule,
	grepOutputWithoutDenied,
	mcpNamePart,
	searchQueries,
} from "./rules.ts";

export interface SubagentDelegationDenyResult {
	readonly blocked: boolean;
	readonly rule?: string;
	readonly reason?: string;
}

/**
 * Normalize tool names/inputs for permission deny matching (`monitor`, `powershell`, and MCP resources).
 */
export function governedToolCall(
	tool: string,
	input: Record<string, unknown>,
): { tool: string; input: Record<string, unknown> } {
	if (tool === "monitor") {
		const source = monitorSource(input);
		return source.kind === "ws" ? { tool: "webfetch", input: { url: source.url } } : { tool: "bash", input };
	}
	if (tool === "powershell") return { tool: "bash", input };
	const server = mcpResourceServer(tool, input);
	if (server) return { tool: `mcp__${mcpNamePart(server)}__${tool}`, input };
	return { tool, input };
}

/** pi's MCP resource tools; the list ones without a `server` list every server. */
const MCP_RESOURCE_TOOLS = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);

/** The server a resource call names, trimmed as pi reads it; "" when it names none. */
function mcpResourceServer(tool: string, input: Record<string, unknown>): string {
	if (!MCP_RESOURCE_TOOLS.has(tool)) return "";
	return typeof input.server === "string" ? input.server.trim() : "";
}

export function evaluateToolCallDeny(
	denyRules: readonly string[],
	toolName: string,
	rawInput: Record<string, unknown>,
	cwd: string,
): ToolCallEventResult | undefined {
	const deny = [...denyRules];
	// Listing every server would show a denied one's resources too; pi's truncation saves the
	// whole listing to a file, so it cannot be filtered after the call.
	if (toolName.startsWith("list_") && MCP_RESOURCE_TOOLS.has(toolName) && !mcpResourceServer(toolName, rawInput)) {
		const rule = deny.find((r) => deniesMcpToolOnSomeServer(r, toolName));
		if (rule !== undefined) {
			return {
				block: true,
				reason: `Blocked by permission rule (deny): ${displayRule(rule)}. Pass \`server\` to list one server's resources.`,
			};
		}
	}
	const { tool, input } = governedToolCall(toolName, rawInput);
	// A batch is judged item by item: each query of a websearch, each url of a webfetch.
	const urls = tool === "webfetch" && Array.isArray(input.urls) ? input.urls.filter((u) => typeof u === "string") : [];
	const calls =
		tool === "websearch" && Array.isArray(input.queries)
			? searchQueries(input).map((query) => ({ query }))
			: urls.length > 0
				? urls.map((url) => ({ url }))
				: [input];
	const rule = calls.map((call) => deniedBy(deny, tool, call, cwd)).find((r) => r !== undefined);
	if (rule === undefined) return undefined;
	return { block: true, reason: `Blocked by permission rule (deny): ${displayRule(rule)}` };
}

export function evaluateSubagentDelegationDeny(
	denyRules: readonly string[],
	agentName: string,
	cwd: string,
): SubagentDelegationDenyResult {
	const rule = deniedBy([...denyRules], "subagent", { agent: agentName }, cwd);
	if (rule === undefined) {
		return { blocked: false };
	}
	const display = displayRule(rule);
	return {
		blocked: true,
		rule: display,
		reason: `Blocked by permission rule (deny): ${display}`,
	};
}

export function filterDeniedGrepToolResult(
	denyRules: readonly string[],
	event: {
		toolName: string;
		input: Record<string, unknown>;
		content: Array<{ type: string; text?: string; [k: string]: unknown }>;
		structuredContent?: unknown;
		isError: boolean;
	},
	cwd: string,
): ToolResultEventResult | undefined {
	if (event.toolName !== "grep" || event.isError) return undefined;
	const deny = [...denyRules];
	let changed = false;
	const content = event.content.map((part) => {
		if (part.type !== "text" || typeof part.text !== "string") return part;
		const text = grepOutputWithoutDenied(deny, event.input, part.text, cwd);
		if (text === undefined) return part;
		changed = true;
		return { ...part, text };
	});
	if (!changed) return undefined;
	return event.structuredContent !== undefined
		? ({ content: content as any, structuredContent: undefined } as ToolResultEventResult)
		: ({ content: content as any } as ToolResultEventResult);
}
