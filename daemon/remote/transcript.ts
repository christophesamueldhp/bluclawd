import { readFileSync, statSync } from "node:fs";
import { textOf } from "../session-state.ts";

export interface RemoteToolCall {
	id: string;
	name: string;
	summary: string;
}

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
			aborted?: true;
	  }
	| {
			kind: "toolResult";
			id: string;
			toolCallId?: string;
			toolName: string;
			command?: string;
			// biome-ignore lint/plugin: whether the tool failed, not an ok-result; both outcomes carry the same fields.
			ok: boolean;
			text: string;
			truncated: boolean;
			images?: RemoteImage[];
			diff?: string;
			diffTruncated?: boolean;
	  }
	| { kind: "marker"; id: string; text: string };

export type TimedMessage = RemoteMessage & { at?: string };

export const TEXT_MAX = 2048;
export const DIFF_MAX = 16 * 1024;
export const OUTPUT_MAX = 256 * 1024;
const SUMMARY_MAX = 120;
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

export interface EntryUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface Entry {
	type?: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		stopReason?: string;
		errorMessage?: string;
		command?: string;
		output?: string;
		exitCode?: number;
		cancelled?: boolean;
		details?: { diff?: unknown };
		usage?: EntryUsage;
	};
	content?: unknown;
	display?: boolean;
	customType?: string;
	details?: { id?: unknown; description?: unknown; end?: unknown };
	usage?: EntryUsage;
	tokensBefore?: number;
}

function parsedUnlessStillBeingWritten(line: string): Entry | undefined {
	try {
		return JSON.parse(line) as Entry;
	} catch {
		return undefined;
	}
}

export function parseEntries(text: string): Entry[] {
	const entries: Entry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const entry = parsedUnlessStillBeingWritten(line);
		if (entry && typeof entry === "object") entries.push(entry);
	}
	return entries;
}

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

function plainText(content: unknown): string {
	return partsOf(content)
		.map((part) => (part.type === "text" ? (part.text ?? "") : part.type === "image" ? "[Image]" : ""))
		.filter(Boolean)
		.join("\n");
}

function imagesOf(content: unknown): Array<{ mimeType: string; data: string }> {
	return partsOf(content).flatMap((part) =>
		part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string"
			? [{ mimeType: part.mimeType, data: part.data }]
			: [],
	);
}

function imageRefs(content: unknown): { images?: RemoteImage[] } {
	const images = imagesOf(content).map(({ mimeType }, index) => ({ index, mimeType }));
	return images.length ? { images } : {};
}

export function toolSummary(args: unknown): string {
	const a = (args ?? {}) as Record<string, unknown>;
	const value = [a.command, a.path, a.pattern, a.url, a.query, a.description].find(
		(v) => typeof v === "string" && v.trim(),
	);
	return typeof value === "string" ? firstLine(value) : "";
}

function noticeText({ customType, details }: Entry): string | undefined {
	if (customType === "bluclawd:task-exit" && typeof details?.end === "string") return details.end;
	if (customType === "bluclawd:monitor" && typeof details?.description === "string") {
		return `monitor ${String(details.id)} · ${details.description}`;
	}
	return undefined;
}

function toRemote(entry: Entry): RemoteMessage | undefined {
	const id = entry.id ?? "";
	if (entry.type === "compaction") return { kind: "marker", id, text: "Conversation compacted" };
	if (entry.type === "custom_message" && entry.display) {
		const text = firstLine(noticeText(entry) ?? plainText(entry.content));
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
			const full = plainText(message.content);
			const cut = clip(full);
			// pi ends a long result with a note on what it left out ("[Showing lines 1-382 of 2001 …]"), kept past the clip.
			const note = cut.truncated ? /\n\n(\[[^\n]{1,200}\])$/.exec(full)?.[1] : undefined;
			const { truncated } = cut;
			const text = note ? `${cut.text}\n\n${note}` : cut.text;
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
		case "bashExecution": {
			if (typeof message.command !== "string") return undefined;
			const { text, truncated } = clip(message.output ?? "");
			const ok = !message.cancelled && (message.exitCode === undefined || message.exitCode === 0);
			return { kind: "toolResult", id, toolName: "bash", command: message.command, ok, text, truncated };
		}
		default:
			return undefined;
	}
}

export function transcriptFrom(text: string, limit: number, leafId?: string, before?: string): TimedMessage[] {
	return messagesOf(parseEntries(text), limit, leafId, before);
}

function messagesOf(entries: Entry[], limit: number, leafId?: string, before?: string): TimedMessage[] {
	let messages = activeBranch(entries, leafId).flatMap((entry): TimedMessage[] => {
		const message = toRemote(entry);
		if (!message) return [];
		return [entry.timestamp ? { ...message, at: entry.timestamp } : message];
	});
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

const parsed = new Map<string, { signature: string; entries: Entry[] }>();

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

export function loadBranch(sessionFile: string | undefined, leafId?: string): Entry[] {
	if (!sessionFile) return [];
	try {
		return activeBranch(entriesOf(sessionFile), leafId);
	} catch {
		return [];
	}
}

export function loadTranscript(
	sessionFile: string | undefined,
	limit: number,
	leafId?: string,
	before?: string,
): TimedMessage[] {
	if (!sessionFile) return [];
	try {
		return messagesOf(entriesOf(sessionFile), limit, leafId, before);
	} catch {
		return [];
	}
}

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
	if (entry?.type !== "message") return undefined;
	if (entry.message?.role === "bashExecution") return clip(entry.message.output ?? "", OUTPUT_MAX);
	if (entry.message?.role !== "toolResult") return undefined;
	return clip(plainText(entry.message.content), OUTPUT_MAX);
}
