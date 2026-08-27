/**
 * Rich transcript model for the live-attach view. Messages arrive over the rpc_stream socket
 * as the wire form of the `ai` `Message` types. Assistant prose is rendered through the generic
 * (NOT AgentSession-coupled) `Markdown` primitive from pi-tui; tool calls/results get a compact
 * `⏺ name  subject` / `└ result` treatment so a background session reads like a real one.
 */

import { Markdown, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

export interface WireMessage {
	role: string;
	content?: unknown;
	toolName?: string;
	isError?: boolean;
}

// Resolved lazily (not at module load) so it's read after the theme is initialized.
let markdownTheme: ReturnType<typeof getMarkdownTheme> | undefined;
function mdTheme(): ReturnType<typeof getMarkdownTheme> {
	markdownTheme ??= getMarkdownTheme();
	return markdownTheme;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((p): p is { type?: string; text?: unknown } => typeof p === "object" && p !== null)
			.filter((p) => p.type === "text" && typeof p.text === "string")
			.map((p) => p.text as string)
			.join("");
	}
	return "";
}

interface WireToolCall {
	name: string;
	args: Record<string, unknown> | undefined;
}

function toolCallsFromContent(content: unknown): WireToolCall[] {
	if (!Array.isArray(content)) return [];
	return content
		.filter((p): p is { type?: string; name?: unknown; arguments?: unknown } => typeof p === "object" && p !== null)
		.filter((p) => p.type === "toolCall")
		.map((p) => ({
			name: typeof p.name === "string" ? p.name : "tool",
			args:
				typeof p.arguments === "object" && p.arguments !== null
					? (p.arguments as Record<string, unknown>)
					: undefined,
		}));
}

/** A short human subject for a tool call, from the most common argument keys. */
function toolSubject(args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	for (const key of ["file_path", "path", "filePath", "command", "cmd", "pattern", "query", "url"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value.trim().split("\n")[0];
	}
	return "";
}

/** First non-empty line of a tool result, for the one-line `└` summary. */
function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		if (line.trim()) return line.trim();
	}
	return "";
}

/** Render one message to rich display lines for `width` (empty when there's nothing to show). */
export function renderMessageLines(message: WireMessage, width: number): string[] {
	const lines: string[] = [];
	if (message.role === "user") {
		const text = textFromContent(message.content).trim();
		if (!text) return lines;
		const wrapped = wrapTextWithAnsi(text, Math.max(1, width - 6));
		wrapped.forEach((line, i) => {
			lines.push(theme.fg("muted", i === 0 ? `user: ${line}` : `      ${line}`));
		});
	} else if (message.role === "assistant") {
		const text = textFromContent(message.content).trim();
		if (text) lines.push(...new Markdown(text, 0, 0, mdTheme()).render(width));
		for (const call of toolCallsFromContent(message.content)) {
			const subject = toolSubject(call.args);
			const head = `  ${theme.fg("accent", "⏺")} ${theme.bold(call.name)}`;
			lines.push(truncateToWidth(subject ? `${head}  ${theme.fg("muted", subject)}` : head, width));
		}
	} else if (message.role === "toolResult") {
		const summary = firstLine(textFromContent(message.content));
		if (!summary && !message.isError) return lines;
		const style = message.isError ? "error" : "dim";
		lines.push(truncateToWidth(`    ${theme.fg(style, "└")} ${theme.fg(style, summary || "error")}`, width));
	}
	return lines;
}

export class TranscriptModel {
	private messages: WireMessage[] = [];
	// Per-message render cache: markdown parsing is the cost, so re-renders during streaming stay
	// O(changed messages). The streaming message is a fresh object each update (natural miss);
	// stable messages hit. Keyed on identity → GC'd with the message.
	private readonly lineCache = new WeakMap<WireMessage, { width: number; lines: string[] }>();

	setAll(messages: WireMessage[]): void {
		this.messages = [...messages];
	}

	/** Apply a streamed AgentSessionEvent. message_* events carry the (growing) message. */
	apply(event: { type: string; message?: WireMessage }): void {
		if (!event.message) return;
		if (event.type === "message_start") {
			this.messages.push(event.message);
		} else if (event.type === "message_update" || event.type === "message_end") {
			// Updates/ends apply to the currently-streaming (last) message.
			if (this.messages.length > 0) this.messages[this.messages.length - 1] = event.message;
			else this.messages.push(event.message);
		}
	}

	private renderCached(message: WireMessage, width: number): string[] {
		const hit = this.lineCache.get(message);
		if (hit && hit.width === width) return hit.lines;
		const lines = renderMessageLines(message, width);
		this.lineCache.set(message, { width, lines });
		return lines;
	}

	/** All messages rendered to display lines for `width`, blank line between message groups. */
	toLines(width: number): string[] {
		const out: string[] = [];
		for (const message of this.messages) {
			const lines = this.renderCached(message, width);
			if (!lines.length) continue;
			if (out.length) out.push(""); // group separator
			out.push(...lines);
		}
		return out;
	}

	get length(): number {
		return this.messages.length;
	}
}
