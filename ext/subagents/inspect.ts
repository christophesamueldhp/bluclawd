/**
 * `/agents show <id>`: a child's transcript, for the user to see what a subagent
 * actually did — its text, the tools it called and what came back — rather than
 * only the summary the parent received.
 */

import { readFileSync } from "node:fs";

export interface TranscriptLine {
	kind: "user" | "assistant" | "tool" | "result" | "error";
	text: string;
}

interface MessageLike {
	role?: string;
	content?: unknown;
	toolName?: string;
	isError?: boolean;
	errorMessage?: string;
	timestamp?: number;
}

/**
 * The messages of a child's transcript file, in file order. A forked child's file
 * begins with the parent's conversation; only what came after `forkedAt` is its own.
 */
export function readTranscript(file: string, forkedAt?: number): MessageLike[] {
	const messages: MessageLike[] = [];
	for (const line of readFileSync(file, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as { type?: string; timestamp?: string; message?: MessageLike };
			if (entry.type !== "message" || !entry.message) continue;
			// The message's own time, as the fork filter (fork.ts) reads it; the entry's as a fallback.
			const at = entry.message.timestamp ?? Date.parse(entry.timestamp ?? "");
			if (forkedAt !== undefined && at <= forkedAt) continue;
			messages.push(entry.message);
		} catch {
			// A torn last line (the child is still writing) is skipped.
		}
	}
	return messages;
}

const oneLine = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

const textOf = (content: unknown): string =>
	Array.isArray(content)
		? content
				.map((c) =>
					c && typeof c === "object" && (c as { type?: string }).type === "text"
						? (c as { text: string }).text
						: "",
				)
				.join("\n")
		: typeof content === "string"
			? content
			: "";

/** The shape a tool call's arguments are shown in: the first string argument, else the keys. */
function argsSummary(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const values = Object.values(args as Record<string, unknown>);
	const first = values.find((v) => typeof v === "string") as string | undefined;
	return first !== undefined ? first : Object.keys(args as object).join(", ");
}

/** The last `max` lines of a transcript, one per text block, tool call and tool result. */
export function transcriptLines(messages: readonly MessageLike[], max = 60, width = 160): TranscriptLine[] {
	const lines: TranscriptLine[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = textOf(message.content);
			if (text.trim()) lines.push({ kind: "user", text: oneLine(text, width) });
		} else if (message.role === "assistant") {
			for (const part of Array.isArray(message.content) ? message.content : []) {
				const p = part as { type?: string; text?: string; name?: string; arguments?: unknown };
				if (p.type === "text" && p.text?.trim()) lines.push({ kind: "assistant", text: oneLine(p.text, width) });
				if (p.type === "toolCall")
					lines.push({ kind: "tool", text: oneLine(`${p.name}(${argsSummary(p.arguments)})`, width) });
			}
			if (message.errorMessage) lines.push({ kind: "error", text: oneLine(message.errorMessage, width) });
		} else if (message.role === "toolResult") {
			const text =
				textOf(message.content)
					.split("\n")
					.find((l) => l.trim()) ?? "(no output)";
			lines.push({ kind: message.isError ? "error" : "result", text: oneLine(text, width) });
		}
	}
	return lines.slice(-max);
}
