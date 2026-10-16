/**
 * The phone's HTTP API and the PWA's static files, on 127.0.0.1 only: the phone reaches it
 * through `tailscale serve`, never directly. Every /api route except pairing (POST /api/pair and
 * /api/pair/handoff) needs a paired device's token: a bearer header, or `?token=` on the SSE
 * stream, which EventSource cannot give headers.
 */
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { stripAnsi } from "../ansi.ts";
import {
	type InstanceSummary,
	type LiveSnapshot,
	type PaneImage,
	type PaneLaunch,
	type PaneMessage,
	type PaneReport,
	PHONE_REFUSED_COMMANDS,
} from "../ipc/protocol.ts";
import { Tmux } from "../tmux.ts";
import { RemoteEvents } from "./events.ts";
import { type ClaimResult, type RemoteStore, SECRET_PATTERN } from "./pairing.ts";
import type { StatuslineSession, StatusSpan } from "./pistatusline.ts";
import { findSession, remoteSessions } from "./sessions.ts";
import { launchUsable, type SessionSpec } from "./spawn.ts";
import type { StatusLine } from "./statusline.ts";
import { loadImage, loadOutput, loadTranscript } from "./transcript.ts";
import { parseSubscription } from "./webpush.ts";

export interface RemoteDeps {
	store: RemoteStore;
	listInstances(): InstanceSummary[];
	/** Queue a message for a pane's pi; false when no pane is registered as that id. */
	send(sessionId: string, message: PaneMessage): boolean;
	/** How to start a pane's pi; undefined until a pane has registered. */
	launch(): PaneLaunch | undefined;
	/** Start a pane; returns its tmux session name, the id its row registers as. */
	startSession(spec: SessionSpec): string;
	/** A running pane's latest report. */
	report(sessionId: string): PaneReport | undefined;
	/** Name a stored row; false when there is none by that id. A pane's pi names its own. */
	renameInstance(sessionId: string, name: string): boolean;
	/** Pin or unpin a row, a pane's or a stored one; false when there is none by that id. */
	setPinned(sessionId: string, pinned: boolean): boolean;
	/** Remove a row; its .jsonl stays on disk. */
	deleteInstance(sessionId: string): boolean;
	/** What the status adds to a report for a session's directory: git state and usage limits. */
	statusLine?(cwd: string): Promise<StatusLine>;
	/** The pane's pistatusline rendered at `cols` columns, as styled spans per line. */
	renderStatusline?(session: StatuslineSession, report: PaneReport, cols: number): Promise<StatusSpan[][] | undefined>;
	/** Agent view's tmux server: what a pane shows, and keys typed into it. */
	tmux: Pick<Tmux, "screen" | "sendKeys" | "sendText">;
	webDir: string;
}

