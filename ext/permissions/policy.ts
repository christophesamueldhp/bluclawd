import type {
	ExtensionAPI,
	ExtensionFactory,
	ToolCallEventResult,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { monitorSource } from "../_shared/monitor-source.ts";
import { ALLOWED_SUBAGENT_TOOLS, type AllowedSubagentTool } from "../subagents/definitions.ts";
import { deniedBy, displayRule, grepOutputWithoutDenied, pathListOutputWithoutDenied, searchQueries } from "./rules.ts";

const CAPABILITY_CEILING = new Set<string>(ALLOWED_SUBAGENT_TOOLS);
const SNAPSHOT_BRAND = Symbol("bluclawd.subagent.policySnapshot");

export interface SubagentReadPolicySnapshot {
	readonly [SNAPSHOT_BRAND]: true;
	readonly cwd: string;
	readonly denyRules: readonly string[];
	readonly allowedTools: readonly AllowedSubagentTool[];
}

export interface CreateSubagentPolicySnapshotOptions {
	cwd: string;
	denyRules: readonly string[];
	allowedTools: readonly AllowedSubagentTool[];
}

export interface CreateSubagentPolicySnapshotResult {
	readonly ok: boolean;
	readonly snapshot?: SubagentReadPolicySnapshot;
	readonly error?: string;
}

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
	if (tool === "mcp_read_resource" || tool === "mcp_list_resources") {
		const server = typeof input.server === "string" ? input.server : "";
		if (server) return { tool: `mcp__${server}__${tool.slice("mcp_".length)}`, input };
	}
	return { tool, input };
}

export function evaluateToolCallDeny(
	denyRules: readonly string[],
	toolName: string,
	rawInput: Record<string, unknown>,
	cwd: string,
): ToolCallEventResult | undefined {
	const deny = [...denyRules];
	const { tool, input } = governedToolCall(toolName, rawInput);
	const rule =
		tool === "websearch" && Array.isArray(input.queries)
			? searchQueries(input)
					.map((query) => deniedBy(deny, tool, { query }, cwd))
					.find((r) => r !== undefined)
			: deniedBy(deny, tool, input, cwd);
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

export function createSubagentPolicySnapshot(
	options: CreateSubagentPolicySnapshotOptions,
): CreateSubagentPolicySnapshotResult {
	if (!options || typeof options !== "object") {
		return { ok: false, error: "Subagent policy options must be an object" };
	}
	if (typeof options.cwd !== "string" || options.cwd.trim().length === 0) {
		return { ok: false, error: "Subagent policy cwd must be a non-empty string" };
	}
	if (!Array.isArray(options.denyRules) || options.denyRules.some((r) => typeof r !== "string" || r.trim() === "")) {
		return { ok: false, error: "Subagent policy denyRules must be an array of non-empty strings" };
	}
	if (!Array.isArray(options.allowedTools) || options.allowedTools.length === 0) {
		return { ok: false, error: "Subagent policy allowedTools must be a non-empty array" };
	}
	const effectiveTools: AllowedSubagentTool[] = [];
	for (const tool of options.allowedTools) {
		if (typeof tool !== "string" || !CAPABILITY_CEILING.has(tool)) {
			return {
				ok: false,
				error: `Tool "${String(tool)}" exceeds the read-only subagent capability ceiling`,
			};
		}
		if (!effectiveTools.includes(tool as AllowedSubagentTool)) {
			effectiveTools.push(tool as AllowedSubagentTool);
		}
	}

	const snapshot: SubagentReadPolicySnapshot = Object.freeze({
		[SNAPSHOT_BRAND]: true as const,
		cwd: options.cwd,
		denyRules: Object.freeze([...options.denyRules]),
		allowedTools: Object.freeze(effectiveTools),
	});

	return { ok: true, snapshot };
}

export function isValidSubagentPolicySnapshot(value: unknown): value is SubagentReadPolicySnapshot {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Record<symbol | string, unknown>;
	return (
		candidate[SNAPSHOT_BRAND] === true &&
		typeof candidate.cwd === "string" &&
		candidate.cwd.length > 0 &&
		Array.isArray(candidate.denyRules) &&
		Array.isArray(candidate.allowedTools) &&
		candidate.allowedTools.length > 0 &&
		candidate.allowedTools.every((t) => typeof t === "string" && CAPABILITY_CEILING.has(t))
	);
}

export function filterChildToolResult(
	snapshot: SubagentReadPolicySnapshot,
	event: {
		toolName: string;
		input: Record<string, unknown>;
		content: Array<{ type: string; text?: string; [k: string]: unknown }>;
		structuredContent?: unknown;
		isError: boolean;
	},
): ToolResultEventResult | undefined {
	if (!isValidSubagentPolicySnapshot(snapshot)) {
		throw new Error("Invalid or uninitialized subagent policy snapshot");
	}
	if (event.isError) return undefined;
	if (event.toolName === "grep") {
		return filterDeniedGrepToolResult(snapshot.denyRules, event, snapshot.cwd);
	}
	if (event.toolName === "find" || event.toolName === "ls") {
		const tool = event.toolName;
		const deny = [...snapshot.denyRules];
		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text" || typeof part.text !== "string") return part;
			const filtered = pathListOutputWithoutDenied(deny, tool, event.input, part.text, snapshot.cwd);
			if (filtered === undefined) return part;
			changed = true;
			return { ...part, text: filtered };
		});
		if (!changed) return undefined;
		return {
			content: content as any,
			structuredContent: undefined,
		};
	}
	return undefined;
}

export function createChildPolicyExtension(snapshot: SubagentReadPolicySnapshot): ExtensionFactory {
	if (!isValidSubagentPolicySnapshot(snapshot)) {
		throw new Error("Refusing to initialize child subagent: policy snapshot is missing or malformed");
	}
	const allowedSet = new Set<string>(snapshot.allowedTools);

	return (pi: ExtensionAPI) => {
		pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
			if (!CAPABILITY_CEILING.has(event.toolName) || !allowedSet.has(event.toolName)) {
				return {
					block: true,
					reason: `Tool "${event.toolName}" is not permitted for this read-only subagent (allowed: ${snapshot.allowedTools.join(", ")})`,
				};
			}
			const effectiveCwd = ctx?.cwd || snapshot.cwd;
			return evaluateToolCallDeny(
				snapshot.denyRules,
				event.toolName,
				(event.input ?? {}) as Record<string, unknown>,
				effectiveCwd,
			);
		});

		pi.on("tool_result", async (event): Promise<ToolResultEventResult | undefined> => {
			return filterChildToolResult(snapshot, {
				toolName: event.toolName,
				input: (event.input ?? {}) as Record<string, unknown>,
				content: event.content as Array<{ type: string; text?: string; [k: string]: unknown }>,
				structuredContent: event.structuredContent,
				isError: event.isError,
			});
		});
	};
}
