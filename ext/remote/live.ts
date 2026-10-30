/**
 * The reply a pane is streaming, for the phones that have its session open: pi's message and
 * tool events reduced to a LiveSnapshot, sent at most every LIVE_INTERVAL_MS (message_update
 * fires per token) and ended with null once pi has written it, naming the entry it became.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LiveSnapshot } from "../../daemon/ipc/protocol.ts";
import { clip, toolSummary } from "../../daemon/remote/transcript.ts";
import { textOf } from "../../daemon/session-state.ts";

export const LIVE_INTERVAL_MS = 300;

interface MessageLike {
	role?: string;
	content?: unknown;
}

interface Part {
	type?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

type LiveTool = LiveSnapshot["tools"][number];

/** A snapshot, or null when the reply ended, with the transcript entry it became when known. */
export type LiveSend = (live: LiveSnapshot | null, entryId?: string) => void;

/**
 * One send at a time, each with the latest snapshot: one a newer one replaced while a send was on
 * its way is skipped. A null (an end) is never skipped nor overtaken, and one that failed is sent
 * again before the next send.
 */
export function latestOnly(send: (live: LiveSnapshot | null, entryId?: string) => Promise<unknown>): LiveSend {
	const queue: Array<{ live: LiveSnapshot | null; entryId?: string }> = [];
	let sending = false;
	/** A send came in since the last attempt, so a failed end is tried again now. */
	let fresh = false;
	const drain = async () => {
		sending = true;
		for (let item = queue.shift(); item; item = queue.shift()) {
			fresh = false;
			const failed = await send(item.live, item.entryId).then(
				() => false,
				() => true,
			);
			if (failed && item.live === null) {
				queue.unshift(item);
				if (!fresh) break;
			}
		}
		sending = false;
	};
	return (live, entryId) => {
		if (queue.at(-1)?.live) queue.pop();
		queue.push({ live, ...(entryId ? { entryId } : {}) });
		fresh = true;
		if (!sending) void drain();
	};
}

/** A LiveForwarder fed pi's events, reading the session's leaf from the latest one's context. */
export function forwardLive(pi: ExtensionAPI, send: LiveSend): LiveForwarder {
	let session: ExtensionContext["sessionManager"] | undefined;
	const live = new LiveForwarder(send, () => session?.getLeafId() ?? null);
	const at = (ctx: ExtensionContext) => {
		session = ctx.sessionManager;
	};
	pi.on("message_start", (event, ctx) => {
		at(ctx);
		live.onMessageStart(event.message);
	});
	pi.on("message_update", (event) => live.onMessageUpdate(event.message));
	pi.on("message_end", (event, ctx) => {
		at(ctx);
		live.onMessageEnd(event.message);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		at(ctx);
		live.onToolStart(event.toolCallId, event.toolName, event.args);
	});
	pi.on("tool_execution_end", (event) => live.onToolEnd(event.toolCallId));
	pi.on("turn_end", (event) => live.onTurnEnd(event.messageEntryId));
	pi.on("agent_end", (_event, ctx) => {
		at(ctx);
		live.onAgentEnd();
	});
	return live;
}

export class LiveForwarder {
	private readonly send: LiveSend;
	/** The session's leaf entry id, which moves when pi writes a message. */
	private readonly leafId: () => string | null;
	private readonly now: () => number;
	/** The assistant message being streamed; reduced only when sent, not per token. */
	private message: MessageLike | undefined;
	/** The leaf when that message started: its entry is written after it. */
	private startLeaf: string | null | undefined;
	/** An ended reply the phone was shown, whose entry pi has not written yet: the leaf it follows. */
	private ending: { after: string | null } | undefined;
	private readonly tools = new Map<string, LiveTool>();
	private watched = false;
	/** The phone holds a snapshot of ours, which a null must clear. */
	private shown = false;
	private dirty = false;
	private lastSent = Number.NEGATIVE_INFINITY;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(send: LiveSend, leafId: () => string | null, now: () => number = Date.now) {
		this.send = send;
		this.leafId = leafId;
		this.now = now;
	}

