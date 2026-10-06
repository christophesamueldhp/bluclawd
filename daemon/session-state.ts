/**
 * What agent view shows for a background session, derived from the child's own event stream —
 * no model call (Claude Code writes its row summaries with a Haiku-class model; bluclawd has to
 * work with any provider, so it uses the fallback Claude Code itself uses between summaries:
 * the session's own recent output).
 *
 * The outcome comes from pi's own signals only, with nothing added to the system prompt: a model
 * error is Failed, an interrupted turn Stopped, any other settled turn Done. Needs input is a
 * blocking prompt (`needsFromRequest`), never words in the reply.
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
	turns = 0;
	finishedAt: string | undefined;
	private lastAssistant: MessageLike | undefined;

	constructor(seed?: { detail?: string; outcome?: SessionOutcome; turns?: number; finishedAt?: string }) {
		this.detail = seed?.detail;
		this.outcome = seed?.outcome;
		this.turns = seed?.turns ?? 0;
		this.finishedAt = seed?.finishedAt;
	}

	apply(
		event: {
			type: string;
			message?: MessageLike;
			isError?: boolean;
			result?: unknown;
			toolName?: string;
			args?: unknown;
		},
		now = new Date(),
	): void {
		switch (event.type) {
			case "agent_start":
				this.outcome = undefined;
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
			case "tool_execution_start": {
				const text = toolActivity(event.toolName, event.args);
				if (text) this.detail = text;
				break;
			}
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
		this.outcome = message?.stopReason === "aborted" ? "stopped" : "done";
	}
}

const TAIL_BYTES = 16 * 1024;

/**
 * Where a session left off, from the last 16KB of its .jsonl — how agent view fills in a row
 * for a session it has no record of (brought back with /resume, or handed off from a window).
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
		const tracker = new SessionStateTracker();
		tracker.apply({ type: "message_end", message: last });
		tracker.apply({ type: "agent_settled" });
		return { detail: tracker.detail, outcome: tracker.outcome, turns: 1 };
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
