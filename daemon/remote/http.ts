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
import type { InstanceSummary, LiveSnapshot, PaneImage, PaneLaunch, PaneMessage, PaneReport } from "../ipc/protocol.ts";
import { labelFromTask } from "../rows.ts";
import { RemoteEvents } from "./events.ts";
import { type ClaimResult, type RemoteStore, SECRET_PATTERN } from "./pairing.ts";
import {
	commandName,
	decide,
	type PhoneAction,
	type PhoneError,
	type PhoneSession,
	phoneSession,
	type StatusView,
	type TranscriptRead,
} from "./phone-control.ts";
import type { StatuslineSession, StatusSpan } from "./pistatusline.ts";
import { remoteSessions } from "./sessions.ts";
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
	/** A terminal on the Mac shows pi: without one, the phone only reads. */
	terminalOpen(): boolean;
	/** A running pane's latest report. */
	report(sessionId: string): PaneReport | undefined;
	/** Name a stored row; false when there is none by that id. A pane's pi names its own. */
	renameInstance(sessionId: string, name: string): boolean;
	/** Pin or unpin a row, a pane's or a stored one; false when there is none by that id. */
	setPinned(sessionId: string, pinned: boolean): boolean;
	/** Remove a row; its .jsonl stays on disk. */
	deleteInstance(sessionId: string): boolean;
	/** What the status adds to a report for a session's directory: its git state. */
	statusLine?(cwd: string): Promise<StatusLine>;
	/** The pane's pistatusline rendered at `cols` columns, as styled spans per line. */
	renderStatusline?(session: StatuslineSession, report: PaneReport, cols: number): Promise<StatusSpan[][] | undefined>;
	webDir: string;
}

