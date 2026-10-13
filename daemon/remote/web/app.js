// @ts-check
/**
 * bluclawd's remote control on a phone: the session list (agent view's bands) with a composer
 * that starts a session, and one session's chat, whose title opens its status sheet. Only the
 * parts that change are re-rendered, so the composers keep their text, focus and keyboard while
 * updates arrive.
 */
import { api, getToken, setToken, Unauthorized } from "./api.js";
import { settle } from "./live.js";

/** @typedef {{ id: string, label: string, cwd: string, band: string, state: string, alive: boolean, resumable: boolean, detail: string, createdAt?: string, finishedAt?: string }} Session */
/** @typedef {{ kind: string, id: string, text?: string, thinking?: string, tools?: {id: string, name: string, summary: string}[], error?: string, toolCallId?: string, toolName?: string, ok?: boolean, truncated?: boolean }} Message */
/** @typedef {{ text: string, thinking?: string, tools: {id: string, name: string, summary: string, running: boolean}[] }} LiveSnapshot */
/** @typedef {{ provider: string, id: string, name?: string }} ReportModel */
/** @typedef {{ model?: ReportModel, models: ReportModel[], thinkingLevel?: string, context?: { tokens: number | null, contextWindow: number, percent: number | null }, usage?: { input: number, output: number, cacheRead: number, cacheWrite: number, cost: number } }} Report */

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
/** A compaction with nothing to compact, or one the pane skipped as busy, reports nothing. */
const COMPACT_GIVE_UP_MS = 120_000;
/** A tree, fork or clone the pane skipped (or one that changed nothing) shows nothing either. */
const NAVIGATE_GIVE_UP_MS = 15_000;
const SCREEN_POLL_MS = 2000;
/** pi redraws a moment after a key reaches it. */
const SCREEN_SETTLE_MS = 150;
/** The terminal sheet's keys: tmux's name, and the button's face. */
const PRESS = [
	["Up", "↑"],
	["Down", "↓"],
	["Left", "←"],
	["Right", "→"],
	["Enter", "⏎"],
	["Escape", "Esc"],
	["Tab", "Tab"],
];
const ERRORS = {
	session_not_running: "This session is not running. Open it on the Mac to continue.",
	session_busy: "The session is busy. Try again once it is done.",
	no_status: "This session has not reported its status yet.",
	invalid_cwd: "That directory does not exist on the Mac.",
	invalid_model: "That model name is not valid.",
	invalid_entry: "That message is no longer in this session.",
	not_moved: "The session did not move.",
	invalid_keys: "That can't be typed into the session. Use the keys for Enter, Tab and Esc.",
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
	push_denied: "Notifications are off for bluclawd. Turn them on in Settings › Notifications.",
	invalid_subscription: "The Mac did not accept this phone's notification subscription.",
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
	/** Show "Enable notifications". */
	offerPush: false,
	/** The open session's status sheet. */
	sheetOpen: false,
	/** Its pane's report: undefined while loading, null when it has sent none. @type {Report | null | undefined} */
	report: undefined,
	/** Compact was asked for and the pane has not reported since. */
	compacting: false,
	/** Tree, fork or clone was asked for and the open chat's transcript has not changed since. */
	navigating: false,
	/** The message whose actions the sheet shows instead of the status. @type {{ id: string, text: string, kind: string } | undefined} */
	menu: undefined,
	/** The terminal sheet: the pane's screen, and keys to answer its dialog with. */
	terminal: false,
	/** What the pane shows: undefined while loading. @type {string[] | undefined} */
	screen: undefined,
	/** Keys or text are on their way to the pane. */
	typing: false,
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
let statusRequest = 0;
let screenRequest = 0;
/** @type {ReturnType<typeof setInterval> | undefined} */
let screenTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let startTimer;
/** The reply on screen has ended (or may have, while the stream was down): see settle(). */
let liveEnded = false;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let liveClear;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let compactGiveUp;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let navigateGiveUp;
/** The transcript a tree, fork or clone left, to tell on a reconnect whether it has moved. */
let navigatedFrom = "";
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

async function loadStatus() {
	const id = state.open;
	if (!id || !state.sheetOpen) return;
	const request = ++statusRequest;
	/** @type {Report | null} */
	let report;
	try {
		report = await api.status(id);
	} catch (error) {
		if (!(error instanceof Error && error.message === "no_status")) {
			handleError(error);
			return;
		}
		report = null;
	}
	if (state.open !== id || request !== statusRequest) return;
	state.report = report;
	render();
}

async function loadScreen() {
	const id = state.open;
	if (!id || !state.terminal) return;
	const request = ++screenRequest;
	try {
		const lines = await api.screen(id);
		if (state.open !== id || !state.terminal || request !== screenRequest) return;
		state.screen = lines;
		render();
	} catch (error) {
		handleError(error);
	}
}

/** While the terminal sheet is open and the app is on screen. */
function pollScreen() {
	clearInterval(screenTimer);
	screenTimer = undefined;
	if (state.terminal && document.visibilityState === "visible") {
		screenTimer = setInterval(() => void loadScreen(), SCREEN_POLL_MS);
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
		void checkPush();
		// Its end may have been missed while the stream was down; one still streaming is sent again at once.
		if (state.live) endLive();
		void loadSessions();
		// A "messages" event missed while the stream was down would have ended the wait.
		void loadMessages().then(() => {
			if (state.navigating && transcriptKey(state.messages) !== navigatedFrom) endNavigating();
		});
		void loadStatus();
	};
	current.addEventListener("sessions", () => {
		alive();
		void loadSessions();
	});
	current.addEventListener("messages", () => {
		alive();
		endNavigating();
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
	current.addEventListener("status", (/** @type {MessageEvent} */ event) => {
		alive();
		if (JSON.parse(event.data).sessionId !== state.open) return;
		state.compacting = false;
		void loadStatus();
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

// ---- notifications ----

function pushSupported() {
	return standalone() && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** Offered until this device is subscribed: a re-paired phone keeps its permission but not its subscription. */
async function checkPush() {
	if (!pushSupported()) return;
	try {
		const { subscribed } = await api.pushKey();
		state.offerPush = Notification.permission !== "granted" || !subscribed;
		render();
	} catch (error) {
		handleError(error);
	}
}

let enablingPush = false;

async function enablePush() {
	// Asked before any await: iOS shows the prompt only while the tap still counts as a user gesture.
	const permission = Notification.requestPermission();
	if (enablingPush) return;
	enablingPush = true;
	try {
		if ((await permission) !== "granted") throw new Error("push_denied");
		const { publicKey } = await api.pushKey();
		const { pushManager } = await navigator.serviceWorker.ready;
		// One made for an earlier key (a reset remote.json) cannot be reused.
		await (await pushManager.getSubscription())?.unsubscribe();
		const subscription = await pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: bytes(publicKey),
		});
		await api.subscribe(subscription.toJSON());
		state.offerPush = false;
		state.error = undefined;
		render();
	} catch (error) {
		handleError(error);
	} finally {
		enablingPush = false;
	}
}

/** @param {string} base64url */
function bytes(base64url) {
	const binary = atob(base64url.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
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
	return `<header class="bar"><h1>Sessions</h1><button class="notify" id="notify" hidden>Enable notifications</button>
<span class="muted" id="online"></span></header>
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
	return `<header class="bar"><a class="back" href="#">‹ Sessions</a><button class="title" id="title" aria-haspopup="dialog"></button>
<button class="stop" id="stop" hidden>Stop</button></header>
<div id="banner"></div><section class="scroll" id="scroll"><div class="log" id="log"></div></section>
<form class="composer" id="composer"><textarea id="text" rows="1" placeholder="Reply" aria-label="Reply" maxlength="32768"></textarea>
<button class="send" aria-label="Send"><span aria-hidden="true">↑</span></button></form>
<div class="backdrop" id="backdrop" hidden></div><section class="sheet" id="sheet" role="dialog" aria-label="Session status" hidden></section>`;
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
	/** @param {Message} m */
	const more = (m) =>
		`<button class="more" data-id="${esc(m.id)}" aria-label="${snippet(m.text) ? `Actions for “${esc(snippet(m.text))}”` : "Actions for this message"}" aria-haspopup="dialog">⋯</button>`;
	const last = state.messages.at(-1);
	for (const m of state.messages) {
		if (m.kind === "user") {
			parts.push(`<div class="mine">${more(m)}<div class="u">${esc(m.text)}</div></div>`);
		} else if (m.kind === "assistant") {
			if (m.thinking) {
				parts.push(
					`<details class="think" data-key="think:${esc(m.id)}"><summary>Thinking</summary><pre>${esc(m.thinking)}</pre></details>`,
				);
			}
			// A reply of its own, not a step between tool calls, and not where the session already is.
			const back = m.text && !m.tools?.length && m !== last;
			if (m.text)
				parts.push(
					back
						? `<div class="theirs"><div class="a">${esc(m.text)}</div>${more(m)}</div>`
						: `<div class="a">${esc(m.text)}</div>`,
				);
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
		return `<div class="banner needs"><span>This session is waiting for an answer to a dialog. A reply sent here becomes its next prompt.</span>
<button class="answer" id="answer" aria-haspopup="dialog">Answer</button></div>`;
	}
	return "";
}

/** @param {number} count */
function tokens(count) {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

/** @param {Report} report */
function modelOptions(report) {
	const current = report.model;
	let html = current ? "" : `<option value="" selected disabled>None selected</option>`;
	report.models.forEach((model, index) => {
		if (model.provider !== report.models[index - 1]?.provider) {
			html += `${index ? "</optgroup>" : ""}<optgroup label="${esc(model.provider)}">`;
		}
		const selected = current?.provider === model.provider && current.id === model.id ? " selected" : "";
		html += `<option value="${index}"${selected}>${esc(model.name ?? model.id)}</option>`;
	});
	return report.models.length ? `${html}</optgroup>` : html;
}

/** @param {Report["context"]} context */
function contextHtml(context) {
	if (!context) return "Unknown";
	if (context.tokens === null || context.percent === null) {
		return `${esc(tokens(context.contextWindow))} window · known after the next reply`;
	}
	const percent = Math.min(100, Math.max(0, context.percent));
	// A class per 10%: the CSP allows no inline style for a width.
	const step = Math.ceil(percent / 10) * 10;
	const level = percent >= 85 ? " full" : percent >= 60 ? " high" : "";
	return `<div class="gauge" role="meter" aria-label="Context used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(Math.round(percent))}"><span class="p${esc(step)}${level}"></span></div>
<small>${esc(tokens(context.tokens))} of ${esc(tokens(context.contextWindow))} (${esc(Math.round(percent))}%)</small>`;
}

/** @param {Session | undefined} session */
function sheetHtml(session) {
	const report = state.report;
	const head = `<header class="sheet-bar"><h2>Status</h2><button class="close" id="sheet-close">Done</button></header>
${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}`;
	if (report === undefined) return `${head}<p class="muted">Loading…</p>`;
	if (report === null) {
		const why = session && !session.alive ? "session_not_running" : "no_status";
		return `${head}<p class="muted">${esc(errorText(why))}</p>`;
	}
	const usage = report.usage;
	const busy = isBusy(session);
	return `${head}<dl class="facts">
<dt><label for="model">Model</label></dt><dd><select id="model">${modelOptions(report)}</select></dd>
<dt>Thinking</dt><dd>${esc(report.thinkingLevel ?? "off")}</dd>
<dt>Context</dt><dd>${contextHtml(report.context)}</dd>
<dt>Tokens</dt><dd>${usage ? `↑ ${esc(tokens(usage.input))} in · ↓ ${esc(tokens(usage.output))} out${usage.cacheRead ? ` · R ${esc(tokens(usage.cacheRead))}` : ""}${usage.cacheWrite ? ` · W ${esc(tokens(usage.cacheWrite))}` : ""}` : "Unknown"}</dd>
<dt>Cost</dt><dd>${usage ? `$${esc(usage.cost.toFixed(3))}` : "Unknown"}</dd>
</dl><button class="compact" id="compact"${busy ? " disabled" : ""}>${state.compacting ? "Compacting…" : "Compact"}</button>
<button class="compact clone" id="clone"${busy ? " disabled" : ""}>Clone session</button>`;
}

/**
 * Waiting on an answer is mid-turn too, and compacting, going back or forking would cut the turn
 * short; a second one before the first has moved the session would race it.
 * @param {Session | undefined} session
 */
function isBusy(session) {
	return (
		session?.state === "working" ||
		session?.state === "needs" ||
		state.compacting ||
		state.navigating ||
		!session?.alive
	);
}

/** A message's first line, short enough for a button's label. @param {string | undefined} text */
function snippet(text) {
	const line = (text ?? "").trim().split("\n")[0];
	return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

/** @param {Session | undefined} session @param {{ id: string, text: string, kind: string }} menu */
function menuHtml(session, menu) {
	const busy = isBusy(session);
	const why = !session?.alive
		? errorText("session_not_running")
		: state.navigating
			? "Available once the session has moved."
			: "Available once the session is idle.";
	const disabled = busy ? " disabled" : "";
	const actions =
		menu.kind === "user"
			? `<button class="action" id="edit-new"${disabled}>Edit in a new session<small>A new session without this message and everything after it, with its text in the reply box.</small></button>
<button class="action" id="edit-here"${disabled}>Edit here<small>This message and everything after it leave this session's branch, and its text goes in the reply box.</small></button>`
			: `<button class="action" id="back-here"${disabled}>Go back to here<small>Everything after this reply leaves this session's branch.</small></button>`;
	return `<header class="sheet-bar"><h2>${menu.kind === "user" ? "Your message" : "Reply"}</h2><button class="close" id="sheet-close">Done</button></header>
<p class="quote">${esc(menu.text)}</p>${busy ? `<p class="muted">${esc(why)}</p>` : ""}
<div class="actions">${actions}</div>`;
}

function terminalHtml() {
	const keys = PRESS.map(
		([key, face]) => `<button class="press" data-press="${key}" aria-label="${key}">${face}</button>`,
	).join("");
	return `<header class="sheet-bar"><h2>Answer</h2><button class="close" id="sheet-close">Done</button></header>
<p class="error" id="term-error" hidden></p><pre class="screen" id="screen" tabindex="0" aria-label="The session's screen"></pre>
<div class="keys" role="group" aria-label="Keys">${keys}</div>
<form class="term-text" id="term-form"><input id="term-input" aria-label="Text to type" placeholder="Text to type" maxlength="1024" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="send">
<button class="term-send" id="term-send">Send</button></form>`;
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
	$("#notify").hidden = !state.offerPush;
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
	const banner = $("#banner");
	const bannerNow = bannerHtml(session);
	// Rebuilt only when it changes, so a tap on Answer is not lost to a refresh.
	if (banner.dataset.html !== bannerNow) {
		banner.innerHTML = bannerNow;
		banner.dataset.html = bannerNow;
	}
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
	updateSheet(session);
	const text = $("#text");
	text.disabled = blocked;
	$(".send").disabled = blocked || state.navigating;
	text.placeholder = resuming
		? "Starting…"
		: stranded
			? "Not running: open it on the Mac"
			: session?.resumable
				? "Reply resumes it"
				: "Reply";
}

/** Rebuilt only when it changes, so an open model picker is not reset under the finger. @param {Session | undefined} session */
function updateSheet(session) {
	const sheet = $("#sheet");
	const open = state.sheetOpen || state.menu !== undefined || state.terminal;
	sheet.hidden = !open;
	$("#backdrop").hidden = !open;
	if (!open) return;
	sheet.setAttribute(
		"aria-label",
		state.terminal ? "Answer the dialog" : state.menu ? "Message actions" : "Session status",
	);
	if (state.terminal) {
		updateTerminal(sheet);
		return;
	}
	const html = state.menu ? menuHtml(session, state.menu) : sheetHtml(session);
	if (sheet.dataset.html === html) return;
	sheet.innerHTML = html;
	sheet.dataset.html = html;
}

/** Built once, so the text field keeps its text and keyboard; then only the screen changes. @param {HTMLElement} sheet */
function updateTerminal(sheet) {
	if (sheet.dataset.html !== "terminal") {
		sheet.innerHTML = terminalHtml();
		sheet.dataset.html = "terminal";
	}
	const error = $("#term-error");
	error.textContent = state.error ?? "";
	error.hidden = !state.error;
	const buttons = /** @type {NodeListOf<HTMLButtonElement>} */ (sheet.querySelectorAll(".press, #term-send"));
	for (const button of buttons) button.disabled = state.typing;
	const screen = $("#screen");
	const text = state.screen ? state.screen.join("\n") : "Loading…";
	if (screen.textContent === text) return;
	const atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 40;
	screen.textContent = text;
	if (atBottom) screen.scrollTop = screen.scrollHeight;
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
	$("#notify").addEventListener("click", () => void enablePush());
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
	$("#title").addEventListener("click", openSheet);
	$("#banner").addEventListener("click", (/** @type {Event} */ event) => {
		if (/** @type {Element} */ (event.target).closest("#answer")) openTerminal();
	});
	$("#backdrop").addEventListener("click", closeSheet);
	const sheet = $("#sheet");
	sheet.addEventListener("click", (/** @type {Event} */ event) => {
		const target = /** @type {Element} */ (event.target);
		if (target.closest("#sheet-close")) closeSheet();
		else if (target.closest("#compact")) void compact();
		else if (target.closest("#clone")) void move((id) => api.clone(id));
		else if (target.closest("#edit-new")) edit("fork");
		else if (target.closest("#edit-here")) edit("tree");
		else if (target.closest("#back-here")) goBack();
		else if (target.closest(".press")) {
			const key = /** @type {HTMLElement} */ (target.closest(".press")).dataset.press;
			if (key) void answer({ keys: [key] });
		}
	});
	sheet.addEventListener("submit", (/** @type {Event} */ event) => {
		event.preventDefault();
		const text = $("#term-input")?.value;
		if (text) void answer({ text });
	});
	$("#log").addEventListener("click", (/** @type {Event} */ event) => {
		const more = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest(".more"));
		const message = state.messages.find(
			(m) => (m.kind === "user" || m.kind === "assistant") && m.id === more?.dataset.id,
		);
		if (!message) return;
		state.menu = { id: message.id, text: message.text ?? "", kind: message.kind };
		state.error = undefined;
		render();
	});
	sheet.addEventListener("change", (/** @type {Event} */ event) => {
		const target = /** @type {HTMLSelectElement} */ (event.target);
		if (target.id === "model") void switchModel(target.value);
	});
}

function openSheet() {
	state.sheetOpen = true;
	state.report = undefined;
	state.error = undefined;
	render();
	void loadStatus();
}

function closeSheet() {
	state.sheetOpen = false;
	state.compacting = false;
	state.menu = undefined;
	state.terminal = false;
	pollScreen();
	render();
}

function openTerminal() {
	state.terminal = true;
	state.sheetOpen = false;
	state.menu = undefined;
	state.screen = undefined;
	state.error = undefined;
	// A fresh text field, not the one left from the last time it was open.
	$("#sheet").dataset.html = "";
	render();
	void loadScreen();
	pollScreen();
}

/** Keys, or text, into the open session's pane; then its screen again. @param {{ keys: string[] } | { text: string }} input */
async function answer(input) {
	const id = state.open;
	if (!id || state.typing) return;
	state.typing = true;
	state.error = undefined;
	render();
	try {
		if ("keys" in input) await api.keys(id, input.keys);
		else {
			await api.type(id, input.text);
			const field = $("#term-input");
			if (field?.value === input.text) field.value = "";
		}
		setTimeout(() => void loadScreen(), SCREEN_SETTLE_MS);
	} catch (error) {
		handleError(error);
	} finally {
		state.typing = false;
		render();
	}
}

/**
 * Tree, fork or clone. The pane runs it on its next heartbeat, and the open chat's transcript
 * changes once it has (a clone's row follows it with the same messages, in a new file). Until
 * then Send and these actions wait: what they sent would go to the session or branch being left.
 * The sheet closes at once, and an error shows on the chat.
 * @param {(id: string) => Promise<unknown>} call @param {string} [fill] the reply box's text once asked
 */
async function move(call, fill) {
	const id = state.open;
	if (!id) return;
	closeSheet();
	state.navigating = true;
	navigatedFrom = transcriptKey(state.messages);
	clearTimeout(navigateGiveUp);
	// The reply box may hold an edit's text, which would go to the session as it is.
	navigateGiveUp = setTimeout(() => {
		if (!state.navigating) return;
		state.error = errorText("not_moved");
		endNavigating();
	}, NAVIGATE_GIVE_UP_MS);
	render();
	try {
		await call(id);
		if (state.open !== id || fill === undefined) return;
		const text = $("#text");
		text.value = fill;
		grow(text);
	} catch (error) {
		endNavigating();
		handleError(error);
	}
}

/** @param {Message[]} messages */
function transcriptKey(messages) {
	return messages.map((m) => m.id).join("\n");
}

function endNavigating() {
	clearTimeout(navigateGiveUp);
	if (!state.navigating) return;
	state.navigating = false;
	render();
}

/** A message of yours, again in the reply box: in a new session, or here. @param {"fork" | "tree"} how */
function edit(how) {
	const menu = state.menu;
	if (!menu) return;
	// The transcript shows an image as an "[Image]" line; only the text goes back, as pi's editor gets it.
	const text = menu.text
		.split("\n")
		.filter((line) => line !== "[Image]")
		.join("\n");
	void move((id) => api[how](id, menu.id), text);
}

/** Back to a reply, which stays. */
function goBack() {
	const menu = state.menu;
	if (menu) void move((id) => api.tree(id, menu.id));
}

/** The pane reports the switch within a heartbeat, which refreshes the sheet. @param {string} value */
async function switchModel(value) {
	const id = state.open;
	const model = state.report?.models[Number(value)];
	if (!id || !model) return;
	try {
		await api.setModel(id, model.provider, model.id);
		void loadStatus();
	} catch (error) {
		// Back to the model the pane reported.
		$("#sheet").dataset.html = "";
		handleError(error);
	}
}

async function compact() {
	const id = state.open;
	if (!id) return;
	state.compacting = true;
	clearTimeout(compactGiveUp);
	compactGiveUp = setTimeout(() => {
		state.compacting = false;
		render();
	}, COMPACT_GIVE_UP_MS);
	render();
	try {
		await api.compact(id);
	} catch (error) {
		state.compacting = false;
		handleError(error);
	}
}

async function send() {
	const text = $("#text");
	const value = text.value.trim();
	const id = state.open;
	const resume = state.sessions.find((s) => s.id === id)?.resumable === true;
	if (!value || !id || state.navigating || (resume && state.starting)) return;
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
		state.sheetOpen = false;
		state.report = undefined;
		state.compacting = false;
		state.navigating = false;
		clearTimeout(navigateGiveUp);
		state.menu = undefined;
		state.terminal = false;
		state.screen = undefined;
		pollScreen();
		connect();
	}
	render();
}

window.addEventListener("hashchange", route);
// iOS suspends a backgrounded app's stream: reopen it on return.
document.addEventListener("visibilitychange", () => {
	pollScreen();
	if (document.visibilityState === "visible") {
		connect();
		void loadScreen();
	}
});
setInterval(() => {
	if (shown === "list") updateList();
}, 30_000);
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("sw.js").catch(() => {});
	// A notification tapped while the app is open: sw.js asks it to open that session.
	navigator.serviceWorker.addEventListener("message", (/** @type {MessageEvent} */ event) => {
		const id = event.data?.open;
		if (typeof id === "string") location.hash = `#s/${encodeURIComponent(id)}`;
	});
}

state.open = /^#s\/(.+)$/.exec(location.hash)?.[1];
if (state.open) state.open = decodeURIComponent(state.open);
render();
connect();
