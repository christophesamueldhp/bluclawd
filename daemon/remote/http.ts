/**
 * The phone's HTTP API and the PWA's static files, on 127.0.0.1 only: the phone reaches it
 * through `tailscale serve`, never directly. Every /api route except POST /api/pair needs a
 * paired device's token: a bearer header, or `?token=` on the SSE stream, which EventSource
 * cannot give headers.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import type { InstanceSummary, LiveSnapshot, PaneLaunch, PaneMessage, PaneReport } from "../ipc/protocol.ts";
import { RemoteEvents } from "./events.ts";
import type { RemoteStore } from "./pairing.ts";
import { findSession, remoteSessions } from "./sessions.ts";
import type { SessionSpec } from "./spawn.ts";
import { loadTranscript } from "./transcript.ts";
import { parseSubscription } from "./webpush.ts";

export interface RemoteDeps {
	store: RemoteStore;
	listInstances(): InstanceSummary[];
	/** Queue a message for a pane's pi; false when no pane is registered as that id. */
	send(sessionId: string, message: PaneMessage): boolean;
	deleteInstance(sessionId: string): boolean;
	/** How to start a pane's pi; undefined until a pane has registered. */
	launch(): PaneLaunch | undefined;
	/** Start a pane; returns its tmux session name, the id its row registers as. */
	startSession(spec: SessionSpec): string;
	/** A running pane's latest report. */
	report(sessionId: string): PaneReport | undefined;
	webDir: string;
}

export interface RemoteServer {
	/** The port actually bound (differs from the requested one only for port 0). */
	port: number;
	/** The sessions a phone has open on its event stream. */
	watching(): Set<string>;
	/** Push a pane's reply in progress (null: finished) to the phones that have its session open. */
	live(sessionId: string, live: LiveSnapshot | null): void;
	/** Tell the phones that have this session open its report changed. */
	status(sessionId: string): void;
	close(): Promise<void>;
}

export const BODY_MAX = 64 * 1024;
export const PROMPT_MAX = 32 * 1024;
const MESSAGES_DEFAULT = 50;
const MESSAGES_MAX = 200;
/** `provider/id`; the id may itself contain slashes. Never a leading dash: it is an argument to pi. */
const MODEL_PATTERN = /^\w[\w.-]*\/[\w.:/@+-]+$/;

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

