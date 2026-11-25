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

export type LiveSend = (live: LiveSnapshot | null, entryId?: string) => void;

export function coalescingSender(send: (live: LiveSnapshot | null, entryId?: string) => Promise<unknown>): LiveSend {
	const queue: Array<{ live: LiveSnapshot | null; entryId?: string }> = [];
	let sending = false;
	let sentSinceLastAttempt = false;
	const drain = async () => {
		sending = true;
		for (let item = queue.shift(); item; item = queue.shift()) {
			sentSinceLastAttempt = false;
			const failed = await send(item.live, item.entryId).then(
				() => false,
				() => true,
			);
			if (failed && item.live === null) {
				queue.unshift(item);
				if (!sentSinceLastAttempt) break;
			}
		}
		sending = false;
	};
	const dropSupersededSnapshot = () => {
		if (queue.at(-1)?.live) queue.pop();
	};
	return (live, entryId) => {
		dropSupersededSnapshot();
		queue.push({ live, ...(entryId ? { entryId } : {}) });
		sentSinceLastAttempt = true;
		if (!sending) void drain();
	};
}

export type SessionReader = Pick<ExtensionContext["sessionManager"], "getLeafId" | "getEntry">;

export function forwardLive(pi: ExtensionAPI, send: LiveSend): LiveForwarder {
	let session: SessionReader | undefined;
	const live = new LiveForwarder(send, {
		getLeafId: () => session?.getLeafId() ?? null,
		getEntry: (id) => session?.getEntry(id),
	});
	const at = (ctx: { sessionManager: SessionReader }) => {
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
	private readonly session: SessionReader;
	private readonly now: () => number;
	private message: MessageLike | undefined;
	private startLeaf: string | null | undefined;
	private endAwaitingEntry: { after: string | null } | undefined;
	private readonly tools = new Map<string, LiveTool>();
	private watched = false;
	private phoneHoldsSnapshot = false;
	private dirty = false;
	private lastSent = Number.NEGATIVE_INFINITY;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(send: LiveSend, session: SessionReader, now: () => number = Date.now) {
		this.send = send;
		this.session = session;
		this.now = now;
	}

	onMessageStart(message: MessageLike): void {
		this.settle();
		if (message.role === "assistant") this.startLeaf = this.session.getLeafId();
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

	onMessageEnd(message: MessageLike): void {
		this.message = undefined;
		for (const [id, tool] of this.tools) if (!tool.running) this.tools.delete(id);
		const after = this.startLeaf === undefined ? this.session.getLeafId() : this.startLeaf;
		this.startLeaf = undefined;
		if (message.role !== "assistant" || !this.phoneHoldsSnapshot) {
			if (this.tools.size > 0) this.changed();
			else this.clear();
			return;
		}
		// pi writes the message once every extension's message_end handler is done, which a macrotask
		// usually follows; one slower than that is caught at the next event.
		this.endAwaitingEntry = { after };
		this.dirty = this.tools.size > 0;
		setTimeout(() => this.settle(), 0);
	}

	onTurnEnd(entryId: string): void {
		this.settle(entryId);
	}

	onAgentEnd(): void {
		this.reset();
	}

	reset(): void {
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

	private settle(entryId?: string): void {
		if (!this.endAwaitingEntry) return;
		const written = entryId ?? this.assistantEntryWrittenAfter(this.endAwaitingEntry.after);
		if (!written) return;
		this.endAwaitingEntry = undefined;
		this.phoneHoldsSnapshot = false;
		this.send(null, written);
		if (this.dirty && this.watched) this.schedule();
	}

	private assistantEntryWrittenAfter(after: string | null): string | undefined {
		let found: string | undefined;
		for (let id = this.session.getLeafId(); id !== after; ) {
			const entry = id === null ? undefined : this.session.getEntry(id);
			if (!entry) return undefined;
			if (entry.type === "message" && entry.message.role === "assistant") found = entry.id;
			id = entry.parentId;
		}
		return found;
	}

	private flush(): void {
		if (!this.dirty || !this.watched || this.endAwaitingEntry) return;
		this.dirty = false;
		this.lastSent = this.now();
		this.phoneHoldsSnapshot = true;
		this.send(this.snapshot());
	}

	private clear(): void {
		this.dirty = false;
		this.retract();
	}

	private retract(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.endAwaitingEntry = undefined;
		if (!this.phoneHoldsSnapshot) return;
		this.phoneHoldsSnapshot = false;
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
