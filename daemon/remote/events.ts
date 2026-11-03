/**
 * Server-Sent Events for the phone. Mostly "refetch" signals with no content: `sessions` when the
 * list changes, `messages` when the .jsonl of the session a client has open changes or its pane
 * moves to another leaf, `status` when its pane's report changes. The exception is `live`: the reply a pane is streaming, sent only to
 * the clients that have its session open.
 * Polled once a second while any client is connected, which is also when a revoked device is cut off; the registry itself changes on the panes'
 * 3s heartbeats.
 * A device with a stream open has the app in the foreground, so it gets no push: the phone closes
 * its stream when hidden (visibilitychange) and opens it again when visible. One a phone dropped
 * without closing (no network) counts until a write to it fails.
 */
import { statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { LiveSnapshot } from "../ipc/protocol.ts";

export interface EventSources {
	/** Changes exactly when the phone's session list would. */
	sessionsSignature(): string;
	/** A session's file and the leaf its pane is on: one lookup for both, each tick. */
	session(sessionId: string): { sessionFile?: string; leafId?: string } | undefined;
	/** The ids of the sessions listed now. */
	listed(): Set<string>;
}

interface Client {
	res: ServerResponse;
	sessionId?: string;
	messagesSignature?: string;
	isAuthorized: () => boolean;
	deviceId?: string;
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
	/** Per watched session: what a client that opens it mid-reply is sent at once. */
	private readonly lives = new Map<string, LiveSnapshot>();

	constructor(sources: EventSources) {
		this.sources = sources;
	}

	/**
	 * `sessionId`: the session the client has open, whose file it is told about.
	 * `isAuthorized`: checked every tick; a client that fails it is disconnected.
	 * `deviceId`: the paired device whose stream it is.
	 */
	add(res: ServerResponse, sessionId?: string, isAuthorized: () => boolean = () => true, deviceId?: string): void {
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
			deviceId,
			messagesSignature: sessionId ? this.messagesSignature(sessionId) : undefined,
		};
		this.clients.add(client);
		const live = sessionId ? this.lives.get(sessionId) : undefined;
		if (live) send(res, "live", { sessionId, live });
		res.on("close", () => {
			this.clients.delete(client);
			if (sessionId && !this.watching().has(sessionId)) this.lives.delete(sessionId);
			if (this.clients.size === 0) this.stopTimer();
		});
		if (!this.timer) {
			this.lastSessions = this.sources.sessionsSignature();
			this.timer = setInterval(() => this.tick(), INTERVAL_MS);
		}
	}

	/** The sessions some client has open. */
	watching(): Set<string> {
		const watched = new Set<string>();
		for (const client of this.clients) if (client.sessionId) watched.add(client.sessionId);
		return watched;
	}

	/** The devices with a stream open, on any screen: the app is in the foreground there, as the
	 *  phone closes its stream while hidden and opens it again once visible. */
	present(): Set<string> {
		const devices = new Set<string>();
		for (const client of this.clients) if (client.deviceId) devices.add(client.deviceId);
		return devices;
	}

	/**
	 * A pane's reply so far, or null once it is finished, with the transcript entry it became when
	 * the pane knows it; a snapshot is ignored for a session no client has open.
	 * A null is always sent: a phone may still show a snapshot forgotten here, e.g. when its stream
	 * reconnected (the last watcher leaving drops it) or the daemon restarted.
	 */
	live(sessionId: string, live: LiveSnapshot | null, entryId?: string): void {
		if (live === null) this.lives.delete(sessionId);
		else {
			if (!this.watching().has(sessionId)) return;
			this.lives.set(sessionId, live);
		}
		for (const client of this.clients) {
			if (client.sessionId !== sessionId) continue;
			// Checked here too: the reply is content, and the tick that cuts a revoked device off is up to 1s away.
			if (!client.isAuthorized()) this.drop(client);
			else send(client.res, "live", { sessionId, live, ...(entryId ? { entryId } : {}) });
		}
	}

	/** The session's pane sent a new report, which the phone fetches if it shows it. */
	status(sessionId: string): void {
		for (const client of this.clients) if (client.sessionId === sessionId) send(client.res, "status", { sessionId });
	}

	private drop(client: Client): void {
		client.res.end();
		this.clients.delete(client);
	}

	private tick(): void {
		if (this.lives.size > 0) {
			// A pane that died mid-reply never sends the null that ends it.
			const listed = this.sources.listed();
			for (const id of [...this.lives.keys()]) if (!listed.has(id)) this.live(id, null);
		}
		const sessions = this.sources.sessionsSignature();
		const changed = sessions !== this.lastSessions;
		this.lastSessions = sessions;
		const ping = ++this.ticks % PING_EVERY_TICKS === 0;
		// Once per session a tick, however many clients have it open: each lookup lists every row.
		const signatures = new Map<string, string>();
		for (const client of this.clients) {
			if (!client.isAuthorized()) {
				this.drop(client);
				continue;
			}
			if (changed) send(client.res, "sessions", {});
			if (client.sessionId) {
				let signature = signatures.get(client.sessionId);
				if (signature === undefined) {
					signature = this.messagesSignature(client.sessionId);
					signatures.set(client.sessionId, signature);
				}
				if (signature !== client.messagesSignature) {
					client.messagesSignature = signature;
					send(client.res, "messages", { sessionId: client.sessionId });
				}
			}
			if (ping) send(client.res, "ping", {});
		}
	}

	private messagesSignature(sessionId: string): string {
		const session = this.sources.session(sessionId);
		return `${fileSignature(session?.sessionFile)}:${session?.leafId ?? ""}`;
	}

	close(): void {
		this.stopTimer();
		for (const client of this.clients) client.res.end();
		this.clients.clear();
		this.lives.clear();
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
