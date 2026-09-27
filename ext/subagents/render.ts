/**
 * Result model + TUI rendering for the `agent` tool, in Claude Code's shape: the call
 * reads `Type(description)` coloured by the agent's `color`, a running child shows its
 * last few tool calls, and a finished one `Done (N tool uses · X tokens · Ys)`.
 */

import { homedir } from "node:os";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { keyDisplayText } from "../_shared/key-display-text.ts";
import type { AgentColor, AgentSource } from "./defs.ts";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export type SubagentStatus = "running" | "ok" | "failed";

export interface SingleResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	/** "running" until the child completes, then "ok" or "failed". */
	status: SubagentStatus;
	messages: AgentMessage[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** What `send_message` continues it by. */
	agentId?: string;
	startedAt?: number;
	durationMs?: number;
	toolUses?: number;
	/** Stopped at its turn cap; the output is what it had by then. */
	partial?: boolean;
	turnCap?: number;
	/** A worktree the child changed, kept for the user to inspect or merge. */
	worktreePath?: string;
	worktreeBranch?: string;
}

export interface AgentDetails {
	/** The agent type shown in the header. */
	agentType: string;
	description: string;
	/** A background launch: the result arrives later as a notification. */
	launched?: boolean;
	result?: SingleResult;
}

export interface AgentCallArgs {
	description?: string;
	prompt?: string;
	subagent_type?: string;
}

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Claude Code's token count: `950`, `12.3k`, `1.2M`. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** `8s`, `1m 5s`. */
export function formatDuration(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Tokens a child used: Claude Code counts the last request's input, output and cache. */
export function totalTokens(result: SingleResult): number {
	for (let i = result.messages.length - 1; i >= 0; i--) {
		const m = result.messages[i];
		if (m.role === "assistant" && m.usage)
			return m.usage.input + m.usage.output + m.usage.cacheRead + m.usage.cacheWrite;
	}
	return result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite;
}

/** `Done (3 tool uses · 12.3k tokens · 8s)`. */
export function doneLine(result: SingleResult): string {
	const uses = result.toolUses ?? 0;
	return `Done (${uses} tool ${uses === 1 ? "use" : "uses"} · ${formatTokens(totalTokens(result))} tokens · ${formatDuration(result.durationMs ?? 0)})`;
}

/** Agent colours, registered as definitions are listed (Claude Code's `qqe`). */
const agentColors = new Map<string, AgentColor>();
export function registerAgentColor(type: string, color: AgentColor | undefined): void {
	if (color) agentColors.set(type, color);
	else agentColors.delete(type);
}

const ANSI: Record<AgentColor, string> = {
	red: "31",
	green: "32",
	yellow: "33",
	blue: "34",
	purple: "35",
	cyan: "36",
	orange: "38;5;208",
	pink: "38;5;205",
};

function colored(type: string, text: string): string | undefined {
	const color = agentColors.get(type);
	return color ? `\x1b[${ANSI[color]}m${text}\x1b[39m` : undefined;
}

/** Claude Code's header name: `Agent` for the default general-purpose agent, else the type. */
export function headerName(type: string | undefined): string {
	return !type || type === "general-purpose" ? "Agent" : type;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	const path = String(args.file_path || args.path || ".");
	switch (toolName) {
		case "bash": {
			const command = String(args.command || "...");
			return (
				themeFg("muted", "$ ") + themeFg("toolOutput", command.length > 60 ? `${command.slice(0, 60)}...` : command)
			);
		}
		case "read":
		case "write":
		case "edit":
		case "ls":
			return themeFg("muted", `${toolName} `) + themeFg("accent", shortenPath(path));
		case "find":
		case "grep":
			return (
				themeFg("muted", `${toolName} `) +
				themeFg("accent", String(args.pattern || "")) +
				themeFg("dim", ` in ${shortenPath(path)}`)
			);
		default: {
			const argsStr = JSON.stringify(args);
			return (
				themeFg("accent", toolName) +
				themeFg("dim", ` ${argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr}`)
			);
		}
	}
}

export function getFinalOutput(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		const text = msg.content
			.filter((part) => part.type === "text")
			.map((part) => (part as { text: string }).text)
			.join("\n")
			.trim();
		if (text) return text;
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return result.status === "failed" || result.stopReason === "error" || result.stopReason === "aborted";
}

type ToolCallItem = { name: string; args: Record<string, unknown> };

function toolCalls(messages: AgentMessage[]): ToolCallItem[] {
	const items: ToolCallItem[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content)
			if (part.type === "toolCall") items.push({ name: part.name, args: part.arguments as Record<string, unknown> });
	}
	return items;
}

/** Tool calls a running child shows before the rest collapse into `+N more tool uses`. */
const RUNNING_CALLS_SHOWN = 3;

