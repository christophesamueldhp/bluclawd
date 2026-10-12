// @ts-check
/**
 * bluclawd's remote control on a phone: the session list (agent view's bands) with a composer
 * that starts a session, and one session's chat. Only the parts that change are re-rendered, so
 * the composers keep their text, focus and keyboard while updates arrive.
 */
import { api, getToken, setToken, Unauthorized } from "./api.js";
import { settle } from "./live.js";

/** @typedef {{ id: string, label: string, cwd: string, band: string, state: string, alive: boolean, resumable: boolean, detail: string, createdAt?: string, finishedAt?: string }} Session */
/** @typedef {{ kind: string, id: string, text?: string, thinking?: string, tools?: {id: string, name: string, summary: string}[], error?: string, toolCallId?: string, toolName?: string, ok?: boolean, truncated?: boolean }} Message */
/** @typedef {{ text: string, thinking?: string, tools: {id: string, name: string, summary: string, running: boolean}[] }} LiveSnapshot */

const BANDS = [
	["pinned", "Pinned"],
	["needs", "Needs input"],
	["working", "Working"],
	["idle", "Idle"],
];
const OFFLINE_AFTER_MS = 5000;
/** The server pings every 25 s; a stream silent for longer is dead even if the browser has not noticed. */
const WATCHDOG_MS = 35_000;
/** A pane that has not registered by then did not start (pi failed, or tmux did). */
const START_TIMEOUT_MS = 60_000;
/** How long a finished reply stays on screen without a transcript fetch that has it. */
const LIVE_CLEAR_MS = 3000;
const ERRORS = {
	session_not_running: "This session is not running. Open it on the Mac to continue.",
	invalid_cwd: "That directory does not exist on the Mac.",
	invalid_model: "That model name is not valid.",
	no_launch: "Start pi on the Mac once, so the phone knows how to start it.",
	start_failed: "The Mac could not start the session.",
	start_timeout: "The session did not show up. Check it on the Mac.",
	unknown_session: "This session is gone.",
	invalid_code: "That code is wrong or was already used. Run /remote-control pair for a new one.",
	expired_code: "That code expired. Run /remote-control pair for a new one.",
	empty_prompt: "Type a message first.",
	prompt_too_large: "That message is too long.",
	body_too_large: "That message is too long.",
	internal_error: "Something went wrong on the Mac.",
};

