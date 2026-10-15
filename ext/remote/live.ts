/**
 * The reply a pane is streaming, for the phones that have its session open: pi's message and
 * tool events reduced to a LiveSnapshot, sent at most every LIVE_INTERVAL_MS (message_update
 * fires per token) and cleared with null once the transcript has it.
 */

import type { LiveSnapshot } from "../../daemon/orchestrator-client.ts";
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

/**
 * One send at a time, each with the latest snapshot: one a newer one replaced while a send was on
 * its way is skipped, and a null (the latest once a reply ends) never overtakes the snapshot it clears.
 */
export function latestOnly(send: (live: LiveSnapshot | null) => Promise<unknown>): (live: LiveSnapshot | null) => void {
	let next: { live: LiveSnapshot | null } | undefined;
	let sending = false;
	const drain = async () => {
		sending = true;
		while (next) {
			const { live } = next;
			next = undefined;
			await send(live).catch(() => {});
		}
		sending = false;
	};
	return (live) => {
		next = { live };
		if (!sending) void drain();
	};
}

export class LiveForwarder {
	private readonly send: (live: LiveSnapshot | null) => void;
	private readonly now: () => number;
	/** The assistant message being streamed; reduced only when sent, not per token. */
	private message: MessageLike | undefined;
	private readonly tools = new Map<string, LiveTool>();
	private watched = false;
	/** The phone holds a snapshot of ours, which a null must clear. */
	private shown = false;
	private dirty = false;
	private lastSent = Number.NEGATIVE_INFINITY;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(send: (live: LiveSnapshot | null) => void, now: () => number = Date.now) {
		this.send = send;
		this.now = now;
	}

	onMessageUpdate(message: MessageLike): void {
		if (message.role !== "assistant") return;
		this.message = message;
		this.changed();
	}

	onToolStart(id: string, name: string, args: unknown): void {
		this.tools.set(id, { id, name, summary: toolSummary(args), running: true });
		this.changed();
	}

	onToolEnd(id: string): void {
		const tool = this.tools.get(id);
		if (!tool) return;
		tool.running = false;
		this.changed();
	}

	/** The message is in the transcript now; what is left is the tools still running. */
	onMessageEnd(): void {
		this.message = undefined;
		for (const [id, tool] of this.tools) if (!tool.running) this.tools.delete(id);
		if (this.tools.size > 0) this.changed();
		else this.clear();
	}

	onAgentEnd(): void {
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

	private flush(): void {
		if (!this.dirty || !this.watched) return;
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