export interface RemoteServer {
	/** The port actually bound (differs from the requested one only for port 0). */
	port: number;
	/** The sessions a phone has open on its event stream. */
	watching(): Set<string>;
	/** The devices with an event stream open: the app is in the foreground there. */
	present(): Set<string>;
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
const IMAGE_MAX_AGE_S = 7 * 24 * 60 * 60;
const MESSAGES_MAX = 200;
/** `provider/id`; the id may itself contain slashes. Never a leading dash: it is an argument to pi. */
const MODEL_PATTERN = /^\w[\w.-]*\/[\w.:/@+-]+$/;
/** pi's entry ids (8 hex digits, or a whole UUID): one word on the pane's `/remote-control` line. */
const ENTRY_PATTERN = /^[0-9a-f-]{8,36}$/;
/** pi's `defaultProjectTrust` values, as Alt+M cycles them. */
const TRUST = ["always", "ask", "never"] as const;
const SCREEN_LINES = 60;
/** What a dialog needs. Never C-c or C-d, which quit pi; Escape still aborts a turn, as it does on the Mac. */
const KEYS = new Set(["Up", "Down", "Left", "Right", "Enter", "Escape", "Tab", "Space", "BSpace"]);
/** One at a time: Escape and the key after it would reach pi as one Alt chord. */
const KEYS_MAX = 1;
const TEXT_MAX = 1024;
const NAME_MAX = 100;
/** The widths a phone may ask the status line for. */
const COLS_MIN = 20;
const COLS_MAX = 200;
/** A task's output tail, as /tasks' detail view reads it. */
const TAIL_BYTES = 8192;
const TAIL_LINES = 10;
/** Never in typed text or a name: a control character would be a keystroke, or a terminal escape in agent view. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
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
		if (!CONTROL.test(text)) return { text };
	}
	throw new HttpError(400, "invalid_keys");
}

/** A task's output as /tasks' detail view shows it: the last lines of the file's last 8 KiB, empty
 *  ones dropped, without the escapes and control characters the command wrote for its terminal. */
function outputTail(file: string): { lines: string[]; size: number } | undefined {
	if (!isAbsolute(file)) return undefined;
	try {
		const size = statSync(file).size;
		const length = Math.min(size, TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		const fd = openSync(file, "r");
		try {
			readSync(fd, buffer, 0, length, size - length);
		} finally {
			closeSync(fd);
		}
		const lines = buffer
			.toString("utf8")
			.split("\n")
			.slice(-TAIL_LINES)
			.map((line) => stripAnsi(line).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""))
			.filter(Boolean);
		return { lines, size };
	} catch {
		return undefined;
	}
}

/** How to start a pane's pi, while its files are still there. */
function launchOf(deps: RemoteDeps): PaneLaunch | undefined {
	const launch = deps.launch();
	return launchUsable(launch) ? launch : undefined;
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
		const session = url.searchParams.get("session") ?? undefined;
		events.add(res, session, () => deps.store.authenticate(token) !== undefined, device.id);
		return;
	}
	if (path === "/api/handoff" && req.method === "POST") {
		return json(res, 200, { handoff: deps.store.issueHandoff(device.id) });
	}
	if (path === "/api/devices" && req.method === "GET") {
		const devices = deps.store.load().devices.map(({ id, name, createdAt, lastUsedAt }) => ({
			id,
			name,
			createdAt,
			lastUsedAt,
			current: id === device.id,
		}));
		return json(res, 200, { devices });
	}
	const removing = /^\/api\/devices\/([^/]+)$/.exec(path);
	if (removing && req.method === "DELETE") {
		let id: string;
		try {
			id = decodeURIComponent(removing[1]!);
		} catch {
			return json(res, 404, { error: "unknown_device" });
		}
		// The Mac is the root: a phone disconnects only itself; /remote-control removes the others.
		if (id !== device.id) return json(res, 403, { error: "forbidden" });
		return deps.store.revoke(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "unknown_device" });
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
	if (path === "/api/models" && req.method === "GET") {
		// What a new session can start with: the models the running panes offer.
		const models = new Map<string, PaneReport["models"][number]>();
		for (const instance of deps.listInstances()) {
			if (!instance.external) continue;
			for (const model of deps.report(instance.id)?.models ?? []) models.set(`${model.provider}/${model.id}`, model);
		}
		const sorted = [...models.values()].sort(
			(a, b) => a.provider.localeCompare(b.provider) || (a.name ?? a.id).localeCompare(b.name ?? b.id),
		);
		return json(res, 200, { models: sorted });
	}
	const removingSession = /^\/api\/sessions\/([^/]+)$/.exec(path);
	if (removingSession && req.method === "DELETE") {
		let id: string;
		try {
			id = decodeURIComponent(removingSession[1]!);
		} catch {
			return json(res, 404, { error: "unknown_session" });
		}
		const session = findSession(deps.listInstances(), id);
		if (!session) return json(res, 404, { error: "unknown_session" });
		// A pane's row comes back with its next heartbeat: its pi has to quit first.
		if (session.running) return json(res, 409, { error: "session_running" });
		return deps.deleteInstance(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "unknown_session" });
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

