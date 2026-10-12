// @ts-check
/**
 * bluclawd's remote control on a phone: the session list (agent view's bands) and one
 * session's chat. Only the parts that change are re-rendered, so the composer keeps its text,
 * focus and keyboard while updates arrive.
 */
import { api, getToken, setToken, Unauthorized } from "./api.js";

/** @typedef {{ id: string, label: string, cwd: string, band: string, state: string, alive: boolean, detail: string, createdAt?: string, finishedAt?: string }} Session */
/** @typedef {{ kind: string, id: string, text?: string, thinking?: string, tools?: {id: string, name: string, summary: string}[], error?: string, toolCallId?: string, toolName?: string, ok?: boolean, truncated?: boolean }} Message */

const BANDS = [
	["pinned", "Pinned"],
	["needs", "Needs input"],
	["working", "Working"],
	["idle", "Idle"],
];
const OFFLINE_AFTER_MS = 5000;
const ERRORS = {
	session_not_running: "This session is not running. Open it on the Mac to continue.",
	unknown_session: "This session is gone.",
	invalid_code: "That code is wrong or was already used. Run /remote-control pair for a new one.",
	expired_code: "That code expired. Run /remote-control pair for a new one.",
};

const state = {
	/** @type {Session[]} */ sessions: [],
	/** @type {string | undefined} */ open: undefined,
	/** @type {Message[]} */ messages: [],
	/** @type {string[]} */ pending: [],
	online: true,
	/** @type {string | undefined} */ error: undefined,
};

/** @param {string} selector @returns {any} */
const $ = (selector) => document.querySelector(selector);
const app = $("#app");
/** @type {EventSource | undefined} */
let source;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let offlineTimer;
/** Which view the DOM holds: "pair", "list" or "chat:<id>". */
let shown = "";
let lastLog = "";

