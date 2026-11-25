import { statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { PING_MS } from "#remote-web/api.js";
import type { LiveSnapshot, PromptOutcome } from "../ipc/protocol.ts";

export interface EventSources {
	sessionsSignature(): string;
	session(sessionId: string): { sessionFile?: string; leafId?: string } | undefined;
	listed(): Set<string>;
	outcomes(sessionId: string): PromptOutcome[];
}

interface Client {
	res: ServerResponse;
	sessionId?: string;
	messagesSignature?: string;
	isAuthorized: () => boolean;
	deviceId?: string;
	streamId?: string;
	hidden?: true;
}

const INTERVAL_MS = 1000;
/** A named event this often keeps the stream alive and lets the phone notice a dead one. It is not a comment, so the phone sees it. */
const PING_EVERY_TICKS = PING_MS / INTERVAL_MS;

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
	private readonly lives = new Map<string, LiveSnapshot>();

	constructor(sources: EventSources) {
		this.sources = sources;
	}

	add(
		res: ServerResponse,
		sessionId?: string,
		isAuthorized: () => boolean = () => true,
		deviceId?: string,
		streamId?: string,
	): void {
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
			streamId,
			messagesSignature: sessionId ? this.messagesSignature(sessionId) : undefined,
		};
		this.clients.add(client);
		const live = sessionId ? this.lives.get(sessionId) : undefined;
		if (live) send(res, "live", { sessionId, live });
		if (sessionId) send(res, "outcomes", { sessionId, outcomes: this.sources.outcomes(sessionId) });
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

	watching(): Set<string> {
		const watched = new Set<string>();
		for (const client of this.clients) if (client.sessionId) watched.add(client.sessionId);
		return watched;
	}

	devicesInForeground(): Set<string> {
		const devices = new Set<string>();
		for (const client of this.clients) if (client.deviceId && !client.hidden) devices.add(client.deviceId);
		return devices;
	}

	hide(deviceId: string, streamId: string): void {
		for (const client of this.clients) {
			if (client.deviceId === deviceId && client.streamId === streamId) client.hidden = true;
		}
	}

	live(sessionId: string, live: LiveSnapshot | null, entryId?: string): void {
		if (live === null) this.lives.delete(sessionId);
		else {
			if (!this.watching().has(sessionId)) return;
			this.lives.set(sessionId, live);
		}
		for (const client of this.clients) {
			if (client.sessionId !== sessionId) continue;
			if (!client.isAuthorized()) this.drop(client);
			else send(client.res, "live", { sessionId, live, ...(entryId ? { entryId } : {}) });
		}
	}

	status(sessionId: string): void {
		let outcomes: PromptOutcome[] | undefined;
		for (const client of this.clients) {
			if (client.sessionId !== sessionId) continue;
			outcomes ??= this.sources.outcomes(sessionId);
			send(client.res, "status", { sessionId, outcomes });
		}
	}

	private drop(client: Client): void {
		client.res.end();
		this.clients.delete(client);
	}

	private endLivesOfUnlisted(): void {
		if (this.lives.size === 0) return;
		const listed = this.sources.listed();
		for (const id of [...this.lives.keys()]) if (!listed.has(id)) this.live(id, null);
	}

	private tick(): void {
		this.endLivesOfUnlisted();
		const sessions = this.sources.sessionsSignature();
		const changed = sessions !== this.lastSessions;
		this.lastSessions = sessions;
		const ping = ++this.ticks % PING_EVERY_TICKS === 0;
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