	const picture = /^\/api\/sessions\/([^/]+)\/images\/([0-9a-f-]{8,36})\/(\d{1,3})$/.exec(path);
	if (picture) {
		if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
		let pictured: string;
		try {
			pictured = decodeURIComponent(picture[1]);
		} catch {
			return json(res, 404, { error: "unknown_session" });
		}
		const session = findSession(deps.listInstances(), pictured);
		if (!session) return json(res, 404, { error: "unknown_session" });
		const image = loadImage(session.sessionFile, picture[2], Number(picture[3]), session.leafId);
		if (!image) return json(res, 404, { error: "unknown_image" });
		// Only a type the phone shows as an image, never one a browser would run (SVG, HTML).
		if (!Object.hasOwn(IMAGE_MAGIC, image.mimeType)) return json(res, 415, { error: "unsupported_image" });
		const bytes = Buffer.from(image.data, "base64");
		res.writeHead(200, {
			"content-type": image.mimeType,
			"content-length": bytes.length,
			// An entry never changes: the same id and position is the same image.
			"cache-control": `private, max-age=${IMAGE_MAX_AGE_S}`,
			"x-content-type-options": "nosniff",
		});
		res.end(bytes);
		return;
	}

	// A background task the pane reported: the tail of its output, or stopping it as /tasks' `x` does.
	const task = /^\/api\/sessions\/([^/]+)\/tasks\/([\w.:-]{1,64})\/(output|stop)$/.exec(path);
	if (task) {
		const [, encoded = "", taskId = "", verb] = task;
		if (req.method !== (verb === "output" ? "GET" : "POST")) return json(res, 405, { error: "method_not_allowed" });
		if (verb === "stop") await readJson(req);
		let taskOf: string;
		try {
			taskOf = decodeURIComponent(encoded);
		} catch {
			return json(res, 404, { error: "unknown_session" });
		}
		const session = findSession(deps.listInstances(), taskOf);
		if (!session) return json(res, 404, { error: "unknown_session" });
		const known = session.running ? deps.report(taskOf)?.tasks?.find((t) => t.id === taskId) : undefined;
		if (!known) return json(res, 404, { error: "unknown_task" });
		if (verb === "output") {
			const tail = known.outputFile ? outputTail(known.outputFile) : undefined;
			return tail ? json(res, 200, tail) : json(res, 404, { error: "no_output" });
		}
		if (!deps.send(taskOf, { type: "stop_task", id: taskId }))
			return json(res, 409, { error: "session_not_running" });
		return json(res, 202, { ok: true });
	}

	// A tool result's whole output: the transcript cuts it to TEXT_MAX.
	const output = /^\/api\/sessions\/([^/]+)\/messages\/([0-9a-f-]{8,36})\/output$/.exec(path);
	if (output) {
		if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
		let outputOf: string;
		try {
			outputOf = decodeURIComponent(output[1]);
		} catch {
			return json(res, 404, { error: "unknown_session" });
		}
		const session = findSession(deps.listInstances(), outputOf);
		if (!session) return json(res, 404, { error: "unknown_session" });
		const result = loadOutput(session.sessionFile, output[2], session.leafId);
		return result ? json(res, 200, result) : json(res, 404, { error: "unknown_entry" });
	}