export function renderCall(args: AgentCallArgs, theme: Theme, _context: unknown) {
	const type = headerName(args.subagent_type);
	const name = colored(args.subagent_type ?? "", theme.bold(type)) ?? theme.fg("toolTitle", theme.bold(type));
	const description = (args.description ?? "").replace(/\s+/g, " ").trim();
	return new Text(`${name}${description ? theme.fg("muted", `(${description})`) : ""}`, 0, 0);
}

export function renderResult(
	result: AgentToolResult<AgentDetails>,
	{ expanded, isPartial }: { expanded: boolean; isPartial?: boolean },
	theme: Theme,
	_context: unknown,
) {
	const details = result.details;
	const expandHint = keyDisplayText("app.tools.expand");
	if (details?.launched) {
		return new Text(theme.fg("dim", `  ⎿  Backgrounded agent (/tasks to manage · ${expandHint} to expand)`), 0, 0);
	}
	const r = details?.result;
	if (!r) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "", 0, 0);
	}
	const calls = toolCalls(r.messages);
	const prefix = theme.fg("dim", "  ⎿  ");

	if (isPartial || r.status === "running") {
		if (calls.length === 0) return new Text(`${prefix}${theme.fg("dim", "Initializing…")}`, 0, 0);
		const shown = expanded ? calls : calls.slice(-RUNNING_CALLS_SHOWN);
		const lines = shown.map((c) => `${prefix}${formatToolCall(c.name, c.args, theme.fg.bind(theme))}`);
		if (!expanded && calls.length > shown.length)
			lines.push(theme.fg("dim", `     +${calls.length - shown.length} more tool uses (${expandHint} to expand)`));
		return new Text(lines.join("\n"), 0, 0);
	}

	if (isFailedResult(r)) {
		return new Text(`${prefix}${theme.fg("error", r.errorMessage || r.stderr || "Agent failed")}`, 0, 0);
	}

	const footer: string[] = [];
	if (r.partial) footer.push(theme.fg("warning", `Stopped at its ${r.turnCap ?? "turn"}-turn limit (partial result)`));
	if (r.worktreePath) footer.push(theme.fg("dim", `Kept worktree ${r.worktreePath}`));
	footer.push(theme.fg("dim", doneLine(r)));

	if (!expanded) {
		return new Text(footer.map((line) => `${prefix}${line}`).join("\n"), 0, 0);
	}
	const container = new Container();
	container.addChild(new Text(theme.fg("muted", "Prompt:"), 0, 0));
	container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
	container.addChild(new Spacer(1));
	for (const c of calls)
		container.addChild(new Text(`${prefix}${formatToolCall(c.name, c.args, theme.fg.bind(theme))}`, 0, 0));
	const output = getFinalOutput(r.messages);
	if (output) {
		container.addChild(new Spacer(1));
		container.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
	}
	container.addChild(new Spacer(1));
	for (const line of footer) container.addChild(new Text(line, 0, 0));
	return container;
}

/** A subagent running right now, as the footer lists it. */
export interface LiveChild {
	agent: string;
	startedAt: number;
	/** The child's latest progress; absent until its first message ends. */
	snap?: SingleResult;
}

/** Footer rows shown before the rest collapse into `+N more`. */
export const LIVE_ROWS_SHOWN = 3;
/** Room for a row's activity, so its elapsed time and tool count stay on screen. */
const ACTIVITY_WIDTH = 60;

/**
 * The footer block under the permission mode: one row per running subagent with what it
 * is doing now (Claude Code's subagent panel). Always ends in a line break, which marks a
 * status as a block of its own rather than a chip on the mode row.
 */
export function renderLiveRows(children: readonly LiveChild[], now: number, theme: Theme): string | undefined {
	if (children.length === 0) return undefined;
	const shown = children.slice(0, LIVE_ROWS_SHOWN);
	const nameWidth = Math.max(...shown.map((c) => (c.snap?.agent ?? c.agent).length));
	const rows = shown.map((child) => {
		const calls = toolCalls(child.snap?.messages ?? []);
		const last = calls[calls.length - 1];
		const activity = truncateToWidth(
			last ? formatToolCall(last.name, last.args, theme.fg.bind(theme)) : theme.fg("dim", "Initializing…"),
			ACTIVITY_WIDTH,
		);
		const stats = `${formatDuration(now - child.startedAt)} · ${calls.length} tool ${calls.length === 1 ? "use" : "uses"}`;
		const name = (child.snap?.agent ?? child.agent).padEnd(nameWidth);
		return `  ${theme.fg("dim", "⎿")} ${theme.fg("accent", name)}  ${activity}${theme.fg("dim", ` · ${stats}`)}`;
	});
	if (children.length > shown.length)
		rows.push(theme.fg("dim", `    +${children.length - shown.length} more (/tasks)`));
	return `${rows.join("\n")}\n`;
}