/** @param {unknown} text */
function esc(text) {
	return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** @param {string | undefined} code */
function errorText(code) {
	return (code && ERRORS[/** @type {keyof typeof ERRORS} */ (code)]) || code || "Something went wrong";
}

/** @param {string | undefined} iso */
function age(iso) {
	const ms = iso ? Date.now() - Date.parse(iso) : Number.NaN;
	if (!Number.isFinite(ms)) return "";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

function deviceName() {
	const ua = navigator.userAgent;
	return /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : "Browser";
}

function standalone() {
	return matchMedia("(display-mode: standalone)").matches || /** @type {any} */ (navigator).standalone === true;
}

// ---- data ----

/** @param {unknown} error */
function handleError(error) {
	if (error instanceof Unauthorized) {
		source?.close();
		render();
		return;
	}
	state.error = errorText(error instanceof Error ? error.message : String(error));
	render();
}

async function loadSessions() {
	try {
		state.sessions = await api.sessions();
		state.error = undefined;
		render();
	} catch (error) {
		handleError(error);
	}
}

async function loadMessages() {
	const id = state.open;
	if (!id) return;
	try {
		/** @type {Message[]} */
		const messages = await api.messages(id);
		if (state.open !== id) return;
		state.messages = messages;
		// A sent prompt is pending until the transcript shows it.
		state.pending = state.pending.filter((text) => !messages.some((m) => m.kind === "user" && m.text === text));
		render();
	} catch (error) {
		handleError(error);
	}
}

/** @param {boolean} online */
function setOnline(online) {
	if (state.online === online) return;
	state.online = online;
	render();
}

/** One stream, reopened for the session on screen; any (re)open refetches everything. */
function connect() {
	source?.close();
	source = undefined;
	if (!getToken()) return;
	const current = api.events(state.open);
	source = current;
	current.onopen = () => {
		clearTimeout(offlineTimer);
		offlineTimer = undefined;
		setOnline(true);
		void loadSessions();
		void loadMessages();
	};
	current.addEventListener("sessions", () => void loadSessions());
	current.addEventListener("messages", () => void loadMessages());
	current.onerror = () => {
		offlineTimer ??= setTimeout(() => setOnline(false), OFFLINE_AFTER_MS);
		// EventSource gives up on an HTTP error, such as a revoked token: find out which, then retry.
		if (current.readyState === EventSource.CLOSED && source === current) {
			setTimeout(() => {
				if (source === current) void loadSessions().then(connect);
			}, 3000);
		}
	};
}

// ---- views ----

function pairView() {
	const hint = standalone()
		? "Enter the code <code>/remote-control</code> shows on your Mac."
		: "First add this page to your Home Screen (Share → Add to Home Screen), open it from there, then pair.";
	return `<form class="pair" id="pair">
<div class="logo">✻</div><h1>bluclawd</h1><p class="muted">${hint}</p>
<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000" aria-label="Pairing code">
<button>Pair</button><div class="error" id="pair-error"></div></form>`;
}

function listShell() {
	return `<header class="bar"><h1>Sessions</h1><span class="muted" id="online"></span></header>
<div id="banner"></div><section class="scroll" id="rows"></section>`;
}

/** @param {Session} s */
function rowHtml(s) {
	const glyph = s.state === "needs" ? "✻" : s.state === "working" ? "" : "∙";
	return `<a class="row" href="#s/${encodeURIComponent(s.id)}"><span class="glyph ${esc(s.state)}">${glyph}</span>
<span class="name">${esc(s.label)}<small>${esc(s.detail || s.state)}</small></span>
<span class="age">${age(s.finishedAt ?? s.createdAt)}</span></a>`;
}

function rowsHtml() {
	if (state.sessions.length === 0) return `<p class="empty">No sessions. Start one in agent view on the Mac.</p>`;
	return BANDS.map(([key, title]) => {
		const rows = state.sessions.filter((s) => s.band === key);
		return rows.length ? `<h2 class="band">${title}</h2>${rows.map(rowHtml).join("")}` : "";
	}).join("");
}

function chatShell() {
	return `<header class="bar"><a class="back" href="#">‹ Sessions</a><span class="title" id="title"></span>
<button class="stop" id="stop" hidden>Stop</button></header>
<div id="banner"></div><section class="scroll" id="scroll"><div class="log" id="log"></div></section>
<form class="composer" id="composer"><textarea id="text" rows="1" placeholder="Reply"></textarea>
<button class="send" aria-label="Send">↑</button></form>`;
}

/** @param {string} name @param {string} summary @param {Message | undefined} result @param {string} key */
function toolHtml(name, summary, result, key) {
	const title = `${esc(name.charAt(0).toUpperCase() + name.slice(1))}(${esc(summary)})`;
	if (!result) return `<div class="t">${title}</div>`;
	const first = (result.text ?? "").split("\n").find((line) => line.trim()) ?? (result.ok ? "done" : "error");
	return `<details class="t${result.ok ? "" : " err"}" data-key="${esc(key)}"><summary>${title}<br>⎿ ${esc(first)}</summary>
<pre>${esc(result.text ?? "")}${result.truncated ? "\n…" : ""}</pre></details>`;
}

/** @param {Session | undefined} session */
function logHtml(session) {
	/** @type {Map<string, Message>} */
	const results = new Map();
	for (const m of state.messages) if (m.kind === "toolResult" && m.toolCallId) results.set(m.toolCallId, m);
	const calls = new Set(state.messages.flatMap((m) => (m.tools ?? []).map((t) => t.id)));
	const parts = [];
	for (const m of state.messages) {
		if (m.kind === "user") parts.push(`<div class="u">${esc(m.text)}</div>`);
		else if (m.kind === "assistant") {
			if (m.thinking) {
				parts.push(
					`<details class="think" data-key="think:${esc(m.id)}"><summary>Thinking</summary><pre>${esc(m.thinking)}</pre></details>`,
				);
			}
			if (m.text) parts.push(`<div class="a">${esc(m.text)}</div>`);
			for (const tool of m.tools ?? []) parts.push(toolHtml(tool.name, tool.summary, results.get(tool.id), tool.id));
			if (m.error) parts.push(`<div class="t err">${esc(m.error)}</div>`);
		} else if (m.kind === "toolResult" && !(m.toolCallId && calls.has(m.toolCallId))) {
			parts.push(toolHtml(m.toolName ?? "tool", "", m, m.id));
		} else if (m.kind === "marker") parts.push(`<div class="marker">${esc(m.text)}</div>`);
	}
	for (const text of state.pending) {
		parts.push(`<div class="u">${esc(text)}</div><div class="queued">sent · waiting for the session</div>`);
	}
	if (session?.state === "working") parts.push(`<div class="working">✻ ${esc(session.detail || "Working…")}</div>`);
	return parts.length ? parts.join("") : `<p class="empty">Nothing in this session yet.</p>`;
}

/** @param {Session | undefined} session */
function bannerHtml(session) {
	if (!state.online) return `<div class="banner off">Mac unreachable. Retrying…</div>`;
	if (state.error) return `<div class="banner off">${esc(state.error)}</div>`;
	if (session?.state === "needs") {
		return `<div class="banner">This session is waiting for an answer to a dialog on the Mac. A reply sent here becomes its next prompt.</div>`;
	}
	return "";
}

// ---- render ----

function render() {
	const view = !getToken() ? "pair" : state.open ? `chat:${state.open}` : "list";
	if (view !== shown) {
		shown = view;
		lastLog = "";
		app.innerHTML = view === "pair" ? pairView() : view === "list" ? listShell() : chatShell();
		if (view === "pair") bindPair();
		else if (view !== "list") bindChat();
	}
	if (view === "list") updateList();
	else if (view !== "pair") updateChat();
}

function updateList() {
	$("#online").textContent = state.online ? "● online" : "offline";
	$("#online").classList.toggle("on", state.online);
	$("#banner").innerHTML = bannerHtml(undefined);
	$("#rows").innerHTML = rowsHtml();
}

function updateChat() {
	const session = state.sessions.find((s) => s.id === state.open);
	$("#title").textContent = session?.label ?? "";
	$("#stop").hidden = session?.state !== "working";
	$("#banner").innerHTML = bannerHtml(session);
	const html = logHtml(session);
	if (html !== lastLog) {
		lastLog = html;
		const scroll = $("#scroll");
		const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
		const log = $("#log");
		const open = new Set([...log.querySelectorAll("details[open]")].map((d) => d.dataset.key));
		log.innerHTML = html;
		for (const d of log.querySelectorAll("details")) if (open.has(d.dataset.key)) d.open = true;
		if (atBottom) scroll.scrollTop = scroll.scrollHeight;
	}
	const text = $("#text");
	const stopped = session !== undefined && !session.alive;
	text.disabled = stopped;
	$(".send").disabled = stopped;
	text.placeholder = stopped ? "Not running: open it on the Mac" : "Reply";
}

function bindPair() {
	$("#pair").addEventListener("submit", async (/** @type {Event} */ event) => {
		event.preventDefault();
		const code = $("#code").value.replace(/\D/g, "");
		try {
			setToken(await api.pair(code, deviceName()));
			render();
			connect();
		} catch (error) {
			$("#pair-error").textContent = errorText(error instanceof Error ? error.message : String(error));
		}
	});
}

function bindChat() {
	const text = $("#text");
	text.addEventListener("input", () => {
		text.style.height = "auto";
		text.style.height = `${Math.min(text.scrollHeight, 140)}px`;
	});
	$("#composer").addEventListener("submit", (/** @type {Event} */ event) => {
		event.preventDefault();
		void send();
	});
	$("#stop").addEventListener("click", async () => {
		const id = state.open;
		if (!id) return;
		try {
			await api.abort(id);
		} catch (error) {
			handleError(error);
		}
	});
}

async function send() {
	const text = $("#text");
	const value = text.value.trim();
	const id = state.open;
	if (!value || !id) return;
	text.value = "";
	text.style.height = "auto";
	state.pending.push(value);
	render();
	try {
		await api.prompt(id, value);
	} catch (error) {
		state.pending = state.pending.filter((p) => p !== value);
		text.value = value;
		handleError(error);
	}
}

// ---- routing ----

function route() {
	const match = /^#s\/(.+)$/.exec(location.hash);
	const open = match ? decodeURIComponent(match[1]) : undefined;
	if (open !== state.open) {
		state.open = open;
		state.messages = [];
		state.pending = [];
		state.error = undefined;
		connect();
	}
	render();
}

window.addEventListener("hashchange", route);
// iOS suspends a backgrounded app's stream: reopen it on return.
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") connect();
});
setInterval(() => {
	if (shown === "list") updateList();
}, 30_000);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

state.open = /^#s\/(.+)$/.exec(location.hash)?.[1];
if (state.open) state.open = decodeURIComponent(state.open);
render();
connect();
