import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, isAbsolute, join } from "node:path";
import { stripAnsi } from "../ansi.ts";
import type {
	InstanceSummary,
	LiveSnapshot,
	NewPaneSpec,
	PaneImage,
	PaneLaunch,
	PaneMessage,
	PaneReport,
	PromptOutcome,
	ResumeSpec,
} from "../ipc/protocol.ts";
import { resumePane, type StartClaims, startNewPane } from "../pane-start.ts";
import { labelFromTask } from "../rows.ts";
import type { StartClaim } from "../supervisor.ts";
import type { Waiting } from "./delivery.ts";
import { RemoteEvents } from "./events.ts";
import type { ClaimResult, RemoteStore } from "./pairing.ts";
import {
	commandName,
	decide,
	type PhoneAction,
	type PhoneError,
	type PhoneSession,
	phoneSession,
	REFUSED,
	type StatusView,
	type TranscriptRead,
} from "./phone-control.ts";
import type { StatuslineSession, StatusSpan } from "./pistatusline.ts";
import { chatActions, type ListedRemoteSession, type RemoteSession, remoteSessions } from "./sessions.ts";
import { launchUsable, type SessionSpec } from "./spawn.ts";
import type { StatusLine } from "./statusline.ts";
import { loadImage, loadOutput, loadTranscript } from "./transcript.ts";
import { parseSubscription } from "./webpush.ts";

export interface RemoteDeps {
	store: RemoteStore;
	notifyPairingCodeExhausted?(): void;
	listInstances(): InstanceSummary[];
	send(sessionId: string, message: PaneMessage): Promise<boolean>;
	launch(): PaneLaunch | undefined;
	startSession(spec: SessionSpec): string;
	claimStart(spec: ResumeSpec): StartClaim;
	paneStarting(spec: NewPaneSpec): void;
	startFailed(id: string): void;
	terminalOpen(): boolean;
	report(sessionId: string): PaneReport | undefined;
	outcomes?(sessionId: string): PromptOutcome[];
	lifetime?(): string;
	answer?(sessionId: string, waiting: Waiting[]): PromptOutcome[];
	renameInstance(sessionId: string, name: string): boolean;
	setPinned(sessionId: string, pinned: boolean): boolean;
	deleteInstance(sessionId: string): boolean;
	statusLine?(cwd: string): Promise<StatusLine>;
	renderStatusline?(session: StatuslineSession, report: PaneReport, cols: number): Promise<StatusSpan[][] | undefined>;
	webDir: string;
}

export interface RemoteServer {
	port: number;
	watching(): Set<string>;
	devicesInForeground(): Set<string>;
	live(sessionId: string, live: LiveSnapshot | null, entryId?: string): void;
	status(sessionId: string): void;
	close(): Promise<void>;
}