function isDirectory(path: string): boolean {
	try {
		return isAbsolute(path) && statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** A phone has no shell to expand `~` for it. */
function expandHome(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function promptIn(body: Record<string, unknown>, key: string): string {
	const text = typeof body[key] === "string" ? body[key] : "";
	if (!text.trim()) throw new HttpError(400, "empty_prompt");
	if (text.length > PROMPT_MAX) throw new HttpError(413, "prompt_too_large");
	return text;
}

function start(deps: RemoteDeps, spec: SessionSpec): string {
	try {
		return deps.startSession(spec);
	} catch {
		throw new HttpError(500, "start_failed");
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
	const device = deps.store.authenticate(token);
	if (!device) return json(res, 401, { error: "unauthorized" });

	if (path === "/api/events" && req.method === "GET") {
		events.add(res, url.searchParams.get("session") ?? undefined, () => deps.store.authenticate(token) !== undefined);
		return;
	}
	if (path === "/api/sessions" && req.method === "GET") {
		return json(res, 200, { sessions: remoteSessions(deps.listInstances()) });
	}
	if (path === "/api/sessions" && req.method === "POST") {
		const body = await readJson(req);
		const cwd = typeof body.cwd === "string" ? expandHome(body.cwd) : "";
		if (!isDirectory(cwd)) return json(res, 400, { error: "invalid_cwd" });
		const task = promptIn(body, "task");
		const model = body.model;
		if (model !== undefined && (typeof model !== "string" || !MODEL_PATTERN.test(model))) {
			return json(res, 400, { error: "invalid_model" });
		}
		const launch = deps.launch();
		if (!launch) return json(res, 503, { error: "no_launch" });
		const pane = start(deps, {
			cwd,
			task: task.trim(),
			...(typeof model === "string" ? { model } : {}),
			launch,
		});
		return json(res, 201, { pane });
	}
	if (path === "/api/directories" && req.method === "GET") {
		const sessions = remoteSessions(deps.listInstances()).sort((a, b) =>
			(b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
		);
		return json(res, 200, { directories: [...new Set(sessions.map((s) => s.cwd))] });
	}

	if (path === "/api/push/key" && req.method === "GET") {
		// `subscribed`: a re-paired device keeps its notification permission but has no subscription here.
		return json(res, 200, { publicKey: deps.store.vapidKeys().publicKey, subscribed: device.push !== undefined });
	}
	if (path === "/api/push/subscribe" && req.method === "POST") {
		const push = parseSubscription(await readJson(req));
		if (!push) return json(res, 400, { error: "invalid_subscription" });
		deps.store.setPush(device.id, push);
		return json(res, 200, { ok: true });
	}
	if (path === "/api/push/unsubscribe" && req.method === "POST") {
		deps.store.setPush(device.id, undefined);
		return json(res, 200, { ok: true });
	}

	const match = /^\/api\/sessions\/([^/]+)\/(messages|status|prompt|abort|model|compact)$/.exec(path);
	if (!match) return json(res, 404, { error: "not_found" });
	let id: string;
	try {
		id = decodeURIComponent(match[1]);
	} catch {
		return json(res, 404, { error: "unknown_session" });
	}
	const found = findSession(deps.listInstances(), id);
	if (!found) return json(res, 404, { error: "unknown_session" });
	const action = match[2];

	if (action === "messages") {
		if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
		const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10) || MESSAGES_DEFAULT;
		const limit = Math.min(Math.max(requested, 1), MESSAGES_MAX);
		return json(res, 200, { messages: loadTranscript(found.sessionFile, limit, found.leafId) });
	}
	if (action === "status") {
		if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
		const report = found.running ? deps.report(id) : undefined;
		return report ? json(res, 200, { report }) : json(res, 404, { error: "no_status" });
	}

	if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
	const body = await readJson(req);
	// Looked up again after the body: a concurrent reply may have resumed this row meanwhile, and
	// from here to deleteInstance nothing awaits, so a stored row starts one pane only.
	const session = findSession(deps.listInstances(), id);
	if (!session) return json(res, 409, { error: "session_not_running" });
	let message: PaneMessage;
	if (action === "prompt") {
		const text = promptIn(body, "text");
		// A stored row has no process: it resumes as agent view's peek reply resumes it.
		if (!session.running && session.sessionFile) {
			const launch = deps.launch();
			if (!launch) return json(res, 503, { error: "no_launch" });
			const pane = start(deps, { cwd: session.cwd, task: text, sessionFile: session.sessionFile, launch });
			deps.deleteInstance(id);
			return json(res, 202, { ok: true, pane });
		}
		message = { type: "prompt", text };
	} else if (action === "model") {
		const { provider, id: modelId } = body;
		if (typeof provider !== "string" || typeof modelId !== "string" || !provider || !modelId) {
			return json(res, 400, { error: "invalid_model" });
		}
		if (!session.running) return json(res, 409, { error: "session_not_running" });
		// Only a model the pane offered: the phone picks from that list, nothing else reaches the pane.
		const offered = deps.report(id)?.models.some((m) => m.provider === provider && m.id === modelId);
		if (!offered) return json(res, 400, { error: "invalid_model" });
		message = { type: "set_model", provider, id: modelId };
	} else if (action === "compact") {
		if (session.running && session.working) return json(res, 409, { error: "session_busy" });
		message = { type: "compact" };
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
		leafId: (id) => findSession(deps.listInstances(), id)?.leafId,
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
				watching: () => events.watching(),
				live: (id, live) => events.live(id, live),
				status: (id) => events.status(id),
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
