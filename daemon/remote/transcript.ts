/**
 * A session's .jsonl as the phone's chat. The active branch is the `parentId` chain from the
 * pane's leaf when it reports one (after a /tree), else from the file's last entry (pi appends to
 * the branch it is on); each entry is reduced to what a phone
 * shows. Pure apart from the `load*` functions' reads, which share a cache of parsed files.
 */
import { readFileSync, statSync } from "node:fs";
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
	| {
			kind: "assistant";
			id: string;
			text: string;
			thinking?: string;
			tools: RemoteToolCall[];
			error?: string;
			/** Stopped by the user (Stop, Esc): Claude Code's "Interrupted by user". Its text may be empty. */
			aborted?: true;
	  }
	| {
			kind: "toolResult";
			id: string;
			toolCallId?: string;
			toolName: string;
			ok: boolean;
			text: string;
			truncated: boolean;
			images?: RemoteImage[];
			/** An edit's diff, as pi shows it. */
			diff?: string;
			diffTruncated?: boolean;
	  }
	| { kind: "marker"; id: string; text: string };

/** A tool result or a thinking block is cut to this many characters. */
export const TEXT_MAX = 2048;
/** A diff, and a tool result's whole output when the phone asks for it, are cut to these. */
export const DIFF_MAX = 16 * 1024;
export const OUTPUT_MAX = 256 * 1024;
const SUMMARY_MAX = 120;
/** Parsed files kept, the least recently read dropped first. */
const PARSED_MAX = 8;

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
		details?: { diff?: unknown };
	};
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

export function clip(text: string, max = TEXT_MAX): { text: string; truncated: boolean } {
	return text.length > max ? { text: `${text.slice(0, max)}…`, truncated: true } : { text, truncated: false };
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
	// As Claude Code's transcript: a model or thinking level change shows nowhere but the status line.
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
			// pi ends a stopped turn with one, empty when it was stopped before any reply or during a tool.
			const aborted = message.stopReason === "aborted";
			if (!text && !thinking && tools.length === 0 && !error && !aborted) return undefined;
			return {
				kind: "assistant",
				id,
				text,
				...(thinking ? { thinking: clip(thinking).text } : {}),
				tools,
				...(error ? { error } : {}),
				...(aborted ? { aborted: true as const } : {}),
			};
		}
		case "toolResult": {
			const { text, truncated } = clip(plainText(message.content));
			const diff = message.details?.diff;
			const clipped = typeof diff === "string" && diff ? clip(diff, DIFF_MAX) : undefined;
			return {
				kind: "toolResult",
				id,
				toolCallId: message.toolCallId,
				toolName: message.toolName ?? "tool",
				ok: message.isError !== true,
				text,
				truncated,
				...imageRefs(message.content),
				...(clipped ? { diff: clipped.text, diffTruncated: clipped.truncated } : {}),
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
	return messagesOf(parseEntries(text), limit, leafId, before);
}

function messagesOf(entries: Entry[], limit: number, leafId?: string, before?: string): RemoteMessage[] {
	let messages = activeBranch(entries, leafId)
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
	return imageOf(parseEntries(text), entryId, index, leafId);
}

function imageOf(
	entries: Entry[],
	entryId: string,
	index: number,
	leafId?: string,
): { mimeType: string; data: string } | undefined {
	const entry = activeBranch(entries, leafId).find((e) => e.id === entryId);
	const role = entry?.type === "message" ? entry.message?.role : undefined;
	if (role !== "user" && role !== "toolResult") return undefined;
	return imagesOf(entry?.message?.content)[index];
}

/** Each file read lately, parsed, with the size and mtime it had: least recently read first. */
const parsed = new Map<string, { signature: string; entries: Entry[] }>();

/** A file's entries, parsed again only once its size or mtime changed. Throws when it cannot be read. */
function entriesOf(sessionFile: string): Entry[] {
	const stat = statSync(sessionFile);
	const signature = `${stat.size}:${stat.mtimeMs}`;
	const cached = parsed.get(sessionFile);
	parsed.delete(sessionFile);
	const entries = cached?.signature === signature ? cached.entries : parseEntries(readFileSync(sessionFile, "utf8"));
	parsed.set(sessionFile, { signature, entries });
	if (parsed.size > PARSED_MAX) parsed.delete(parsed.keys().next().value as string);
	return entries;
}

export function loadImage(
	sessionFile: string | undefined,
	entryId: string,
	index: number,
	leafId?: string,
): { mimeType: string; data: string } | undefined {
	if (!sessionFile) return undefined;
	try {
		return imageOf(entriesOf(sessionFile), entryId, index, leafId);
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
	try {
		return messagesOf(entriesOf(sessionFile), limit, leafId, before);
	} catch {
		return [];
	}
}

/** The whole output of a tool result on the active branch, up to OUTPUT_MAX characters. */
export function loadOutput(
	sessionFile: string | undefined,
	entryId: string,
	leafId?: string,
): { text: string; truncated: boolean } | undefined {
	if (!sessionFile) return undefined;
	let entries: Entry[];
	try {
		entries = entriesOf(sessionFile);
	} catch {
		return undefined;
	}
	const entry = activeBranch(entries, leafId).find((e) => e.id === entryId);
	if (entry?.type !== "message" || entry.message?.role !== "toolResult") return undefined;
	return clip(plainText(entry.message.content), OUTPUT_MAX);
}