const state = {
	/** @type {Session[]} */ sessions: [],
	/** @type {string | undefined} */ open: undefined,
	/** @type {Message[]} */ messages: [],
	/** @type {{ text: string, before: number }[]} */ pending: [],
	/** The open session's reply in progress, streamed by its pane. @type {LiveSnapshot | undefined} */ live: undefined,
	/** @type {string[]} */ directories: [],
	/**
	 * A pane started from here, until its row is listed (`pane` is unset while the request is out).
	 * `from`: the stored session it resumes, whose row is gone meanwhile.
	 * @type {{ pane?: string, from?: string } | undefined}
	 */
	starting: undefined,
	loaded: false,
	messagesLoaded: false,
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
/** @type {ReturnType<typeof setTimeout> | undefined} */
let watchdog;
let messagesRequest = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let startTimer;
/** The reply on screen has ended (or may have, while the stream was down): see settle(). */
let liveEnded = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let liveClear;
/** Which view the DOM holds: "pair", "list" or "chat:<id>". */
let shown = "";
let lastLog = "";
/**
 * The pane a resumed session's chat moved to: the replies still pending move with it.
 * @type {string | undefined}
 */
let followed;
/**
 * A message for the list, shown by its next refresh (which would otherwise clear it).
 * @type {string | undefined}
 */
let notice;

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

/** @param {string} path */
function shortPath(path) {
	return path.replace(/^\/(Users|home)\/[^/]+/, "~");
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
	// A dropped connection or a 5xx is the offline banner's business, not raw text.
	const message = error instanceof Error ? error.message : String(error);
	if (!(error instanceof TypeError) && !/^HTTP 5\d\d$/.test(message)) state.error = errorText(message);
	render();
}

async function loadSessions() {
	try {
		state.sessions = await api.sessions();
		state.loaded = true;
		state.error = notice;
		notice = undefined;
		const starting = state.starting;
		if (starting?.pane && state.sessions.some((s) => s.id === starting.pane)) {
			state.starting = undefined;
			clearTimeout(startTimer);
			// The resumed session's row is the new pane's: follow it, without a history entry for the old one.
			if (starting.from && state.open === starting.from) {
				followed = starting.pane;
				location.replace(`#s/${encodeURIComponent(starting.pane)}`);
				return;
			}
		}
		render();
		if (!state.open) void loadDirectories();
	} catch (error) {
		handleError(error);
	}
}

async function loadDirectories() {
	try {
		state.directories = await api.directories();
		render();
	} catch (error) {
		handleError(error);
	}
}

/** @param {string} pane @param {string} [from] */
function waitForPane(pane, from) {
	const starting = { pane, from };
	state.starting = starting;
	clearTimeout(startTimer);
	startTimer = setTimeout(() => {
		if (state.starting !== starting) return;
		state.starting = undefined;
		if (from !== undefined && state.open === from) {
			// The resumed row is gone: back to the list, where the message outlives the reconnect.
			notice = errorText("start_timeout");
			location.hash = "";
			route();
			return;
		}
		state.error = errorText("start_timeout");
		render();
	}, START_TIMEOUT_MS);
	void loadSessions();
}

async function loadMessages() {
	const id = state.open;
	if (!id || state.starting?.from === id) return;
	const request = ++messagesRequest;
	try {
		/** @type {Message[]} */
		const messages = await api.messages(id);
		if (state.open !== id || request !== messagesRequest) return;
		state.messages = messages;
		state.messagesLoaded = true;
		state.live = settle(state.live, liveEnded, messages);
		// A sent prompt is pending until the transcript has one more copy of its text than when it was sent.
		state.pending = state.pending.filter((p) => userCount(messages, p.text) <= p.before);
		render();
	} catch (error) {
		handleError(error);
	}
}

/** @param {Message[]} messages @param {string} text */
function userCount(messages, text) {
	// Trimmed: a prompt starting with @ reaches pi with a space before it.
	return messages.filter((m) => m.kind === "user" && m.text?.trim() === text).length;
}

/** The reply on screen stays until a transcript fetch has it, which pi may not have written yet. */
function endLive() {
	clearTimeout(liveClear);
	liveEnded = true;
	liveClear = setTimeout(() => {
		state.live = undefined;
		render();
	}, LIVE_CLEAR_MS);
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
	clearTimeout(offlineTimer);
	clearTimeout(watchdog);
	offlineTimer = watchdog = undefined;
	if (!getToken()) return;
	const current = api.events(state.open);
	source = current;
	// A sleeping Mac leaves the connection hanging without an error, so the timer starts with every stream.
	offlineTimer = setTimeout(() => setOnline(false), OFFLINE_AFTER_MS);
	const alive = () => {
		clearTimeout(watchdog);
		watchdog = setTimeout(() => {
			setOnline(false);
			connect();
		}, WATCHDOG_MS);
	};
	current.onopen = () => {
		clearTimeout(offlineTimer);
		offlineTimer = undefined;
		alive();
		setOnline(true);
		// Its end may have been missed while the stream was down; one still streaming is sent again at once.
		if (state.live) endLive();
		void loadSessions();
		void loadMessages();
	};
	current.addEventListener("sessions", () => {
		alive();
		void loadSessions();
	});
	current.addEventListener("messages", () => {
		alive();
		void loadMessages();
	});
	current.addEventListener("live", (/** @type {MessageEvent} */ event) => {
		alive();
		const { sessionId, live } = JSON.parse(event.data);
		if (sessionId !== state.open) return;
		if (!live) {
			endLive();
			void loadMessages();
			return;
		}
		clearTimeout(liveClear);
		liveEnded = false;
		state.live = live;
		render();
	});
	current.addEventListener("ping", alive);
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
<div id="banner"></div><section class="scroll" id="rows"></section>
<form class="composer new" id="new-task"><textarea id="task" rows="1" placeholder="New task…" aria-label="New task" maxlength="32768"></textarea>
<div class="where"><select id="cwd" aria-label="Directory"></select>
<input id="cwd-other" placeholder="/path/to/project" aria-label="Directory path" autocapitalize="off" autocomplete="off" spellcheck="false" hidden>
<button class="start" id="start">Start</button></div></form>`;
}

/** @param {Session} s */
function rowHtml(s) {
	const glyph = s.state === "needs" ? "✻" : s.state === "working" ? "" : "∙";
	return `<a class="row" href="#s/${encodeURIComponent(s.id)}"><span class="glyph ${esc(s.state)}" aria-hidden="true">${glyph}</span>
<span class="name">${esc(s.label)}<small>${esc(s.detail || s.state)}</small></span>
<span class="age">${age(s.finishedAt ?? s.createdAt)}</span></a>`;
}

function rowsHtml() {
	if (!state.loaded) return `<p class="empty">Loading…</p>`;
	if (state.sessions.length === 0) return `<p class="empty">No sessions. Start one below.</p>`;
	return BANDS.map(([key, title]) => {
		const rows = state.sessions.filter((s) => s.band === key);
		return rows.length ? `<h2 class="band">${title}</h2>${rows.map(rowHtml).join("")}` : "";
	}).join("");
}

function chatShell() {
	return `<header class="bar"><a class="back" href="#">‹ Sessions</a><span class="title" id="title"></span>
<button class="stop" id="stop" hidden>Stop</button></header>
<div id="banner"></div><section class="scroll" id="scroll"><div class="log" id="log"></div></section>
<form class="composer" id="composer"><textarea id="text" rows="1" placeholder="Reply" aria-label="Reply" maxlength="32768"></textarea>
<button class="send" aria-label="Send"><span aria-hidden="true">↑</span></button></form>`;
}

/** @param {string} name @param {string} summary @param {Message | undefined} result @param {string} key @param {boolean} [running] */
function toolHtml(name, summary, result, key, running = false) {
	const title = `${esc(name.charAt(0).toUpperCase() + name.slice(1))}(${esc(summary)})`;
	if (!result) return `<div class="t${running ? " running" : ""}">${title}</div>`;
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
	const running = new Set((state.live?.tools ?? []).filter((t) => t.running).map((t) => t.id));
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
			for (const [index, tool] of (m.tools ?? []).entries()) {
				const key = tool.id || `${m.id}:${index}`;
				parts.push(toolHtml(tool.name, tool.summary, results.get(tool.id), key, running.has(tool.id)));
			}
			if (m.error) parts.push(`<div class="t err">${esc(m.error)}</div>`);
		} else if (m.kind === "toolResult" && !(m.toolCallId && calls.has(m.toolCallId))) {
			parts.push(toolHtml(m.toolName ?? "tool", "", m, m.id));
		} else if (m.kind === "marker") parts.push(`<div class="marker">${esc(m.text)}</div>`);
	}
	const live = state.live ? liveHtml(state.live, calls) : "";
	if (live) parts.push(live);
	for (const { text } of state.pending) {
		parts.push(`<div class="u">${esc(text)}</div><div class="queued">sent · waiting for the session</div>`);
	}
	// The reply in progress replaces the working line once it shows something.
	const streaming = live !== "" || running.size > 0;
	if (session?.state === "working" && !streaming)
		parts.push(`<div class="working">✻ ${esc(session.detail || "Working…")}</div>`);
	if (parts.length) return parts.join("");
	return `<p class="empty">${state.messagesLoaded ? "Nothing in this session yet." : "Loading…"}</p>`;
}

/**
 * The reply in progress, after the transcript. A tool call the transcript already shows has its
 * spinner there instead of a second block here.
 * @param {LiveSnapshot} live @param {Set<string>} calls
 */
function liveHtml(live, calls) {
	const parts = [];
	if (live.thinking) {
		parts.push(
			`<details class="think" data-key="think:live"><summary>Thinking</summary><pre>${esc(live.thinking)}</pre></details>`,
		);
	}
	if (live.text) parts.push(`<div class="a">${esc(live.text)}</div>`);
	for (const tool of live.tools) {
		if (!calls.has(tool.id)) parts.push(toolHtml(tool.name, tool.summary, undefined, tool.id, tool.running));
	}
	return parts.join("");
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
		else if (view === "list") bindList();
		else bindChat();
	}
	if (view === "list") updateList();
	else if (view !== "pair") updateChat();
}

function updateList() {
	$("#online").textContent = state.online ? "● online" : "offline";
	$("#online").classList.toggle("on", state.online);
	$("#banner").innerHTML = bannerHtml(undefined);
	$("#rows").innerHTML = rowsHtml();
	updateDirectories();
	const start = $("#start");
	start.disabled = state.starting !== undefined;
	start.textContent = state.starting ? "Starting…" : "Start";
}

/** Recent directories, then "Other…" for a typed path; the choice survives a refresh. */
function updateDirectories() {
	const select = $("#cwd");
	const options = state.directories.map((d) => `<option value="${esc(d)}">${esc(shortPath(d))}</option>`);
	const html = [...options, `<option value="">Other…</option>`].join("");
	if (select.dataset.html !== html) {
		// Only "Other…" offered yet is not a choice: the most recent directory becomes the default.
		const chosen = select.options.length > 1 ? select.value : undefined;
		select.innerHTML = html;
		select.dataset.html = html;
		if (chosen !== undefined && [...select.options].some((o) => o.value === chosen)) select.value = chosen;
	}
	$("#cwd-other").hidden = select.value !== "";
}

function updateChat() {
	const session = state.sessions.find((s) => s.id === state.open);
	const resuming = state.starting?.from !== undefined && state.starting.from === state.open;
	// Kept while a resumed session's row gives way to its pane's.
	if (!resuming) $("#title").textContent = session?.label ?? "";
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
	const stranded = session !== undefined && !session.alive && !session.resumable;
	// One pane starts at a time, so a resume waits for any start in flight.
	const blocked = resuming || stranded || (state.starting !== undefined && session?.resumable === true);
	const text = $("#text");
	text.disabled = blocked;
	$(".send").disabled = blocked;
	text.placeholder = resuming
		? "Starting…"
		: stranded
			? "Not running: open it on the Mac"
			: session?.resumable
				? "Reply resumes it"
				: "Reply";
}

function bindPair() {
	$("#pair").addEventListener("submit", async (/** @type {Event} */ event) => {
		event.preventDefault();
		const code = $("#code").value.replace(/\D/g, "");
		try {
			const token = await api.pair(code, deviceName());
			try {
				setToken(token);
			} catch {
				$("#pair-error").textContent = "This browser blocks storage; remote control needs it";
				return;
			}
			render();
			connect();
		} catch (error) {
			$("#pair-error").textContent = errorText(error instanceof Error ? error.message : String(error));
		}
	});
}

/** @param {HTMLTextAreaElement} text */
function grow(text) {
	text.style.height = "auto";
	text.style.height = `${Math.min(text.scrollHeight, 140)}px`;
}

function bindList() {
	const task = $("#task");
	task.addEventListener("input", () => grow(task));
	$("#cwd").addEventListener("change", () => {
		const other = $("#cwd-other");
		other.hidden = $("#cwd").value !== "";
		if (!other.hidden) other.focus();
	});
	$("#new-task").addEventListener("submit", (/** @type {Event} */ event) => {
		event.preventDefault();
		void startTask();
	});
}

async function startTask() {
	const task = $("#task");
	const value = task.value.trim();
	const cwd = $("#cwd").value || $("#cwd-other").value.trim();
	if (!value || state.starting) return;
	if (!cwd) {
		state.error = "Type the directory to start it in.";
		render();
		return;
	}
	state.starting = {};
	render();
	try {
		const { pane } = await api.start(cwd, value);
		task.value = "";
		grow(task);
		waitForPane(pane);
	} catch (error) {
		state.starting = undefined;
		handleError(error);
	}
}

function bindChat() {
	const text = $("#text");
	text.addEventListener("input", () => grow(text));
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
	const resume = state.sessions.find((s) => s.id === id)?.resumable === true;
	if (!value || !id || (resume && state.starting)) return;
	if (resume) state.starting = { from: id };
	text.value = "";
	text.style.height = "auto";
	const before = userCount(state.messages, value) + state.pending.filter((p) => p.text === value).length;
	state.pending.push({ text: value, before });
	render();
	$("#scroll").scrollTop = $("#scroll").scrollHeight;
	try {
		const { pane } = await api.prompt(id, value);
		if (pane) waitForPane(pane, id);
		else if (resume) {
			state.starting = undefined;
			render();
		}
	} catch (error) {
		if (resume) state.starting = undefined;
		const failed = state.pending.map((p) => p.text).lastIndexOf(value);
		if (failed >= 0) state.pending.splice(failed, 1);
		for (const p of state.pending.slice(Math.max(failed, 0))) if (p.text === value) p.before--;
		if (!text.value) text.value = value;
		handleError(error);
	}
}

// ---- routing ----

function route() {
	const match = /^#s\/(.+)$/.exec(location.hash);
	const open = match ? decodeURIComponent(match[1]) : undefined;
	if (open !== state.open) {
		// Following a resumed session to its pane keeps the reply on screen until pi writes it.
		if (open === undefined || open !== followed) state.pending = [];
		followed = undefined;
		state.open = open;
		state.messages = [];
		state.messagesLoaded = false;
		state.live = undefined;
		liveEnded = false;
		clearTimeout(liveClear);
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
