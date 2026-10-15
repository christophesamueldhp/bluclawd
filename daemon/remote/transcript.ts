/**
 * A session's .jsonl as the phone's chat. The active branch is the `parentId` chain from the
 * pane's leaf when it reports one (after a /tree), else from the file's last entry (pi appends to
 * the branch it is on); each entry is reduced to what a phone
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

/** An image in a message, which the phone fetches by its message's id and this position. */
export interface RemoteImage {
	index: number;
	mimeType: string;
}

export type RemoteMessage =
	| { kind: "user"; id: string; text: string; images?: RemoteImage[] }
	| { kind: "assistant"; id: string; text: string; thinking?: string; tools: RemoteToolCall[]; error?: string }
	| {
			kind: "toolResult";
			id: string;
			toolCallId?: string;
			toolName: string;
			ok: boolean;
			text: string;
			truncated: boolean;
			images?: RemoteImage[];
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
	data?: string;
	mimeType?: string;
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

/** The entries from the root to `leafId`, or to the file's last entry, following `parentId`. */
export function activeBranch(entries: Entry[], leafId?: string): Entry[] {
	const byId = new Map<string, Entry>();
	for (const entry of entries) if (entry.id && entry.type !== "session") byId.set(entry.id, entry);
	let current =
		(leafId ? byId.get(leafId) : undefined) ??
		[...entries].reverse().find((entry) => entry.id && entry.type !== "session");
	const branch: Entry[] = [];
	const seen = new Set<string>();
	while (current?.id && !seen.has(current.id)) {
		seen.add(current.id);
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return branch.reverse();
}

export function clip(text: string): { text: string; truncated: boolean } {
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

/** A message's image parts, base64 as pi stores them. */
function imagesOf(content: unknown): Array<{ mimeType: string; data: string }> {
	return partsOf(content).flatMap((part) =>
		part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string"
			? [{ mimeType: part.mimeType, data: part.data }]
			: [],
	);
}

/** The `images` a message carries, if it has any. */
function imageRefs(content: unknown): { images?: RemoteImage[] } {
	const images = imagesOf(content).map(({ mimeType }, index) => ({ index, mimeType }));
	return images.length ? { images } : {};
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
			return { kind: "user", id, text: plainText(message.content), ...imageRefs(message.content) };
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
				...imageRefs(message.content),
			};
		}
		case "bashExecution":
			return typeof message.command === "string" ? { kind: "marker", id, text: `!${message.command}` } : undefined;
		default:
			return undefined;
	}
}

/** The last `limit` messages of the active branch, or the last ones before the message `before`:
 *  none when it is not on the branch. */
export function transcriptFrom(text: string, limit: number, leafId?: string, before?: string): RemoteMessage[] {
	let messages = activeBranch(parseEntries(text), leafId)
		.map(toRemote)
		.filter((message): message is RemoteMessage => message !== undefined);
	if (before !== undefined)
		messages = messages.slice(
			0,
			Math.max(
				messages.findIndex((m) => m.id === before),
				0,
			),
		);
	return limit > 0 ? messages.slice(-limit) : [];
}

/** The image at `index` in a user message or tool result on the active branch, as the transcript refers to it. */
export function imageFrom(
	text: string,
	entryId: string,
	index: number,
	leafId?: string,
): { mimeType: string; data: string } | undefined {
	const entry = activeBranch(parseEntries(text), leafId).find((e) => e.id === entryId);
	const role = entry?.type === "message" ? entry.message?.role : undefined;
	if (role !== "user" && role !== "toolResult") return undefined;
	return imagesOf(entry?.message?.content)[index];
}

export function loadImage(
	sessionFile: string | undefined,
	entryId: string,
	index: number,
	leafId?: string,
): { mimeType: string; data: string } | undefined {
	if (!sessionFile) return undefined;
	try {
		return imageFrom(readFileSync(sessionFile, "utf8"), entryId, index, leafId);
	} catch {
		return undefined;
	}
}

/** A session that has not written its file yet has an empty transcript. */
export function loadTranscript(
	sessionFile: string | undefined,
	limit: number,
	leafId?: string,
	before?: string,
): RemoteMessage[] {
	if (!sessionFile) return [];
	let text: string;
	try {
		text = readFileSync(sessionFile, "utf8");
	} catch {
		return [];
	}
	return transcriptFrom(text, limit, leafId, before);
}