export interface RemoteServer {
	/** The port actually bound (differs from the requested one only for port 0). */
	port: number;
	/** The sessions a phone has open on its event stream. */
	watching(): Set<string>;
	/** The devices with an event stream open: the app is in the foreground there. */
	present(): Set<string>;
	/** Push a pane's reply in progress (null: finished, at entry `entryId` when known) to the phones that have its session open. */
	live(sessionId: string, live: LiveSnapshot | null, entryId?: string): void;
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
/** The widths a phone may ask the status line for. */
const COLS_MIN = 20;
const COLS_MAX = 200;
/** A task's output tail, as /tasks' detail view reads it. */
const TAIL_BYTES = 8192;
const TAIL_LINES = 10;
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

/** Folders offered for a typed path at once. */
const COMPLETIONS_MAX = 20;

/**
 * The folders a typed directory path may go on to, as a shell's Tab offers them: those in its
 * parent whose name starts with its last part, whatever the case. Hidden ones only once a "." is
 * typed. Folders only: a phone starts pi in one, and sees nothing else on the Mac this way.
 */
function completeDirectory(typed: string): string[] {
	const path = expandHome(typed.trim());
	if (!isAbsolute(path)) return [];
	const cut = path.lastIndexOf("/") + 1;
	const parent = path.slice(0, cut);
	const start = path.slice(cut).toLowerCase();
	try {
		return readdirSync(parent, { withFileTypes: true })
			.filter(
				(e) =>
					(e.isDirectory() || (e.isSymbolicLink() && isDirectory(join(parent, e.name)))) &&
					e.name.toLowerCase().startsWith(start) &&
					(start.startsWith(".") || !e.name.startsWith(".")),
			)
			.map((e) => join(parent, e.name))
			.sort((a, b) => a.localeCompare(b))
			.slice(0, COMPLETIONS_MAX);
	} catch {
		return [];
	}
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

const PHONE_STATUS: Record<PhoneError, number> = {
	session_not_running: 409,
	session_running: 409,
	pane_too_old: 409,
	session_busy: 409,
	unsent_draft: 409,
	command_refused: 400,
	invalid_model: 400,
	invalid_thinking: 400,
	invalid_trust: 400,
	invalid_name: 400,
	invalid_pinned: 400,
	unknown_task: 404,
	no_output: 404,
	no_status: 404,
};

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
	// The Mac is the root: with no terminal showing pi there, nothing changes from here. Before any
	// body is read, so a photo is not read only to be refused.
	if (path.startsWith("/api/sessions") && req.method !== "GET" && !deps.terminalOpen()) {
		return json(res, 409, { error: "pi_not_open" });
	}
	if (path === "/api/sessions/past" && req.method === "GET") {
		const cwd = expandHome(url.searchParams.get("cwd") ?? "");
		if (!isDirectory(cwd)) return json(res, 400, { error: "invalid_cwd" });
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const instances = deps.listInstances();
		const sessions = (await SessionManager.list(cwd))
			.filter((s) => s.messageCount > 0 && !instances.some((i) => i.external && i.sessionFile === s.path))
			.sort((a, b) => b.modified.getTime() - a.modified.getTime())
			.slice(0, 50)
			.map((s) => ({
				id: instances.find((i) => i.sessionFile === s.path)?.id,
				sessionFile: s.path,
				cwd: s.cwd || cwd,
				label: s.name || labelFromTask(s.firstMessage),
			}));
		return json(res, 200, { sessions });
	}
	if (path === "/api/sessions/resume" && req.method === "POST") {
		const body = await readJson(req);
		const cwd = typeof body.cwd === "string" ? expandHome(body.cwd) : "";
		if (!isDirectory(cwd)) return json(res, 400, { error: "invalid_cwd" });
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const saved = (await SessionManager.list(cwd)).find((s) => s.path === body.sessionFile && s.messageCount > 0);
		if (!saved) return json(res, 404, { error: "unknown_session" });
		if (deps.listInstances().some((i) => i.external && i.sessionFile === saved.path))
			return json(res, 409, { error: "session_running" });
		const launch = launchOf(deps);
		if (!launch) return json(res, 503, { error: "no_launch" });
		const pane = start(deps, { cwd: saved.cwd || cwd, sessionFile: saved.path, task: "", launch });
		return json(res, 201, { pane });
	}
	if (path === "/api/sessions" && req.method === "GET") {
		return json(res, 200, { sessions: remoteSessions(deps.listInstances()), terminalOpen: deps.terminalOpen() });
	}
	if (path === "/api/sessions" && req.method === "POST") {
		const body = await readJson(req);
		const cwd = typeof body.cwd === "string" ? expandHome(body.cwd) : "";
		// pi takes a new session's first prompt as an argument, which carries no images.
		if (body.images !== undefined) return json(res, 400, { error: "images_need_running" });
		if (!isDirectory(cwd)) return json(res, 400, { error: "invalid_cwd" });
		const task = promptIn(body, "task");
		// No pane lists its commands yet, so a new session starts with none.
		if (commandName(task) !== undefined) return json(res, 400, { error: "command_refused" });
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
		const typed = url.searchParams.get("under");
		if (typed !== null) return json(res, 200, { directories: completeDirectory(typed) });
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

	const sessionPath = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(path);
	const route = sessionPath && sessionRoute(sessionPath[2] ?? "", req.method);
	if (!sessionPath || !route) return json(res, 404, { error: "not_found" });
	if (req.method !== route.method) return json(res, 405, { error: "method_not_allowed" });
	const body = route.method === "POST" ? await readJson(req, route.bodyMax) : {};
	// After the body, which may have taken a while: the session as it is now.
	const session = sessionOf(deps, sessionPath[1]);
	if (!session) return json(res, 404, { error: "unknown_session" });
	if ("messages" in route) return serveMessages(url, res, session);
	const outcome = decide(session, route.action(body));
	if ("error" in outcome) return json(res, PHONE_STATUS[outcome.error], { error: outcome.error });
	if ("message" in outcome) {
		if (!deps.send(session.id, outcome.message)) return json(res, 409, { error: "session_not_running" });
		return json(res, 202, { ok: true });
	}
	if ("operation" in outcome) {
		const { operation } = outcome;
		const done =
			operation.type === "rename"
				? deps.renameInstance(session.id, operation.name)
				: operation.type === "pin"
					? deps.setPinned(session.id, operation.pinned)
					: deps.deleteInstance(session.id);
		return done ? json(res, 200, { ok: true }) : json(res, 404, { error: "unknown_session" });
	}
	if ("status" in outcome) return serveStatus(deps, url, res, session, outcome.status);
	if ("commands" in outcome) return json(res, 200, { commands: outcome.commands });
	return serveRead(res, outcome.read);
}

type SessionRoute =
	| { method: "GET"; messages: true }
	| { method: string; bodyMax?: number; action: (body: Record<string, unknown>) => PhoneAction };

/** What a path under a session asks of it; none for one the phone has no route for. */
function sessionRoute(rest: string, method: string | undefined): SessionRoute | undefined {
	if (rest === "") return method === "DELETE" ? { method, action: () => ({ type: "delete" }) } : undefined;
	const image = /^\/images\/([0-9a-f-]{8,36})\/(\d{1,3})$/.exec(rest);
	if (image) return { method: "GET", action: () => ({ type: "image", entryId: image[1], index: Number(image[2]) }) };
	// A background task the pane reported: the tail of its output, or stopping it as /tasks' `x` does.
	const task = /^\/tasks\/([\w.:-]{1,64})\/(output|stop)$/.exec(rest);
	if (task) {
		const taskId = task[1];
		return task[2] === "output"
			? { method: "GET", action: () => ({ type: "task_output", taskId }) }
			: { method: "POST", action: () => ({ type: "stop_task", taskId }) };
	}
	// A tool result's whole output: the transcript cuts it to TEXT_MAX.
	const output = /^\/messages\/([0-9a-f-]{8,36})\/output$/.exec(rest);
	if (output) return { method: "GET", action: () => ({ type: "message_output", entryId: output[1] }) };
	if (rest === "/messages") return { method: "GET", messages: true };
	if (rest === "/status") return { method: "GET", action: () => ({ type: "status" }) };
	if (rest === "/commands") return { method: "GET", action: () => ({ type: "commands" }) };
	switch (/^\/(prompt|abort|model|thinking|trust|rename|pin)$/.exec(rest)?.[1]) {
		case "prompt":
			return {
				method: "POST",
				bodyMax: PROMPT_BODY_MAX,
				action: (body) => {
					const text = promptIn(body, "text");
					const images = imagesIn(body);
					return images ? { type: "prompt", text, images } : { type: "prompt", text };
				},
			};
		case "abort":
			return { method: "POST", action: () => ({ type: "abort" }) };
		case "model":
			return { method: "POST", action: (body) => ({ type: "model", provider: body.provider, id: body.id }) };
		case "thinking":
			return { method: "POST", action: (body) => ({ type: "thinking", level: body.level }) };
		case "trust":
			return { method: "POST", action: (body) => ({ type: "trust", trust: body.trust }) };
		case "rename":
			return { method: "POST", action: (body) => ({ type: "rename", name: body.name }) };
		case "pin":
			return { method: "POST", action: (body) => ({ type: "pin", pinned: body.pinned }) };
		default:
			return undefined;
	}
}

/** The session a path names, its id decoded: the one lookup a request makes. */
function sessionOf(deps: RemoteDeps, encoded: string): PhoneSession | undefined {
	let id: string;
	try {
		id = decodeURIComponent(encoded);
	} catch {
		return undefined;
	}
	return phoneSession(deps, id);
}

/** A page of the session's transcript, back from `before`. */
async function serveMessages(url: URL, res: ServerResponse, session: PhoneSession): Promise<void> {
	const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10) || MESSAGES_DEFAULT;
	const limit = Math.min(Math.max(requested, 1), MESSAGES_MAX);
	const before = url.searchParams.get("before") ?? undefined;
	if (before !== undefined && !ENTRY_PATTERN.test(before)) return json(res, 400, { error: "invalid_entry" });
	// One past the page tells whether older messages are left.
	const page = loadTranscript(session.sessionFile, limit + 1, session.leafId, before);
	return json(res, 200, { messages: page.slice(-limit), more: page.length > limit });
}

/** The status phone control built, with what the Mac adds for the session's directory. */
async function serveStatus(
	deps: RemoteDeps,
	url: URL,
	res: ServerResponse,
	session: PhoneSession,
	statusView: StatusView,
): Promise<void> {
	// pistatusline's own lines at the phone's width, which show git (and the plan usage pistatusline keeps) themselves.
	const cols = /^\d{1,3}$/.test(url.searchParams.get("cols") ?? "") ? Number(url.searchParams.get("cols")) : 0;
	const lines =
		cols && session.report
			? await deps.renderStatusline?.(session, session.report, Math.min(Math.max(cols, COLS_MIN), COLS_MAX))
			: undefined;
	const fromMac = lines ? { statusline: { lines } } : { git: (await deps.statusLine?.(session.cwd))?.git };
	return json(res, 200, { report: { ...statusView, ...fromMac } });
}

function serveRead(res: ServerResponse, read: TranscriptRead): void {
	if (read.type === "task_output") {
		const tail = outputTail(read.file);
		json(res, tail ? 200 : 404, tail ?? { error: "no_output" });
		return;
	}
	const { sessionFile, leafId } = read.transcript;
	if (read.type === "message_output") {
		const result = loadOutput(sessionFile, read.entryId, leafId);
		json(res, result ? 200 : 404, result ?? { error: "unknown_entry" });
		return;
	}
	const image = loadImage(sessionFile, read.entryId, read.index, leafId);
	if (!image) {
		json(res, 404, { error: "unknown_image" });
		return;
	}
	// Only a type the phone shows as an image, never one a browser would run (SVG, HTML).
	if (!Object.hasOwn(IMAGE_MAGIC, image.mimeType)) {
		json(res, 415, { error: "unsupported_image" });
		return;
	}
	const bytes = Buffer.from(image.data, "base64");
	res.writeHead(200, {
		"content-type": image.mimeType,
		"content-length": bytes.length,
		// An entry never changes: the same id and position is the same image.
		"cache-control": `private, max-age=${IMAGE_MAX_AGE_S}`,
		"x-content-type-options": "nosniff",
	});
	res.end(bytes);
}

export function startRemoteServer(deps: RemoteDeps, port: number, host = "127.0.0.1"): Promise<RemoteServer> {
	const events = new RemoteEvents({
		// Sorted: agent view's order shifts with every heartbeat and is not a change.
		sessionsSignature: () =>
			JSON.stringify([
				deps.terminalOpen(),
				remoteSessions(deps.listInstances()).sort((a, b) => a.id.localeCompare(b.id)),
			]),
		session: (id) => phoneSession(deps, id),
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
				live: (id, live, entryId) => events.live(id, live, entryId),
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
