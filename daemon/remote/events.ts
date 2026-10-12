/**
 * Server-Sent Events for the phone. They carry no content, only "refetch" signals: `sessions`
 * when the list changes, `messages` when the .jsonl of the session a client has open changes or
 * its pane moves to another leaf.
 * Polled once a second while any client is connected, which is also when a revoked device is cut off; the registry itself changes on the panes'
 * 3s heartbeats.
 */
import { statSync } from "node:fs";
import type { ServerResponse } from "node:http";

export interface EventSources {
	/** Changes exactly when the phone's session list would. */
	sessionsSignature(): string;
	sessionFile(sessionId: string): string | undefined;
	leafId(sessionId: string): string | undefined;
}

interface Client {
	res: ServerResponse;
	sessionId?: string;
	messagesSignature?: string;
	isAuthorized: () => boolean;
}

const INTERVAL_MS = 1000;
/** A named event (not a comment, so the phone sees it) this often keeps the stream alive and lets the phone notice a dead one. */
const PING_EVERY_TICKS = 25;

function fileSignature(file: string | undefined): string {
	if (!file) return "none";
	try {
		const stat = statSync(file);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return "missing";
	}
}

function send(res: ServerResponse, event: string, data: object): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export class RemoteEvents {
	private readonly sources: EventSources;
	private readonly clients = new Set<Client>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastSessions: string | undefined;
	private ticks = 0;

	constructor(sources: EventSources) {
		this.sources = sources;
	}

	/**
	 * `sessionId`: the session the client has open, whose file it is told about.
	 * `isAuthorized`: checked every tick; a client that fails it is disconnected.
	 */
	add(res: ServerResponse, sessionId?: string, isAuthorized: () => boolean = () => true): void {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			connection: "keep-alive",
		});
		res.write(": connected\n\n");
		const client: Client = {
			res,
			sessionId,
			isAuthorized,
			messagesSignature: sessionId ? this.messagesSignature(sessionId) : undefined,
		};
		this.clients.add(client);
		res.on("close", () => {
			this.clients.delete(client);
			if (this.clients.size === 0) this.stopTimer();
		});
		if (!this.timer) {
			this.lastSessions = this.sources.sessionsSignature();
			this.timer = setInterval(() => this.tick(), INTERVAL_MS);
		}
	}

	private tick(): void {
		const sessions = this.sources.sessionsSignature();
		const changed = sessions !== this.lastSessions;
		this.lastSessions = sessions;
		const ping = ++this.ticks % PING_EVERY_TICKS === 0;
		for (const client of this.clients) {
			if (!client.isAuthorized()) {
				client.res.end();
				this.clients.delete(client);
				continue;
			}
			if (changed) send(client.res, "sessions", {});
			if (client.sessionId) {
				const signature = this.messagesSignature(client.sessionId);
				if (signature !== client.messagesSignature) {
					client.messagesSignature = signature;
					send(client.res, "messages", { sessionId: client.sessionId });
				}
			}
			if (ping) send(client.res, "ping", {});
		}
	}

	private messagesSignature(sessionId: string): string {
		return `${fileSignature(this.sources.sessionFile(sessionId))}:${this.sources.leafId(sessionId) ?? ""}`;
	}

	close(): void {
		this.stopTimer();
		for (const client of this.clients) client.res.end();
		this.clients.clear();
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
