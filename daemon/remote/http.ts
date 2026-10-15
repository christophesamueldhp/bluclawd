/**
 * The phone's HTTP API and the PWA's static files, on 127.0.0.1 only: the phone reaches it
 * through `tailscale serve`, never directly. Every /api route except pairing (POST /api/pair and
 * /api/pair/handoff) needs a paired device's token: a bearer header, or `?token=` on the SSE
 * stream, which EventSource cannot give headers.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { stripAnsi } from "../ansi.ts";
import type { InstanceSummary, LiveSnapshot, PaneImage, PaneLaunch, PaneMessage, PaneReport } from "../ipc/protocol.ts";
import { Tmux } from "../tmux.ts";
import { RemoteEvents } from "./events.ts";
import { type ClaimResult, type RemoteStore, SECRET_PATTERN } from "./pairing.ts";
import { findSession, remoteSessions } from "./sessions.ts";
import { launchUsable, type SessionSpec } from "./spawn.ts";
import { loadTranscript } from "./transcript.ts";
import { parseSubscription } from "./webpush.ts";

export interface RemoteDeps {
	store: RemoteStore;
	listInstances(): InstanceSummary[];
	/** Queue a message for a pane's pi; false when no pane is registered as that id. */
	send(sessionId: string, message: PaneMessage): boolean;
	/** How to start a pane's pi; undefined until a pane has registered. */
	launch(): PaneLaunch | undefined;
	/** Start a pane; returns its tmux session name, the id its row registers as. `replaces`: the
	 *  stored row it resumes, which goes once the pane registers. */
	startSession(spec: SessionSpec, replaces?: string): string;
	/** A pane started to resume this stored row has not registered yet. */
	resuming(storedId: string): boolean;
	/** A running pane's latest report. */
	report(sessionId: string): PaneReport | undefined;
	/** Agent view's tmux server: what a pane shows, and keys typed into it. */
	tmux: Pick<Tmux, "screen" | "sendKeys" | "sendText">;
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
export const IMAGES_MAX = 4;
/** Decoded; the phone app sends at most about 1.4 MB. */
export const IMAGE_MAX = 2 * 1024 * 1024;
const IMAGE_BASE64_MAX = Math.ceil(IMAGE_MAX / 3) * 4;
/** A prompt's body: its text and its images, base64. */
export const PROMPT_BODY_MAX = BODY_MAX + IMAGES_MAX * IMAGE_BASE64_MAX;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** What each image type's bytes start with. */
const IMAGE_MAGIC: Record<PaneImage["mimeType"], (bytes: Buffer) => boolean> = {
	"image/jpeg": (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
	"image/png": (bytes) => bytes.subarray(0, 8).equals(PNG_SIGNATURE),
	"image/gif": (bytes) => /^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6)),
	"image/webp": (bytes) => bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP",
};
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MESSAGES_DEFAULT = 50;
const MESSAGES_MAX = 200;
/** `provider/id`; the id may itself contain slashes. Never a leading dash: it is an argument to pi. */
const MODEL_PATTERN = /^\w[\w.-]*\/[\w.:/@+-]+$/;
/** pi's entry ids (8 hex digits, or a whole UUID): one word on the pane's `/remote-control` line. */
const ENTRY_PATTERN = /^[0-9a-f-]{8,36}$/;
const SCREEN_LINES = 60;
/** What a dialog needs. Never C-c or C-d, which quit pi; Escape still aborts a turn, as it does on the Mac. */
const KEYS = new Set(["Up", "Down", "Left", "Right", "Enter", "Escape", "Tab", "Space", "BSpace"]);
/** One at a time: Escape and the key after it would reach pi as one Alt chord. */
const KEYS_MAX = 1;
const TEXT_MAX = 1024;
/** Against DNS rebinding: a page whose name resolves to 127.0.0.1 still sends its own name. Tailscale
 *  serve forwards the tailnet name; a loopback name is the Mac itself. */
const HOST_PATTERN = /^(127\.0\.0\.1|localhost|\[::1\]|([a-z0-9-]+\.)+ts\.net)(:\d+)?$/i;

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
async function readJson(req: IncomingMessage, max = BODY_MAX): Promise<Record<string, unknown>> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size <= max) chunks.push(chunk as Buffer);
	}
	if (size > max) throw new HttpError(413, "body_too_large");
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

/** A prompt's images, if it has any: each base64 of the type it says it is. */
function imagesIn(body: Record<string, unknown>): PaneImage[] | undefined {
	const { images } = body;
	if (images === undefined || (Array.isArray(images) && images.length === 0)) return undefined;
	if (!Array.isArray(images) || images.length > IMAGES_MAX) throw new HttpError(400, "invalid_image");
	return images.map((image: unknown) => {
		const { mimeType, data } = (image ?? {}) as Record<string, unknown>;
		const known = typeof mimeType === "string" && Object.hasOwn(IMAGE_MAGIC, mimeType);
		if (!known || typeof data !== "string") throw new HttpError(400, "invalid_image");
		if (data.length > IMAGE_BASE64_MAX) throw new HttpError(413, "image_too_large");
		if (data.length % 4 !== 0 || !BASE64.test(data)) throw new HttpError(400, "invalid_image");
		const bytes = Buffer.from(data, "base64");
		if (bytes.length > IMAGE_MAX) throw new HttpError(413, "image_too_large");
		const type = mimeType as PaneImage["mimeType"];
		if (!IMAGE_MAGIC[type](bytes)) throw new HttpError(400, "invalid_image");
		return { mimeType: type, data };
	});
}