	const match =
		/^\/api\/sessions\/([^/]+)\/(messages|status|commands|screen|keys|prompt|abort|model|thinking|trust|compact|tree|fork|clone|rename|pin)$/.exec(
			path,
		);
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
		if (!report) return json(res, 404, { error: "no_status" });
		// Fetched again after every report: the commands, which rarely change, have their own route.
		const { commands: _commands, pistatusline: _paths, tasks, ...shown } = report;
		// A task's output file stays here: the phone asks for its tail.
		const listed = tasks?.map(({ outputFile, ...task }) => ({ ...task, ...(outputFile ? { output: true } : {}) }));
		// pistatusline's own lines at the phone's width, which show git and the usage limits themselves.
		const cols = /^\d{1,3}$/.test(url.searchParams.get("cols") ?? "") ? Number(url.searchParams.get("cols")) : 0;
		const pane = cols ? deps.listInstances().find((i) => i.id === id && i.external) : undefined;
		const lines =
			pane &&
			(await deps.renderStatusline?.(
				{ ...found, id, createdAt: pane.createdAt, sessionId: pane.sessionId },
				report,
				Math.min(Math.max(cols, COLS_MIN), COLS_MAX),
			));
		const extra = lines ? { statusline: { lines } } : await deps.statusLine?.(found.cwd);
		return json(res, 200, { report: { ...shown, ...(listed ? { tasks: listed } : {}), ...extra } });
	}
	if (action === "commands") {
		if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
		const report = found.running ? deps.report(id) : undefined;
		if (!report) return json(res, 404, { error: "no_status" });
		return json(res, 200, { commands: report.commands ?? [] });
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
	// Looked up again after the body, which may have taken a while.
	const session = findSession(deps.listInstances(), id);
	if (!session) return json(res, 409, { error: "session_not_running" });
	// A pane from an older bluclawd sends no report, and would ignore what only a newer one runs.
	const anyPane = action === "prompt" || action === "abort" || action === "rename" || action === "pin";
	if (!anyPane && session.running && !deps.report(id)) {
		return json(res, 409, { error: "pane_too_old" });
	}
	let message: PaneMessage;
	if (action === "prompt") {
		const text = promptIn(body, "text");
		const images = imagesIn(body);
		// A slash command, as pi reads one: typed into the pane's prompt (a phone's images never are).
		const command =
			!images && text.trimStart().startsWith("/") ? text.trimStart().slice(1).split(/\s/)[0] : undefined;
		if (command !== undefined && PHONE_REFUSED_COMMANDS.has(command)) {
			return json(res, 400, { error: "command_refused" });
		}
		// A pane that reports its commands types them in; an older one runs them as a prompt.
		if (command !== undefined && session.running && deps.report(id)?.commands) {
			// Only into an idle, empty prompt, which the pane checks again: its heartbeat may be 3s old.
			if (session.busy) return json(res, 409, { error: "session_busy" });
			if (session.draft) return json(res, 409, { error: "unsent_draft" });
			message = { type: "command", text };
		} else message = images ? { type: "prompt", text, images } : { type: "prompt", text };
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
	} else if (action === "thinking") {
		if (!session.running) return json(res, 409, { error: "session_not_running" });
		// Only a level the pane offered for its model: none when the model does not reason.
		const { level } = body;
		if (typeof level !== "string" || !deps.report(id)?.thinkingLevels?.includes(level)) {
			return json(res, 400, { error: "invalid_thinking" });
		}
		message = { type: "set_thinking", level };
	} else if (action === "trust") {
		if (!session.running) return json(res, 409, { error: "session_not_running" });
		const trust = TRUST.find((value) => value === body.trust);
		if (!trust) return json(res, 400, { error: "invalid_trust" });
		// A pane that reports no trust mode is too old to set one.
		if (deps.report(id)?.trust === undefined) return json(res, 409, { error: "pane_too_old" });
		message = { type: "set_trust", trust };
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
	} else if (action === "rename") {
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name || name.length > NAME_MAX || CONTROL.test(name)) return json(res, 400, { error: "invalid_name" });
		// A pane's pi names its session, as agent view's rename does; a stored row is the daemon's.
		if (!session.running) {
			return deps.renameInstance(id, name)
				? json(res, 200, { ok: true })
				: json(res, 404, { error: "unknown_session" });
		}
		message = { type: "rename", name };
	} else if (action === "pin") {
		if (typeof body.pinned !== "boolean") return json(res, 400, { error: "invalid_pinned" });
		return deps.setPinned(id, body.pinned)
			? json(res, 200, { ok: true })
			: json(res, 404, { error: "unknown_session" });
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
		session: (id) => findSession(deps.listInstances(), id),
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
				present: () => events.present(),
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