	onMessageStart(message: MessageLike): void {
		this.settle();
		if (message.role === "assistant") this.startLeaf = this.leafId();
	}

	onMessageUpdate(message: MessageLike): void {
		if (message.role !== "assistant") return;
		this.message = message;
		this.changed();
	}

	onToolStart(id: string, name: string, args: unknown): void {
		this.settle();
		this.tools.set(id, { id, name, summary: toolSummary(args), running: true });
		this.changed();
	}

	onToolEnd(id: string): void {
		const tool = this.tools.get(id);
		if (!tool) return;
		tool.running = false;
		this.changed();
	}

	/** The message goes to the transcript now; what is left is the tools still running. */
	onMessageEnd(message: MessageLike): void {
		this.message = undefined;
		for (const [id, tool] of this.tools) if (!tool.running) this.tools.delete(id);
		const after = this.startLeaf === undefined ? this.leafId() : this.startLeaf;
		this.startLeaf = undefined;
		if (message.role !== "assistant" || !this.shown) {
			if (this.tools.size > 0) this.changed();
			else this.clear();
			return;
		}
		// pi writes the message once every extension's message_end handler is done, which a macrotask
		// usually follows; one slower than that is caught at the next event.
		this.ending = { after };
		this.dirty = this.tools.size > 0;
		setTimeout(() => this.settle(), 0);
	}

	/** `entryId`: the turn's assistant entry, which pi has written by now. */
	onTurnEnd(entryId: string): void {
		this.settle(entryId);
	}

	onAgentEnd(): void {
		this.settle();
		this.message = undefined;
		this.tools.clear();
		this.clear();
	}

	setWatched(watched: boolean): void {
		if (watched === this.watched) return;
		this.watched = watched;
		if (!watched) {
			this.retract();
			return;
		}
		this.dirty = this.message !== undefined || this.tools.size > 0;
		if (this.dirty) this.schedule();
	}

	private changed(): void {
		this.dirty = true;
		if (this.watched) this.schedule();
	}

	private schedule(): void {
		if (this.timer) return;
		const wait = this.lastSent + LIVE_INTERVAL_MS - this.now();
		if (wait <= 0) {
			this.flush();
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, wait);
	}

	/** Sends a pending end once pi has written its entry, then what waited behind it. */
	private settle(entryId?: string): void {
		if (!this.ending) return;
		const written = entryId ?? this.leafId();
		if (written === null || written === this.ending.after) return;
		this.ending = undefined;
		this.shown = false;
		this.send(null, written);
		if (this.dirty && this.watched) this.schedule();
	}

	private flush(): void {
		// A snapshot waits for the end it follows.
		if (!this.dirty || !this.watched || this.ending) return;
		this.dirty = false;
		this.lastSent = this.now();
		this.shown = true;
		this.send(this.snapshot());
	}

	private clear(): void {
		this.dirty = false;
		this.retract();
	}

	private retract(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.ending = undefined;
		if (!this.shown) return;
		this.shown = false;
		this.send(null);
	}

	private snapshot(): LiveSnapshot {
		const parts = Array.isArray(this.message?.content) ? (this.message.content as Part[]) : [];
		const thinking = parts
			.filter((part) => part.type === "thinking" && part.thinking)
			.map((part) => part.thinking)
			.join("\n\n");
		const tools: LiveTool[] = parts
			.filter((part) => part.type === "toolCall" && !this.tools.has(part.id ?? ""))
			.map((part) => ({
				id: part.id ?? "",
				name: part.name ?? "tool",
				summary: toolSummary(part.arguments),
				running: false,
			}));
		return {
			text: textOf(this.message?.content),
			...(thinking ? { thinking: clip(thinking).text } : {}),
			tools: [...tools, ...[...this.tools.values()].map((tool) => ({ ...tool }))],
		};
	}
}
