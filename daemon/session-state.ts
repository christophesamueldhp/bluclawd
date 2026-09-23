/**
 * What agent view shows for a background session, derived from the child's own event stream —
 * no model call (Claude Code writes its row summaries with a Haiku-class model; bluclawd has to
 * work with any provider, so it uses the fallback Claude Code itself uses between summaries:
 * the session's own recent output).
 *
 * Children are told (SENTINEL_INSTRUCTIONS, passed as --append-system-prompt) to end a turn with
 * a `result:` / `needs input:` / `failed:` line, the same convention Claude Code gives its
 * background sessions. When a turn ends without one, the last line of assistant text stands in.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";

export type SessionOutcome = "done" | "failed" | "stopped";

/** A question the session is blocked on, as the peek panel shows it. */
export interface SessionNeeds {
	requestId: string;
	method: "select" | "confirm" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	/** When the session started waiting. */
	since?: string;
}

export const SENTINEL_INSTRUCTIONS = [
	"You are running as a background session. Nobody is watching the transcript; a one-line status is shown for you in a session list.",
	"When you finish a turn, end your final message with exactly one of these lines, on its own line:",
	"result: <one short sentence saying what you produced>",
	"needs input: <the one question you need the user to answer>",
	"failed: <one short sentence saying what went wrong>",
].join("\n");

const DETAIL_MAX = 200;

type Sentinel = { kind: "result" | "needs" | "failed"; text: string };

/** The LAST sentinel line in `text`, if any. */
export function scanSentinel(text: string): Sentinel | undefined {
	let found: Sentinel | undefined;
	for (const raw of text.split("\n")) {
		const match = /^\s*(?:[*_`>-]\s*)*(result|needs input|failed)\s*:\s*(?:[*_`]+\s*)?(.+?)\s*[*_`]*\s*$/i.exec(raw);
		if (!match) continue;
		const word = match[1].toLowerCase();
		found = { kind: word === "result" ? "result" : word === "failed" ? "failed" : "needs", text: clip(match[2]) };
	}
	return found;
}

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

interface MessageLike {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

export function needsFromRequest(request: RpcExtensionUIRequest): SessionNeeds | undefined {
	switch (request.method) {
		case "select":
			return { requestId: request.id, method: "select", title: request.title, options: [...request.options] };
		case "confirm":
			return { requestId: request.id, method: "confirm", title: request.title, message: request.message };
		case "input":
		case "editor":
			return { requestId: request.id, method: request.method, title: request.title };
		default:
			return undefined;
	}
}

/**
 * Folds one child's events into its row state. `turns` counts finished runs so a session that
 * has never been prompted reads "Idle" rather than "Done".
 */
export class SessionStateTracker {
	detail: string | undefined;
	outcome: SessionOutcome | undefined;
	/** A `needs input:` line from the last turn — the session is waiting on a free-text answer. */
	needsText: string | undefined;
	turns = 0;
	finishedAt: string | undefined;
	private lastAssistant: MessageLike | undefined;

	constructor(seed?: { detail?: string; outcome?: SessionOutcome; turns?: number; finishedAt?: string }) {
		this.detail = seed?.detail;
		this.outcome = seed?.outcome;
		this.turns = seed?.turns ?? 0;
		this.finishedAt = seed?.finishedAt;
	}

	apply(event: { type: string; message?: MessageLike; isError?: boolean; result?: unknown }, now = new Date()): void {
		switch (event.type) {
			case "agent_start":
				this.outcome = undefined;
				this.needsText = undefined;
				this.finishedAt = undefined;
				this.lastAssistant = undefined;
				break;
			case "message_start":
				if (event.message?.role === "user") {
					const text = lastLine(textOf(event.message.content));
					if (text) this.detail = `> ${text}`;
				}
				break;
			case "message_end":
				if (event.message?.role === "assistant") {
					this.lastAssistant = event.message;
					const text = lastLine(textOf(event.message.content));
					if (text) this.detail = text;
				}
				break;
			case "tool_execution_end":
				if (event.isError) {
					const text = lastLine(textOf((event.result as { content?: unknown } | undefined)?.content));
					this.detail = `✗ ${text ?? "tool error"}`;
				}
				break;
			case "agent_settled":
				this.settle(now);
				break;
		}
	}

	private settle(now: Date): void {
		this.turns++;
		this.finishedAt = now.toISOString();
		const message = this.lastAssistant;
		if (message?.stopReason === "error") {
			this.outcome = "failed";
			this.detail = clip(message.errorMessage || "the model request failed");
			return;
		}
		const sentinel = scanSentinel(textOf(message?.content));
		if (sentinel?.kind === "needs") {
			this.outcome = undefined;
			this.needsText = sentinel.text;
			this.detail = sentinel.text;
			return;
		}
		this.outcome = sentinel?.kind === "failed" ? "failed" : "done";
		if (sentinel) this.detail = sentinel.kind === "result" ? `result: ${sentinel.text}` : sentinel.text;
	}
}

const TAIL_BYTES = 16 * 1024;

/**
 * Where a session left off, from the last 16KB of its .jsonl — how agent view fills in a row
 * for a session it has no record of (brought back with /resume, or handed off from a window).
 */
export function readSessionTail(
	sessionFile: string,
): { detail?: string; outcome?: SessionOutcome; question?: string; turns: number } | undefined {
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
		const tracker = new SessionStateTracker();
		tracker.apply({ type: "message_end", message: last });
		tracker.apply({ type: "agent_settled" });
		return { detail: tracker.detail, outcome: tracker.outcome, question: tracker.needsText, turns: 1 };
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
