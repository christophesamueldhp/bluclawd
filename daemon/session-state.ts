/**
 * What agent view shows for a session, from the session's own output — no model call (Claude
 * Code writes its row summaries with a Haiku-class model; bluclawd has to work with any provider,
 * so it uses the fallback Claude Code itself uses between summaries: the recent output).
 *
 * A stored row's outcome comes from pi's own signals only, with nothing added to the system
 * prompt: a model error is Failed, an interrupted turn Stopped, any other finished turn Done.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export type SessionOutcome = "done" | "failed" | "stopped";

const DETAIL_MAX = 200;

function clip(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > DETAIL_MAX ? `${oneLine.slice(0, DETAIL_MAX - 1)}…` : oneLine;
}

/** Last non-empty line, with list/heading markers stripped. */
export function lastLine(text: string): string | undefined {
	const lines = text
		.split("\n")
		.map((line) => line.replace(/^\s*(?:[#>*-]+|\d+\.)\s*/, "").trim())
		.filter(Boolean);
	return lines.length ? clip(lines[lines.length - 1]) : undefined;
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/** A running tool as one line: its own description when it has one, as Claude Code's row shows. */
export function toolActivity(toolName: string | undefined, args: unknown): string | undefined {
	const a = (args ?? {}) as Record<string, unknown>;
	const text = [a.description, a.command, a.path, a.pattern, a.url].find((v) => typeof v === "string" && v.trim());
	if (typeof text === "string") return lastLine(text);
	return toolName;
}

interface MessageLike {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

/** Where a turn that ended with `message` left the session. */
function outcomeOf(message: MessageLike): { detail?: string; outcome: SessionOutcome } {
	if (message.stopReason === "error") {
		return { detail: clip(message.errorMessage || "the model request failed"), outcome: "failed" };
	}
	return { detail: lastLine(textOf(message.content)), outcome: message.stopReason === "aborted" ? "stopped" : "done" };
}

const TAIL_BYTES = 16 * 1024;

/**
 * Where a session left off, from the last 16KB of its .jsonl — how agent view fills in a row
 * for a session whose pi quit.
 */
export function readSessionTail(
	sessionFile: string,
): { detail?: string; outcome?: SessionOutcome; turns: number } | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(sessionFile, "r");
		const size = fstatSync(fd).size;
		const length = Math.min(size, TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		let last: MessageLike | undefined;
		for (const line of buffer.toString("utf8").split("\n")) {
			try {
				const entry = JSON.parse(line) as { type?: string; message?: MessageLike };
				if (entry.type === "message" && entry.message?.role === "assistant") last = entry.message;
			} catch {
				// the first line of the window is usually cut mid-entry
			}
		}
		if (!last) return { turns: 0 };
		return { ...outcomeOf(last), turns: 1 };
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
