// daemon/remote/transcript.ts
/**
 * A session's .jsonl as the phone's chat. The active branch is the `parentId` chain from the
 * file's last entry (pi appends to the branch it is on); each entry is reduced to what a phone
 * shows. Pure apart from `loadTranscript`'s one read.
 */
import { readFileSync } from "node:fs";
import { textOf } from "../session-state.ts";

export interface RemoteToolCall {
	id: string;
	name: string;
	/** The call's main argument: its command, path or pattern. */
	summary: string;
}

export type RemoteMessage =
	| { kind: "user"; id: string; text: string }
	| { kind: "assistant"; id: string; text: string; thinking?: string; tools: RemoteToolCall[]; error?: string }
	| {
			kind: "toolResult";
			id: string;
			toolCallId?: string;
			toolName: string;
			ok: boolean;
			text: string;
			truncated: boolean;
	  }
	| { kind: "marker"; id: string; text: string };

/** A tool result or a thinking block is cut to this many characters. */
export const TEXT_MAX = 2048;
const SUMMARY_MAX = 120;

interface Part {
	type?: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

interface Entry {
	type?: string;
	id?: string;
	parentId?: string | null;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		stopReason?: string;
		errorMessage?: string;
		command?: string;
	};
	provider?: string;
	modelId?: string;
	content?: unknown;
	display?: boolean;
}

export function parseEntries(text: string): Entry[] {
	const entries: Entry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as Entry;
			if (entry && typeof entry === "object") entries.push(entry);
		} catch {
			// the last line may still be being written
		}
	}
	return entries;
}

/** The entries from the root to the file's last entry, following `parentId`. */
export function activeBranch(entries: Entry[]): Entry[] {
	const byId = new Map<string, Entry>();
	for (const entry of entries) if (entry.id && entry.type !== "session") byId.set(entry.id, entry);
	let current = [...entries].reverse().find((entry) => entry.id && entry.type !== "session");
	const branch: Entry[] = [];
	const seen = new Set<string>();
	while (current?.id && !seen.has(current.id)) {
		seen.add(current.id);
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return branch.reverse();
}

function clip(text: string): { text: string; truncated: boolean } {
	return text.length > TEXT_MAX
		? { text: `${text.slice(0, TEXT_MAX)}…`, truncated: true }
		: { text, truncated: false };
}

function firstLine(text: string): string {
	const line = text.trim().split("\n")[0] ?? "";
	return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line;
}

function partsOf(content: unknown): Part[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Part[]) : [];
}

/** Text parts on their own lines, an image as `[Image]`. */
function plainText(content: unknown): string {
	return partsOf(content)
		.map((part) => (part.type === "text" ? (part.text ?? "") : part.type === "image" ? "[Image]" : ""))
		.filter(Boolean)
		.join("\n");
}

/** The argument a tool call is about, as Claude Code shows it: `Bash(npm test)`. */
export function toolSummary(args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const value = [a.command, a.path, a.pattern, a.url, a.query, a.description].find(
		(v) => typeof v === "string" && v.trim(),
	);
	return typeof value === "string" ? firstLine(value) : "";
}

function toRemote(entry: Entry): RemoteMessage | undefined {
	const id = entry.id ?? "";
	if (entry.type === "model_change") return { kind: "marker", id, text: `Model: ${entry.provider}/${entry.modelId}` };
	if (entry.type === "compaction") return { kind: "marker", id, text: "Conversation compacted" };
	if (entry.type === "custom_message" && entry.display) {
		const text = firstLine(plainText(entry.content));
		return text ? { kind: "marker", id, text } : undefined;
	}
	if (entry.type !== "message" || !entry.message) return undefined;
	const message = entry.message;
	switch (message.role) {
		case "user":
			return { kind: "user", id, text: plainText(message.content) };
		case "assistant": {
			const parts = partsOf(message.content);
			const text = textOf(message.content);
			const thinking = parts
				.filter((part) => part.type === "thinking" && part.thinking)
				.map((part) => part.thinking)
				.join("\n\n");
			const tools = parts
				.filter((part) => part.type === "toolCall")
				.map((part) => ({ id: part.id ?? "", name: part.name ?? "tool", summary: toolSummary(part.arguments) }));
			const error = message.stopReason === "error" ? message.errorMessage || "the model request failed" : undefined;
			if (!text && !thinking && tools.length === 0 && !error) return undefined;
			return {
				kind: "assistant",
				id,
				text,
				...(thinking ? { thinking: clip(thinking).text } : {}),
				tools,
				...(error ? { error } : {}),
			};
		}
		case "toolResult": {
			const { text, truncated } = clip(plainText(message.content));
			return {
				kind: "toolResult",
				id,
				toolCallId: message.toolCallId,
				toolName: message.toolName ?? "tool",
				ok: message.isError !== true,
				text,
				truncated,
			};
		}
		case "bashExecution":
			return typeof message.command === "string" ? { kind: "marker", id, text: `!${message.command}` } : undefined;
		default:
			return undefined;
	}
}

/** The last `limit` messages of the active branch. */
export function transcriptFrom(text: string, limit: number): RemoteMessage[] {
	const messages = activeBranch(parseEntries(text))
		.map(toRemote)
		.filter((message): message is RemoteMessage => message !== undefined);
	return limit > 0 ? messages.slice(-limit) : [];
}

/** A session that has not written its file yet has an empty transcript. */
export function loadTranscript(sessionFile: string | undefined, limit: number): RemoteMessage[] {
	if (!sessionFile) return [];
	let text: string;
	try {
		text = readFileSync(sessionFile, "utf8");
	} catch {
		return [];
	}
	return transcriptFrom(text, limit);
}