export const BODY_MAX = 64 * 1024;
const PAIR_BODY_MAX = 4 * 1024;
export const PROMPT_MAX = 32 * 1024;
export const IMAGES_MAX = 4;
export const IMAGE_MAX = 2 * 1024 * 1024;
const IMAGE_BASE64_MAX = Math.ceil(IMAGE_MAX / 3) * 4;
export const PROMPT_BODY_MAX = BODY_MAX + IMAGES_MAX * IMAGE_BASE64_MAX;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_MAGIC: Record<PaneImage["mimeType"], (bytes: Buffer) => boolean> = {
	"image/jpeg": (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
	"image/png": (bytes) => bytes.subarray(0, 8).equals(PNG_SIGNATURE),
	"image/gif": (bytes) => /^GIF8[79]a$/.test(bytes.toString("latin1", 0, 6)),
	"image/webp": (bytes) => bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP",
};
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const SKILL_SELECTION_ID = /^[a-f0-9]{64}$/;
const CONTROL_CHARS_BUT_TAB_AND_NEWLINE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
const MESSAGES_DEFAULT = 50;
const IMAGE_MAX_AGE_S = 7 * 24 * 60 * 60;
const MESSAGES_MAX = 200;
const MODEL_PATTERN = /^\w[\w.-]*\/[\w.:/@+-]+$/;
const ENTRY_PATTERN = /^[0-9a-f-]{8,36}$/;
const PROMPT_ID_PATTERN = /^[\w-]{1,64}$/;
const COLS_MIN = 20;
const COLS_MAX = 200;
const TAIL_BYTES = 8192;
const TAIL_LINES = 10;
/** A page whose name resolves to 127.0.0.1 still sends its own name. */
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const TAILNET_HOST = /^([a-z0-9-]+\.)+ts\.net(:\d+)?$/i;

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

async function readJson(
	req: IncomingMessage,
	max = BODY_MAX,
	overflow: "drain" | "reject" = "drain",
): Promise<Record<string, unknown>> {
	if (overflow === "reject" && Number(req.headers["content-length"]) > max) {
		throw new HttpError(413, "body_too_large");
	}
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of req.iterator({ destroyOnReturn: false })) {
		size += (chunk as Buffer).length;
		if (size > max && overflow === "reject") throw new HttpError(413, "body_too_large");
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

function expandHome(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

const COMPLETIONS_MAX = 20;

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

function promptIdIn(body: Record<string, unknown>): string | undefined {
	const { id } = body;
	if (id === undefined) return undefined;
	if (typeof id !== "string" || !PROMPT_ID_PATTERN.test(id)) throw new HttpError(400, "invalid_prompt_id");
	return id;
}

function waitingIn(url: URL): Waiting[] {
	return url.searchParams.getAll("prompt").flatMap((asked) => {
		const at = asked.indexOf("@");
		const id = asked.slice(0, at);
		return at > 0 && PROMPT_ID_PATTERN.test(id) ? [{ id, lifetime: asked.slice(at + 1) }] : [];
	});
}

function skillsIn(body: Record<string, unknown>): string[] | undefined {
	const ids = body.skills;
	if (ids === undefined) return undefined;
	if (
		!Array.isArray(ids) ||
		ids.length > 200 ||
		ids.some((id) => typeof id !== "string" || !SKILL_SELECTION_ID.test(id))
	)
		throw new HttpError(400, "invalid_skills");
	return ids;
}

function isInertImageType(type: unknown): type is PaneImage["mimeType"] {
	return typeof type === "string" && Object.hasOwn(IMAGE_MAGIC, type);
}

function imagesIn(body: Record<string, unknown>): PaneImage[] | undefined {
	const { images } = body;
	if (images === undefined || (Array.isArray(images) && images.length === 0)) return undefined;
	if (!Array.isArray(images) || images.length > IMAGES_MAX) throw new HttpError(400, "invalid_image");
	return images.map((image: unknown) => {
		const { mimeType, data } = (image ?? {}) as Record<string, unknown>;
		if (!isInertImageType(mimeType) || typeof data !== "string") throw new HttpError(400, "invalid_image");
		if (data.length > IMAGE_BASE64_MAX) throw new HttpError(413, "image_too_large");
		if (data.length % 4 !== 0 || !BASE64.test(data)) throw new HttpError(400, "invalid_image");
		const bytes = Buffer.from(data, "base64");
		if (bytes.length > IMAGE_MAX) throw new HttpError(413, "image_too_large");
		if (!IMAGE_MAGIC[mimeType](bytes)) throw new HttpError(400, "invalid_image");
		return { mimeType, data };
	});
}

const PHONE_STATUS: Record<PhoneError, number> = {
	pi_not_open: 409,
	session_not_running: 409,
	session_silent: 409,
	session_running: 409,
	pane_too_old: 409,
	session_busy: 409,
	unsent_draft: 409,
	command_refused: 400,
	invalid_model: 400,
	invalid_skills: 400,
	invalid_thinking: 400,
	invalid_trust: 400,
	invalid_name: 400,
	invalid_pinned: 400,
	unknown_task: 404,
	no_output: 404,
	no_status: 404,
};

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
			.map((line) => stripAnsi(line).replace(CONTROL_CHARS_BUT_TAB_AND_NEWLINE, ""))
			.filter(Boolean);
		return { lines, size };
	} catch {
		return undefined;
	}
}

function launchOf(deps: RemoteDeps): PaneLaunch | undefined {
	const launch = deps.launch();
	return launchUsable(launch) ? launch : undefined;
}

function startClaims(deps: RemoteDeps): StartClaims {
	return {
		start: (spec) => {
			if ("pane" in spec) {
				deps.paneStarting(spec);
				return spec.pane;
			}
			const claim = deps.claimStart(spec);
			if (!claim.ok) throw new HttpError(409, claim.refused === "starting" ? "session_starting" : "session_running");
			return claim.id;
		},
		startFailed: (id) => deps.startFailed(id),
	};
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

function refuseChangesWithoutTerminal(
	deps: RemoteDeps,
	req: IncomingMessage,
	res: ServerResponse,
	path: string,
): boolean {
	if (!path.startsWith("/api/sessions") || req.method === "GET" || deps.terminalOpen()) return false;
	const error = REFUSED.no_terminal;
	json(res, PHONE_STATUS[error], { error });
	return true;
}

function serveStatic(webDir: string, url: URL, req: IncomingMessage, res: ServerResponse): void {
	const path = url.pathname;
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
	const body = readFileSync(join(webDir, name));
	if (req.method === "HEAD") res.end();
	else res.end(body);
}

function claimed(deps: RemoteDeps, res: ServerResponse, result: ClaimResult): void {
	if ("token" in result) {
		json(res, 200, { token: result.token });
		return;
	}
	json(res, 400, { error: "invalid_code" });
	if (result.error === "code_attempts_exhausted") deps.notifyPairingCodeExhausted?.();
}

async function handle(
	deps: RemoteDeps,
	events: RemoteEvents,
	req: IncomingMessage,
	res: ServerResponse,
): Promise<void> {
	const host = req.headers.host ?? "";
	const local = LOOPBACK_HOST.test(host);
	if (!local && !TAILNET_HOST.test(host)) return json(res, 421, { error: "bad_host" });
	if ("tailscale-funnel-request" in req.headers) {
		return json(res, 403, { error: "funnel_refused", message: "Remote control refuses Tailscale Funnel requests." });
	}
	const login = req.headers["tailscale-user-login"];
	if (!local && (typeof login !== "string" || !login.trim())) {
		return json(res, 403, {
			error: "tailnet_identity_required",
			message: "Remote control requires a Tailscale user identity. Tagged devices are refused.",
		});
	}
	const url = new URL(req.url ?? "/", "http://localhost");
	const path = url.pathname;
	if (!path.startsWith("/api/")) return serveStatic(deps.webDir, url, req, res);
	// Not a "simple" CORS content type, so a cross-site page cannot POST here without a preflight, which is never granted.
	if (req.method === "POST" && !(req.headers["content-type"] ?? "").startsWith("application/json")) {
		return json(res, 415, { error: "unsupported_media_type" });
	}

	if (path === "/api/pair" && req.method === "POST") {
		const body = await readJson(req, PAIR_BODY_MAX, "reject");
		const name = String(body.deviceName ?? "");
		const result =
			typeof body.secret === "string"
				? deps.store.claimSecret(body.secret, name)
				: deps.store.claim(String(body.code ?? ""), name);
		return claimed(deps, res, result);
	}

	const token = bearer(req);
	const device = deps.store.authenticate(token);
	if (!device) return json(res, 401, { error: "unauthorized" });

	if (path === "/api/events" && req.method === "GET") {
		const session = url.searchParams.get("session") ?? undefined;
		const stream = url.searchParams.get("stream") ?? undefined;
		events.add(res, session, () => deps.store.authenticate(token) !== undefined, device.id, stream);
		return;
	}
	if (path === "/api/hidden" && req.method === "POST") {
		const { stream } = await readJson(req);
		if (typeof stream === "string") events.hide(device.id, stream);
		return json(res, 200, { ok: true });
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
		if (id !== device.id) return json(res, 403, { error: "forbidden" });
		return deps.store.revoke(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: "unknown_device" });
	}
	if (refuseChangesWithoutTerminal(deps, req, res, path)) return;
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
		const launch = launchOf(deps);
		if (!launch) return json(res, 503, { error: "no_launch" });
		const spec = { cwd: saved.cwd || cwd, sessionFile: saved.path };
		const { pane, id } = await resumePane(
			startClaims(deps),
			{ ...spec, label: saved.name || labelFromTask(saved.firstMessage) },
			() => start(deps, { ...spec, task: "", launch }),
		);
		return json(res, 201, { pane, id });
	}
	if (path === "/api/sessions" && req.method === "GET") {
		const terminalOpen = deps.terminalOpen();
		const sessions: ListedRemoteSession[] = remoteSessions(deps.listInstances()).map((s) => ({
			...s,
			actions: chatActions(s.verdict, terminalOpen),
		}));
		return json(res, 200, { sessions, terminalOpen });
	}
	if (path === "/api/sessions" && req.method === "POST") {
		const body = await readJson(req);
		const cwd = typeof body.cwd === "string" ? expandHome(body.cwd) : "";
		if (body.images !== undefined) return json(res, 400, { error: "images_need_running" });
		if (!isDirectory(cwd)) return json(res, 400, { error: "invalid_cwd" });
		const task = promptIn(body, "task");
		if (commandName(task) !== undefined) return json(res, 400, { error: "command_refused" });
		const model = body.model;
		if (model !== undefined && (typeof model !== "string" || !MODEL_PATTERN.test(model))) {
			return json(res, 400, { error: "invalid_model" });
		}
		const launch = launchOf(deps);
		if (!launch) return json(res, 503, { error: "no_launch" });
		const { pane } = startNewPane(startClaims(deps), { cwd, label: labelFromTask(task) }, () =>
			start(deps, {
				cwd,
				task: task.trim(),
				...(typeof model === "string" ? { model } : {}),
				launch,
			}),
		);
		return json(res, 201, { pane, id: pane });
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

	const asking = /^\/api\/sessions\/([^/]+)\/outcomes$/.exec(path);
	if (asking && req.method === "GET") {
		let id: string;
		try {
			id = decodeURIComponent(asking[1]!);
		} catch {
			return json(res, 404, { error: "unknown_session" });
		}
		return json(res, 200, { outcomes: deps.answer?.(id, waitingIn(url)) ?? [] });
	}
	const sessionPath = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(path);
	const route = sessionPath && sessionRoute(sessionPath[2] ?? "", req.method);
	if (!sessionPath || !route) return json(res, 404, { error: "not_found" });
	if (req.method !== route.method) return json(res, 405, { error: "method_not_allowed" });
	const body = route.method === "POST" ? await readJson(req, route.bodyMax) : {};
	const session = sessionOf(deps, sessionPath[1]);
	if (!session) return json(res, 404, { error: "unknown_session" });
	if ("messages" in route) return serveMessages(url, res, session);
	const outcome = decide(session, route.action(body));
	if ("error" in outcome) return json(res, PHONE_STATUS[outcome.error], { error: outcome.error });
	if ("message" in outcome) {
		if (!(await deps.send(session.id, outcome.message))) return json(res, 409, { error: "session_not_running" });
		const lifetime = deps.lifetime?.();
		return json(res, 202, { ok: true, ...(lifetime ? { lifetime } : {}) });
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

function sessionRoute(rest: string, method: string | undefined): SessionRoute | undefined {
	if (rest === "") return method === "DELETE" ? { method, action: () => ({ type: "delete" }) } : undefined;
	const image = /^\/images\/([0-9a-f-]{8,36})\/(\d{1,3})$/.exec(rest);
	if (image) return { method: "GET", action: () => ({ type: "image", entryId: image[1], index: Number(image[2]) }) };
	const task = /^\/tasks\/([\w.:-]{1,64})\/(output|stop)$/.exec(rest);
	if (task) {
		const taskId = task[1];
		return task[2] === "output"
			? { method: "GET", action: () => ({ type: "task_output", taskId }) }
			: { method: "POST", action: () => ({ type: "stop_task", taskId }) };
	}
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
					const id = promptIdIn(body);
					const skills = skillsIn(body);
					return {
						type: "prompt",
						text,
						...(images ? { images } : {}),
						...(skills ? { skills } : {}),
						...(id ? { id } : {}),
					};
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

function sessionOf(deps: RemoteDeps, encoded: string): PhoneSession | undefined {
	let id: string;
	try {
		id = decodeURIComponent(encoded);
	} catch {
		return undefined;
	}
	return phoneSession(deps, id);
}

async function serveMessages(url: URL, res: ServerResponse, session: PhoneSession): Promise<void> {
	const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10) || MESSAGES_DEFAULT;
	const limit = Math.min(Math.max(requested, 1), MESSAGES_MAX);
	const before = url.searchParams.get("before") ?? undefined;
	if (before !== undefined && !ENTRY_PATTERN.test(before)) return json(res, 400, { error: "invalid_entry" });
	const page = loadTranscript(session.sessionFile, limit + 1, session.leafId, before);
	return json(res, 200, { messages: page.slice(-limit), more: page.length > limit });
}

async function serveStatus(
	deps: RemoteDeps,
	url: URL,
	res: ServerResponse,
	session: PhoneSession,
	statusView: StatusView,
): Promise<void> {
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
	if (!isInertImageType(image.mimeType)) {
		json(res, 415, { error: "unsupported_image" });
		return;
	}
	const bytes = Buffer.from(image.data, "base64");
	res.writeHead(200, {
		"content-type": image.mimeType,
		"content-length": bytes.length,
		"cache-control": `private, max-age=${IMAGE_MAX_AGE_S}`,
		"x-content-type-options": "nosniff",
	});
	res.end(bytes);
}

function sessionsInIdOrder(deps: RemoteDeps): RemoteSession[] {
	return remoteSessions(deps.listInstances()).sort((a, b) => a.id.localeCompare(b.id));
}

export function startRemoteServer(deps: RemoteDeps, port: number): Promise<RemoteServer> {
	const events = new RemoteEvents({
		sessionsSignature: () => JSON.stringify([deps.terminalOpen(), sessionsInIdOrder(deps)]),
		session: (id) => phoneSession(deps, id),
		listed: () => new Set(deps.listInstances().map((i) => i.id)),
		outcomes: (id) => deps.outcomes?.(id) ?? [],
	});
	const server: Server = createServer((req, res) => {
		handle(deps, events, req, res).catch((error: unknown) => {
			if (res.headersSent) {
				res.end();
				return;
			}
			if (error instanceof HttpError) {
				if (error.status === 413 && !req.complete) res.setHeader("connection", "close");
				json(res, error.status, { error: error.message });
			} else json(res, 500, { error: "internal_error" });
		});
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			resolve({
				port: typeof address === "object" && address ? address.port : port,
				watching: () => events.watching(),
				devicesInForeground: () => events.devicesInForeground(),
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