/** Keys from the allowlist, or printable text: a control character in it would be a keystroke past the allowlist. */
function keysIn(body: Record<string, unknown>): { keys: string[] } | { text: string } {
	const { keys, text } = body;
	if (text === undefined && Array.isArray(keys) && keys.length > 0 && keys.length <= KEYS_MAX) {
		if (keys.every((key) => typeof key === "string" && KEYS.has(key))) return { keys };
	}
	if (keys === undefined && typeof text === "string" && text.length > 0 && text.length <= TEXT_MAX) {
		if (!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) return { text };
	}
	throw new HttpError(400, "invalid_keys");
}

/** How to start a pane's pi, while its files are still there. */
function launchOf(deps: RemoteDeps): PaneLaunch | undefined {
	const launch = deps.launch();
	return launchUsable(launch) ? launch : undefined;
}

function start(deps: RemoteDeps, spec: SessionSpec, replaces?: string): string {
	try {
		return deps.startSession(spec, replaces);
	} catch {
		throw new HttpError(500, "start_failed");
	}
}

function bearer(req: IncomingMessage): string {
	const header = req.headers.authorization ?? "";
	return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/** Only a file that is in the web directory by that exact name: no path from the request is joined. */
function serveStatic(webDir: string, url: URL, req: IncomingMessage, res: ServerResponse): void {
	const path = url.pathname;
	const name = path === "/" ? "index.html" : path.slice(1);
	const type = CONTENT_TYPES[extname(name)];
	if ((req.method !== "GET" && req.method !== "HEAD") || !type || !readdirSync(webDir).includes(name)) {
		res.writeHead(404, { "content-type": "text/plain" });
		res.end("not found");
		return;
	}
	// The Home Screen app Safari adds opens at its manifest's start_url: the page asks for this one
	// with its device's handoff, which pairs that app (web/app.js). Only its shape is checked here.
	const handoff = url.searchParams.get("handoff") ?? "";
	const start = name === "manifest.webmanifest" && SECRET_PATTERN.test(handoff) ? `/#handoff=${handoff}` : undefined;
	res.writeHead(200, {
		"content-type": type,
		"cache-control": start ? "no-store" : "no-cache",
		"x-content-type-options": "nosniff",
		"content-security-policy": CSP,
	});
	const body = readFileSync(join(webDir, name));
	if (req.method === "HEAD") res.end();
	else res.end(start ? JSON.stringify({ ...JSON.parse(body.toString("utf8")), start_url: start }) : body);
}

function claimed(res: ServerResponse, result: ClaimResult): void {
	if ("token" in result) json(res, 200, { token: result.token });
	else json(res, 400, { error: result.error });
}

async function handle(
	deps: RemoteDeps,
	events: RemoteEvents,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	if (!HOST_PATTERN.test(req.headers.host ?? "")) return json(res, 421, { error: "bad_host" });
	const url = new URL(req.url ?? "/", "http://localhost");
	const path = url.pathname;
	if (!path.startsWith("/api/")) return serveStatic(deps.webDir, url, req, res);
	// Not a "simple" CORS content type, so a cross-site page cannot POST here without a preflight, which is never granted.
	if (req.method === "POST" && !(req.headers["content-type"] ?? "").startsWith("application/json")) {
		return json(res, 415, { error: "unsupported_media_type" });
	}

	if (path === "/api/pair" && req.method === "POST") {
		const body = await readJson(req);
		const name = String(body.deviceName ?? "");
		if (typeof body.secret === "string") return claimed(res, deps.store.claimSecret(body.secret, name));
		return claimed(res, deps.store.claim(String(body.code ?? ""), name));
	}
	if (path === "/api/pair/handoff" && req.method === "POST") {
		const body = await readJson(req);
		return claimed(res, deps.store.exchangeHandoff(String(body.handoff ?? ""), String(body.deviceName ?? "")));
	}

	const token = path === "/api/events" ? (url.searchParams.get("token") ?? "") : bearer(req);
	const device = deps.store.authenticate(token);
	if (!device) return json(res, 401, { error: "unauthorized" });

	if (path === "/api/events" && req.method === "GET") {
		events.add(res, url.searchParams.get("session") ?? undefined, () => deps.store.authenticate(token) !== undefined);
		return;
	}
	if (path === "/api/handoff" && req.method === "POST") {
		return json(res, 200, { handoff: deps.store.issueHandoff(device.id) });
	}
	if (path === "/api/sessions" && req.method === "GET") {
		return json(res, 200, { sessions: remoteSessions(deps.listInstances()) });
	}
	if (path === "/api/sessions" && req.method === "POST") {
		const body = await readJson(req);
		const cwd = typeof body.cwd === "string" ? expandHome(body.cwd) : "";
		// pi takes a new session's first prompt as an argument, which carries no images.
		if (body.images !== undefined) return json(res, 400, { error: "images_need_running" });
		if (!isDirectory(cwd)) return json(res, 400, { error: "invalid_cwd" });
		const task = promptIn(body, "task");
		const model = body.model;
		if (model !== undefined && (typeof model !== "string" || !MODEL_PATTERN.test(model))) {
			return json(res, 400, { error: "invalid_model" });
		}
		const launch = launchOf(deps);
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

	const match =
		/^\/api\/sessions\/([^/]+)\/(messages|status|screen|keys|prompt|abort|model|compact|tree|fork|clone)$/.exec(path);
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
		const before = url.searchParams.get("before") ?? undefined;
		if (before !== undefined && !ENTRY_PATTERN.test(before)) return json(res, 400, { error: "invalid_entry" });
		// One past the page tells whether older messages are left.
		const page = loadTranscript(found.sessionFile, limit + 1, found.leafId, before);
		return json(res, 200, { messages: page.slice(-limit), more: page.length > limit });
	}
	if (action === "status") {
		if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
		const report = found.running ? deps.report(id) : undefined;
		return report ? json(res, 200, { report }) : json(res, 404, { error: "no_status" });
	}
	if (action === "screen" || action === "keys") {
		if (req.method !== (action === "screen" ? "GET" : "POST")) return json(res, 405, { error: "method_not_allowed" });
		const input = action === "keys" ? keysIn(await readJson(req)) : undefined;
		// The tmux session its pi registered from, never a name from the request; looked up again after a body.
		const pane = (input ? findSession(deps.listInstances(), id) : found)?.pane;
		if (!pane) return json(res, 404, { error: "unknown_session" });
		let lines: string[] = [];
		try {
			if (!input) lines = deps.tmux.screen(pane, SCREEN_LINES);
			else if ("keys" in input) deps.tmux.sendKeys(pane, input.keys);
			else deps.tmux.sendText(pane, input.text);
		} catch (error) {
			// Its tmux session ended before its pi unregistered; any other failure is the Mac's.
			if (!Tmux.gone(error)) throw error;
			return json(res, 404, { error: "unknown_session" });
		}
		// A main-screen pane gives that much history above its screen; a tall screen may be longer still.
		return json(res, 200, input ? { ok: true } : { lines: lines.slice(-SCREEN_LINES).map(stripAnsi) });
	}

	if (req.method !== "POST") return json(res, 405, { error: "method_not_allowed" });
	const body = await readJson(req, action === "prompt" ? PROMPT_BODY_MAX : BODY_MAX);
	// Looked up again after the body: a concurrent reply may have resumed this row meanwhile, and
	// from the resuming check to the start nothing awaits, so a stored row starts one pane only.
	const session = findSession(deps.listInstances(), id);
	if (!session) return json(res, 409, { error: "session_not_running" });
	// A pane from an older bluclawd sends no report, and would ignore what only a newer one runs.
	if (action !== "prompt" && action !== "abort" && session.running && !deps.report(id)) {
		return json(res, 409, { error: "pane_too_old" });
	}
	let message: PaneMessage;
	if (action === "prompt") {
		const text = promptIn(body, "text");
		const images = imagesIn(body);
		// A stored row has no process: it resumes as agent view's peek reply resumes it.
		if (!session.running && session.sessionFile) {
			// Its first prompt is an argument to pi, as a new session's is.
			if (images) return json(res, 400, { error: "images_need_running" });
			const launch = launchOf(deps);
			if (!launch) return json(res, 503, { error: "no_launch" });
			// Its row stays until the pane registers, so a pane that never does leaves it as it was.
			if (deps.resuming(id)) return json(res, 409, { error: "session_busy" });
			const pane = start(deps, { cwd: session.cwd, task: text, sessionFile: session.sessionFile, launch }, id);
			return json(res, 202, { ok: true, pane });
		}
		message = images ? { type: "prompt", text, images } : { type: "prompt", text };
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
		if (session.running && session.busy) return json(res, 409, { error: "session_busy" });
		message = { type: "compact" };
	} else if (action === "tree" || action === "fork") {
		const { entryId } = body;
		if (typeof entryId !== "string" || !ENTRY_PATTERN.test(entryId)) {
			return json(res, 400, { error: "invalid_entry" });
		}
		if (!session.running) return json(res, 409, { error: "session_not_running" });
		if (session.busy) return json(res, 409, { error: "session_busy" });
		// What the phone shows: the active branch, from the leaf the pane reports. Forking "before"
		// is editing a message of yours, the only entry pi forks before.
		const target = loadTranscript(session.sessionFile, Number.MAX_SAFE_INTEGER, session.leafId).find(
			(m) => m.id === entryId,
		);
		if (!target || (action === "fork" && target.kind !== "user")) return json(res, 400, { error: "invalid_entry" });
		message = { type: action, entryId };
	} else if (action === "clone") {
		if (session.running && session.busy) return json(res, 409, { error: "session_busy" });
		message = { type: "clone" };
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
		listed: () => new Set(deps.listInstances().map((i) => i.id)),
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
