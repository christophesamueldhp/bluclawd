/**
 * The phone's HTTP API and the PWA's static files, on 127.0.0.1 only: the phone reaches it
 * through `tailscale serve`, never directly. Every /api route except POST /api/pair needs a
 * paired device's token: a bearer header, or `?token=` on the SSE stream, which EventSource
 * cannot give headers.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import type { InstanceSummary, PaneMessage } from "../ipc/protocol.ts";
import { RemoteEvents } from "./events.ts";
import type { RemoteStore } from "./pairing.ts";
import { findSession, remoteSessions } from "./sessions.ts";
import { loadTranscript } from "./transcript.ts";

export interface RemoteDeps {
	store: RemoteStore;
	listInstances(): InstanceSummary[];
	/** Queue a message for a pane's pi; false when no pane is registered as that id. */
	send(sessionId: string, message: PaneMessage): boolean;
	webDir: string;
}

export interface RemoteServer {
	/** The port actually bound (differs from the requested one only for port 0). */
	port: number;
	close(): Promise<void>;
}

export const BODY_MAX = 64 * 1024;
export const PROMPT_MAX = 32 * 1024;
const MESSAGES_DEFAULT = 50;
const MESSAGES_MAX = 200;

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".png": "image/png",
	".svg": "image/svg+xml",
};

const CSP =
	"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, code: string) {
		super(code);
		this.status = status;
	}
}

function json(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	res.end(JSON.stringify(body));
}

/** Reads the whole body even past the limit, so the 413 reaches a client still sending. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size <= BODY_MAX) chunks.push(chunk as Buffer);
	}
	if (size > BODY_MAX) throw new HttpError(413, "body_too_large");
	if (size === 0) return {};
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	} catch {
		throw new HttpError(400, "invalid_json");
	}
}

function bearer(req: IncomingMessage): string {
	const header = req.headers.authorization ?? "";
	return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/** Only a file that is in the web directory by that exact name: no path from the request is joined. */
function serveStatic(webDir: string, path: string, req: IncomingMessage, res: ServerResponse): void {
	const name = path === "/" ? "index.html" : path.slice(1);
	const type = CONTENT_TYPES[extname(name)];
	if ((req.method !== "GET" && req.method !== "HEAD") || !type || !readdirSync(webDir).includes(name)) {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
		return;
	}
	res.writeHead(200, {
		"content-type": type,
		"cache-control": "no-cache",
		"x-content-type-options": "nosniff",
		"content-security-policy": CSP,
	});
	res.end(req.method === "HEAD" ? undefined : readFileSync(join(webDir, name)));
}

async function handle(
	deps: RemoteDeps,
	events: RemoteEvents,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");
	const path = url.pathname;
	if (!path.startsWith("/api/")) return serveStatic(deps.webDir, path, req, res);
	// Not a "simple" CORS content type, so a cross-site page cannot POST here without a preflight, which is never granted.
	if (req.method === "POST" && !(req.headers["content-type"] ?? "").startsWith("application/json")) {
		return json(res, 415, { error: "unsupported_media_type" });
	}

	if (path === "/api/pair" && req.method === "POST") {
		const body = await readJson(req);
		const result = deps.store.claim(String(body.code ?? ""), String(body.deviceName ?? ""));
		return "token" in result ? json(res, 200, { token: result.token }) : json(res, 400, { error: result.error });
	}

	const token = path === "/api/events" ? (url.searchParams.get("token") ?? "") : bearer(req);
	if (!deps.store.authenticate(token)) return json(res, 401, { error: "unauthorized" });

	if (path === "/api/events" && req.method === "GET") {
		events.add(res, url.searchParams.get("session") ?? undefined, () => deps.store.authenticate(token) !== undefined);
		return;
	}
	if (path === "/api/sessions" && req.method === "GET") {
		return json(res, 200, { sessions: remoteSessions(deps.listInstances()) });
	}

	const match = /^\/api\/sessions\/([^/]+)\/(messages|prompt|abort)$/.exec(path);
	if (!match) return json(res, 404, { error: "not_found" });
	let id: string;
	try {
		id = decodeURIComponent(match[1]);
	} catch {
		return json(res, 404, { error: "unknown_session" });
	}
	const session = findSession(deps.listInstances(), id);
	if (!session) return json(res, 404, { error: "unknown_session" });
	const action = match[2];

	if (action === "messages") {
		if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
		const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10) || MESSAGES_DEFAULT;
		const limit = Math.min(Math.max(requested, 1), MESSAGES_MAX);
		return json(res, 200, { messages: loadTranscript(session.sessionFile, limit) });
	}

	if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
	const body = await readJson(req);
	let message: PaneMessage;
	if (action === "prompt") {
		const text = typeof body.text === "string" ? body.text : "";
		if (!text.trim()) return json(res, 400, { error: "empty_prompt" });
		if (text.length > PROMPT_MAX) return json(res, 413, { error: "prompt_too_large" });
		message = { type: "prompt", text };
	} else {
		message = { type: "abort" };
	}
	if (!session.running || !deps.send(id, message)) return json(res, 409, { error: "session_not_running" });
	return json(res, 202, { ok: true });
}

export function startRemoteServer(deps: RemoteDeps, port: number, host = "127.0.0.1"): Promise<RemoteServer> {
	const events = new RemoteEvents({
		// Sorted: agent view's order shifts with every heartbeat and is not a change.
		sessionsSignature: () =>
			JSON.stringify(remoteSessions(deps.listInstances()).sort((a, b) => a.id.localeCompare(b.id))),
		sessionFile: (id) => findSession(deps.listInstances(), id)?.sessionFile,
	});
	const server: Server = createServer((req, res) => {
		handle(deps, events, req, res).catch((error: unknown) => {
			if (res.headersSent) {
				res.end();
				return;
			}
			if (error instanceof HttpError) json(res, error.status, { error: error.message });
			else json(res, 500, { error: "internal_error" });
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			const address = server.address();
			resolve({
				port: typeof address === "object" && address ? address.port : port,
				close: () =>
					new Promise<void>((done) => {
						events.close();
						server.closeAllConnections();
						server.close(() => done());
					}),
			});
		});
	});
}
