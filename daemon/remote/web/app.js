// @ts-check
/**
 * bluclawd's remote control on a phone: the session list (agent view's bands) with a composer
 * that starts a session, and one session's chat, whose title and status bar open its status sheet. Only the
 * parts that change are re-rendered, so the composers keep their text, focus and keyboard while
 * updates arrive.
 */
import { api, clearToken, getToken, pairLink, setToken, Unauthorized } from "./api.js";
import { addPending, applyLatest, applyOlder, checkPending, endLive, forget, listed, openChat } from "./chat.js";
import { diffCounts, diffHtml } from "./diff.js";
import { ICONS } from "./icons.js";
import { dataUrl, isImageFile, readImage } from "./image.js";
import { ageAt, STATE_WORDS, sessionGroups, statusGlyph, successor, viewMode } from "./list.js";
import { refused, shownText } from "./live.js";
import { markdown } from "./markdown.js";
import { loaderHtml } from "./mascot.js";
import { diffSummary, groupSummary, markerKind, resultSummary } from "./output.js";
import { closePicker, modelGroups, openPicker } from "./picker.js";
import { filterSessions, fold, matchCommands } from "./search.js";
import {
	backgroundUsageHtml,
	barHtml,
	compactLines,
	contextLevel,
	elapsedText,
	settingsHtml,
	spanStyle,
	TRUST,
	tokens,
	whereHtml,
} from "./statusbar.js";

/**
 * `sessionId`: pi's, the same under another row id; `dialog`: the one it waits on, while it needs input.
 * @typedef {{ id: string, label: string, cwd: string, band: string, state: string, alive: boolean, detail: string, createdAt?: string, finishedAt?: string, sessionId?: string, dialog?: { kind: string, title?: string } }} Session
 */
/** `aborted`: a reply its turn was stopped in, empty when stopped before it said anything. @typedef {{ kind: string, id: string, text?: string, thinking?: string, tools?: {id: string, name: string, summary: string}[], error?: string, aborted?: boolean, toolCallId?: string, toolName?: string, command?: string, ok?: boolean, truncated?: boolean, diff?: string, diffTruncated?: boolean, images?: {index: number, mimeType: string}[] }} Message */
/** @typedef {{ text: string, thinking?: string, tools: {id: string, name: string, summary: string, running: boolean}[] }} LiveSnapshot */
/** @typedef {{ id: string, name: string, createdAt: string, lastUsedAt?: string, current: boolean }} Device `current`: this one */
/** @typedef {import("./image.js").Attachment} Attachment */
/** @typedef {import("./statusbar.js").Report} Report */

/** This build's version, as sw.js caches it (a test keeps the two the same). */
const VERSION = "0.0.44";
const VIEW_MODE_KEY = "bluclawd-view-mode";

function loadViewMode() {
	try {
		return viewMode(localStorage.getItem(VIEW_MODE_KEY));
	} catch {
		return viewMode(null);
	}
}
const OFFLINE_AFTER_MS = 5000;
/** The server pings every 25 s; a stream silent for longer is dead even if the browser has not noticed. */
const WATCHDOG_MS = 35_000;
/** A pane that has not registered by then did not start (pi failed, or tmux did). */
const START_TIMEOUT_MS = 60_000;
/** How long a finished reply stays on screen without a transcript fetch that has it. */
const LIVE_CLEAR_MS = 3000;
/** A sent prompt the session neither ran nor wrote by then never reached it (pi turns one away while compacting). */
const PROMPT_GIVE_UP_MS = 20_000;
/** An error shows this long, unless a tap or another screen ends it sooner. */
const ERROR_MS = 6000;
/** Less taken off the visible height than this is a toolbar, not the keyboard. */
const KEYBOARD_MIN = 120;
/** The daemon takes at most 4 images, 2 MB each (image.js makes a photo fit), with a prompt. */
const ATTACH_MAX = 4;
/** A pane takes a new name on its next heartbeat; the phone shows it meanwhile, this long at most. */
const RENAME_HOLD_MS = 15_000;
/** pi's entry ids, which a tool result's whole output is asked for by. */
const ENTRY_ID = /^[0-9a-f-]{8,36}$/;
const ERRORS = {
	session_not_running: "This session is not running. Open it on the Mac to continue.",
	pi_not_open: "pi is not open on the Mac. Open it in a terminal there to continue.",
	session_busy: "The session is busy. Try again once it is done.",
	no_status: "This session has not reported its status yet.",
	pane_too_old:
		"This session has not reported yet. Try again in a moment; if this persists, restart it (it may run an older bluclawd).",
	invalid_cwd: "That directory does not exist on the Mac.",
	invalid_model: "That model name is not valid.",
	invalid_thinking: "The model does not offer that thinking level.",
	invalid_trust: "That trust mode is not one of always, ask or never.",
	invalid_entry: "That message is no longer in this session.",
	not_delivered: "Not delivered — check the session on the Mac.",
	unreachable: "Could not reach the Mac.",
	no_launch: "Run /remote-control in a pi on the Mac once, so the phone knows how to start pi.",
	start_failed: "The Mac could not start the session.",
	start_timeout: "The session did not start. Try again.",
	unknown_session: "This session is gone.",
	unknown_device: "That phone was removed already.",
	invalid_code: "That code is wrong or was already used. Run /remote-control on the Mac for a new one.",
	expired_code: "That code expired. Run /remote-control on the Mac for a new one.",
	invalid_handoff:
		"This app's pairing from Safari was used or expired. Type the code /remote-control shows on the Mac.",
	empty_prompt: "Type a message first.",
	prompt_too_large: "That message is too long.",
	body_too_large: "That message is too long.",
	invalid_image: "That image could not be sent.",
	image_too_large: "That image is too large to send, even made smaller.",
	images_need_running: "Images go only to a running session.",
	unreadable_image: "That image could not be read.",
	too_many_images: `Up to ${ATTACH_MAX} images at a time.`,
	internal_error: "Something went wrong on the Mac.",
	push_denied: "Notifications are off for bluclawd. Turn them on in Settings › Notifications.",
	invalid_subscription: "The Mac did not accept this phone's notification subscription.",
	invalid_name: "A name is 1 to 100 characters on one line.",
	invalid_pinned: "The Mac did not understand that pin.",
	session_running: "This session is running. Quit it on the Mac first, then delete it here.",
	unknown_entry: "That output is no longer in this session.",
	not_found: "The Mac does not know that request. It may run an older bluclawd.",
	terminal_command: "That command runs only on the Mac, so the phone does not send it.",
	command_refused: "That command runs only on the Mac, so the phone does not send it.",
	unsent_draft: "Clear the unsent text in this session's prompt on the Mac first, then send the command again.",
	forbidden: "Only the Mac removes another phone: run /remote-control there.",
	unknown_task: "That task has ended already.",
	no_output: "That task has no output to show.",
};

const state = {
	/** @type {Session[]} */ sessions: [],
	/** The chat open, none while the list shows. @type {import("./chat.js").Chat | undefined} */ chat: undefined,
	/** @type {string[]} */ directories: [],
	/** What a new session can start with. @type {import("./statusbar.js").ReportModel[]} */ models: [],
	/** The new session's model, "provider/id": pi's default when empty. */
	newModel: "",
	/** The directory field holds what was typed or picked, not the most recent directory it starts with. */
	cwdEdited: false,
	/** The folders the directory field's path may go on to. @type {string[]} */
	completions: [],
	/** What the session list is searched for. */
	query: "",
	viewMode: loadViewMode(),
	/**
	 * A pane started from here, until its row is listed (`pane` is unset while the request is out).
	 * @type {{ pane?: string } | undefined}
	 */
	starting: undefined,
	loaded: false,
	online: true,
	/** A terminal on the Mac shows pi: without one, every session is read only here. */
	terminalOpen: true,
	/** Show "Enable notifications". */
	offerPush: false,
	/** Paired in Safari: the Home Screen app is the one iOS notifies. */
	homeScreenHint: false,
	/** A new build's service worker took over: this page still runs the old one until it reloads. */
	updateReady: false,
	/** The list's ⋯ sheet, with "Disconnect this phone". */
	phoneSheet: false,
	/** Its Disconnect asks to be confirmed. */
	confirmDisconnect: false,
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
/** Older messages load this far (px) ahead of the log's top, so they are usually there when it is reached. */
const OLDER_MARGIN = 400;
const OLDER_RETRY_MS = 2000;
/** pistatusline draws its lines this wide, the most it is asked for, so nothing of them is cut; the
 *  room its flex separators fill is taken out again (compactLines), and the bar scrolls sideways. */
const STATUS_COLS = 200;
/** The status bar's width in characters its pistatusline lines were last asked for. */
/** Each session's commands for the reply box, as last fetched: they rarely change. @type {Map<string, import("./statusbar.js").Command[]>} */
const commandsCache = new Map();
const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
/** @type {ReturnType<typeof setTimeout> | undefined} */
let startTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let errorTimer;
/** Which view the DOM holds: "pair", "list" or "chat:<id>". */
let shown = "";
/** The next log update prepends older messages: it keeps what is on screen in place. */
let prepending = false;
/** @type {IntersectionObserver | undefined} */
let olderObserver;
/** Fetches a message's image as it nears the screen. @type {IntersectionObserver | undefined} */
let pictureObserver;
const PICTURES_MAX = 30;
/** Keeps the log where it was as images change size (see bindChat). @type {ResizeObserver | undefined} */
let pictureSizes;
/** The log was scrolled to its end before its last change of size. */
let stuck = true;
/** A finger on the status sheet's thinking slider. */
let sliding = false;
/** The last notice a pane's report carried (its `at`): each shows once. @type {number | undefined} */
let noticeAt;
/** A name just given, shown until the list has it (see holdRename). @type {{ id: string, name: string, until: number } | undefined} */
let renamed;
/** The count on the app's badge; none set yet. */
let badged = -1;
/**
 * A message for the list, shown by its next refresh (which would otherwise clear it).
 * @type {string | undefined}
 */
let notice;

/** @param {unknown} text */
function esc(text) {
	return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The transcript is rebuilt whenever it changes other than at its end: each reply's markdown is rendered once. */
/** @type {Map<string, string>} */
const rendered = new Map();
const RENDERED_MAX = 500;

/** @param {string | undefined} text */
function md(text = "") {
	let html = rendered.get(text);
	if (html === undefined) {
		if (rendered.size >= RENDERED_MAX) rendered.clear();
		html = markdown(text);
		rendered.set(text, html);
	}
	return html;
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
	const name = /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : "Browser";
	// Told apart from the browser it was added from, which stays paired.
	return standalone() ? `${name} (Home Screen)` : name;
}

/** @param {string} path */
function shortPath(path) {
	return path.replace(/^\/(Users|home)\/[^/]+/, "~");
}

function standalone() {
	return matchMedia("(display-mode: standalone)").matches || /** @type {any} */ (navigator).standalone === true;
}

// ---- data ----

/** @param {unknown} error @param {string} [prefix] what failed, before why */
function handleError(error, prefix = "") {
	if (error instanceof Unauthorized) {
		source?.close();
		render();
		return;
	}
	showError(prefix + failure(error));
}

/** A refresh's: a dropped connection or a 5xx is the offline banner's business. @param {unknown} error */
function loadError(error) {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof TypeError || /^HTTP 5\d\d$/.test(message)) return;
	handleError(error);
}

/** Why a request failed, in words: a dropped connection or a 5xx is not raw text. @param {unknown} error */
function failure(error) {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof TypeError) return errorText("unreachable");
	return errorText(/^HTTP 5\d\d$/.test(message) ? "internal_error" : message);
}

/** Until the next tap, another screen, or ERROR_MS: a refresh does not take it away. @param {string} text */
function showError(text) {
	state.error = text;
	clearTimeout(errorTimer);
	errorTimer = setTimeout(() => {
		state.error = undefined;
		render();
	}, ERROR_MS);
	render();
}

async function loadSessions() {
	try {
		const asked = Date.now();
		const chat = state.chat;
		const was = chat && state.sessions.find((s) => s.id === chat.id)?.state;
		const list = await api.sessions();
		state.sessions = list.sessions;
		state.terminalOpen = list.terminalOpen !== false;
		holdRename();
		if (chat && state.chat === chat && listed(chat, was, state.sessions.find((s) => s.id === chat.id)?.state, asked))
			void loadMessages();
		state.loaded = true;
		badge(state.sessions.filter((s) => s.state === "needs").length);
		if (notice) showError(notice);
		notice = undefined;
		const starting = state.starting;
		if (starting?.pane && state.sessions.some((s) => s.id === starting.pane)) {
			state.starting = undefined;
			clearTimeout(startTimer);
			// A task started from the list opens, unless another screen was opened meanwhile.
			if (!state.chat) {
				location.hash = `#s/${encodeURIComponent(starting.pane)}`;
				return;
			}
		}
		// The open session under another row id (it quit on the Mac, or was opened there again): followed,
		// without a history entry for the old one.
		const open = state.chat && state.sessions.find((s) => s.id === state.chat.id);
		if (open) state.chat.openSessionId = open.sessionId;
		else if (state.chat) {
			const next = successor(state.sessions, state.chat.id, state.chat.openSessionId);
			if (next) {
				state.chat.next = next;
				location.replace(`#s/${encodeURIComponent(next)}`);
				return;
			}
		}
		render();
		if (!state.chat) {
			void loadDirectories();
			void loadModels();
		}
	} catch (error) {
		loadError(error);
	}
}

/** A name given from here shows until the list has it, or RENAME_HOLD_MS (a pane that did not take it). */
function holdRename() {
	const row = renamed && state.sessions.find((s) => s.id === renamed?.id);
	if (!renamed || !row || row.label === renamed.name || Date.now() > renamed.until) renamed = undefined;
	else row.label = renamed.name;
}

async function loadModels() {
	try {
		state.models = await api.models();
		render();
	} catch (error) {
		loadError(error);
	}
}

/** The Home Screen icon's badge: how many sessions wait on an answer. @param {number} count */
function badge(count) {
	if (count === badged || !("setAppBadge" in navigator)) return;
	badged = count;
	try {
		(count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
	} catch {
		// not allowed here (a browser tab rather than the Home Screen app)
	}
}

async function loadDirectories() {
	try {
		state.directories = await api.directories();
		render();
	} catch (error) {
		loadError(error);
	}
}

/** @param {string} pane */
function waitForPane(pane) {
	const starting = { pane };
	state.starting = starting;
	clearTimeout(startTimer);
	startTimer = setTimeout(() => {
		if (state.starting !== starting) return;
		state.starting = undefined;
		// What was sent reached no session.
		if (state.chat) state.chat.pending = [];
		showError(errorText("start_timeout"));
	}, START_TIMEOUT_MS);
	void loadSessions();
}

async function loadMessages() {
	const chat = state.chat;
	if (!chat) return;
	const request = ++chat.messagesRequest;
	try {
		const page = await api.messages(chat.id);
		if (state.chat !== chat || request !== chat.messagesRequest) return;
		applyLatest(chat, page);
		render();
	} catch (error) {
		loadError(error);
	}
}

/** The page before the first message shown, put above it; again while the top stays in view. */
async function loadOlder() {
	const chat = state.chat;
	const first = chat?.messages[0];
	// An old session file's messages have no ids to page by.
	if (!chat || !first?.id || !chat.more || chat.loadingOlder) return;
	chat.loadingOlder = true;
	render();
	let failed = false;
	try {
		const page = await api.messages(chat.id, first.id);
		if (state.chat === chat && applyOlder(chat, first, page)) prepending = true;
	} catch (error) {
		failed = true;
		loadError(error);
	}
	if (state.chat !== chat) return;
	chat.loadingOlder = false;
	render();
	// The observer only reports a change: a short or dropped page can leave the top in view, and so
	// can a failed one, tried again a little later so that it does not repeat as fast as it fails.
	if (!failed) {
		if ($("#scroll").scrollTop < OLDER_MARGIN) void loadOlder();
	} else {
		setTimeout(() => {
			if (state.chat === chat && $("#scroll")?.scrollTop < OLDER_MARGIN) void loadOlder();
		}, OLDER_RETRY_MS);
	}
}

/** For the status bar too, so whenever a chat is open. */
async function loadStatus() {
	const chat = state.chat;
	if (!chat) return;
	const request = ++chat.statusRequest;
	/** @type {Report | null} */
	let report;
	try {
		report = await api.status(chat.id, STATUS_COLS);
	} catch (error) {
		if (!(error instanceof Error && error.message === "no_status")) {
			loadError(error);
			return;
		}
		report = null;
	}
	if (state.chat !== chat || request !== chat.statusRequest) return;
	chat.report = report;
	// A pane has them once it has reported.
	if (report && !chat.commandsAsked) {
		chat.commandsAsked = true;
		void loadCommands();
	}
	for (const task of chat.stoppingTasks) {
		if (!report?.tasks?.some((t) => t.id === task)) chat.stoppingTasks.delete(task);
	}
	// Why the pane did not run a slash command sent from here.
	const skipped = report?.notice;
	if (skipped && skipped.at !== noticeAt) {
		noticeAt = skipped.at;
		showError(skipped.text);
		return;
	}
	render();
}

/** The open session's commands, for the reply box's suggestions; none until its pane reports them. */
async function loadCommands() {
	const chat = state.chat;
	if (!chat) return;
	try {
		const commands = await api.commands(chat.id);
		commandsCache.set(chat.id, commands);
		if (state.chat === chat) render();
	} catch (error) {
		// Only suggestions: a failure leaves the ones cached, and the next open asks again.
		if (error instanceof Unauthorized) handleError(error);
	}
}

/**
 * pistatusline's lines, span by span: each one's colours are set on its element, which the CSP
 * allows where it refuses a style attribute. Rebuilt only when they or the appearance change.
 * @param {HTMLElement} bar @param {import("./statusbar.js").StatusSpan[][]} lines
 */
function paintStatusline(bar, lines) {
	const dark = darkScheme.matches;
	const key = `${dark}:${JSON.stringify(lines)}`;
	if (bar.dataset.html === key) return;
	bar.dataset.html = key;
	bar.classList.add("pistatusline");
	bar.replaceChildren(
		...compactLines(lines).map((spans) => {
			const line = document.createElement("span");
			line.className = "sl";
			for (const span of spans) {
				const run = document.createElement("span");
				const { color, background, classes } = spanStyle(span, dark);
				run.textContent = span.text;
				if (classes.length) run.className = classes.join(" ");
				if (color) run.style.color = color;
				if (background) run.style.backgroundColor = background;
				line.append(run);
			}
			return line;
		}),
	);
	bar.hidden = lines.length === 0;
}

/** Faded at its right edge until swiped to its end (see style.css). @param {HTMLElement} bar */
function markStatuslineEnd(bar) {
	bar.classList.toggle("end", bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 1);
}

/** The reply on screen stays until a transcript fetch has it, which pi may not have written yet. */
function replyEnded() {
	const chat = state.chat;
	if (!chat) return;
	clearTimeout(chat.liveClear);
	endLive(chat);
	chat.liveClear = setTimeout(() => {
		chat.live = undefined;
		if (state.chat === chat) render();
	}, LIVE_CLEAR_MS);
}

/** @param {boolean} online */
function setOnline(online) {
	if (state.online === online) return;
	state.online = online;
	render();
}

/** Closed, and nothing waits on it: a closed stream is not the Mac being offline. */
function closeStream() {
	source?.close();
	source = undefined;
	clearTimeout(offlineTimer);
	clearTimeout(watchdog);
	offlineTimer = watchdog = undefined;
}

/**
 * One stream, reopened for the session on screen; any (re)open refetches everything. None while
 * the app is hidden: the Mac takes an open one for the app being in front (see visibilitychange).
 */
function connect() {
	closeStream();
	if (!getToken() || document.visibilityState === "hidden") return;
	const current = api.events(state.chat?.id);
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
		if (state.chat?.live) replyEnded();
		void loadSessions();
		void loadMessages();
		void loadStatus();
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
		const chat = state.chat;
		if (!chat || sessionId !== chat.id) return;
		if (!live) {
			replyEnded();
			void loadMessages();
			return;
		}
		clearTimeout(chat.liveClear);
		chat.liveEnded = false;
		chat.live = live;
		render();
	});
	current.addEventListener("status", (/** @type {MessageEvent} */ event) => {
		alive();
		if (!state.chat || JSON.parse(event.data).sessionId !== state.chat.id) return;
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
		loadError(error);
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
		// One made for an earlier key (a reset remote.json) cannot be reused. The Mac forgets it too, so
		// it holds no dead endpoint should the new one fail.
		const old = await pushManager.getSubscription();
		if (old) {
			await old.unsubscribe();
			await api.unsubscribe();
		}
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
	return `<form class="pair" id="pair">
<img class="logo" src="mascot.svg" alt=""><h1>bluclawd</h1>
<p class="muted">On the Mac, run <code>/remote-control</code> and scan the QR code with your phone's camera. Can't scan? Type the 6-digit code shown under it.</p>
<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000" aria-label="Pairing code">
<button>Pair</button><div class="error" id="pair-error"></div></form>`;
}

function listShell() {
	return `<header class="bar"><h1>Sessions</h1><span class="dot" id="online" role="img"></span>
<button class="icon-btn" id="notify" aria-label="Turn on notifications" hidden>${ICONS.bell}</button><button class="icon-btn" id="phone-menu" aria-label="This phone" aria-haspopup="dialog">${ICONS.more}</button></header>
<div id="banner"></div><form class="search" id="search-form" role="search"><span class="field"><input type="search" id="search" placeholder="Search" aria-label="Search sessions" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
<button type="button" class="clear" id="search-clear" aria-label="Clear search" hidden>×</button></span>
<button type="button" class="cancel" id="search-cancel" hidden>Cancel</button></form>
<label class="view-mode">Group by <select id="view-mode" aria-label="Group sessions by"><option value="state">Status</option><option value="directory">Path</option></select></label>
<section class="scroll" id="rows"></section>
<div class="backdrop" id="backdrop" hidden></div><section class="sheet" id="sheet" role="dialog" aria-label="This phone" hidden></section>
<div class="commands" id="new-commands" role="listbox" aria-label="New task commands" hidden></div>
<form class="composer new" id="new-task"><div class="task-input"><textarea id="task" rows="1" placeholder="New task…" aria-label="New task" maxlength="32768"></textarea>
<button type="button" class="icon-btn" id="new-options" aria-label="Show task options" aria-expanded="false" aria-controls="new-resume new-model cwd-list new-where">${ICONS.updown}</button></div>
<button type="button" class="pick" id="new-resume" aria-haspopup="dialog">Resume a past session${ICONS.updown}</button>
<button type="button" class="pick" id="new-model" aria-label="Model" aria-haspopup="dialog" hidden></button>
<div class="commands dirs" id="cwd-list" role="listbox" aria-label="Directories" hidden></div>
<div class="where" id="new-where"><input id="cwd" placeholder="~/path/to/project" aria-label="Directory" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done">
<button class="start" id="start" aria-label="Start">${ICONS.send}</button></div></form>`;
}

/** @param {Session} s */
function rowHtml(s) {
	const glyph = s.alive && s.state === "working" ? '<span class="session-spinner"></span>' : statusGlyph(s);
	const status = STATE_WORDS[/** @type {keyof typeof STATE_WORDS} */ (s.state)] ?? s.state;
	// The project's folder, which the search matches too.
	const where = s.cwd.split("/").filter(Boolean).at(-1);
	// What it waits on or does; its band already names its state.
	const doing = s.dialog?.title || s.detail;
	const detail = [where, doing].filter(Boolean).join(" · ");
	return `<a class="row${s.alive ? "" : " closed"}" href="#s/${encodeURIComponent(s.id)}"><span class="glyph ${esc(s.state)}" aria-hidden="true">${glyph}</span>
<span class="name">${esc(s.label)}<small><span class="session-state ${esc(s.state)}">${esc(status)}</span>${detail ? ` · ${esc(detail)}` : ""}</small></span>
<span class="age">${age(ageAt(s))}</span></a>`;
}

function rowsHtml() {
	if (!state.loaded) return loaderHtml();
	if (state.sessions.length === 0) return `<p class="empty">No sessions. Start one below.</p>`;
	const found = filterSessions(state.sessions, state.query);
	if (found.length === 0) return `<p class="empty">No sessions match “${esc(state.query.trim())}”.</p>`;
	return sessionGroups(found, state.viewMode)
		.map(({ title, rows }) => `<h2 class="band">${esc(title)}</h2>${rows.map(rowHtml).join("")}`)
		.join("");
}

function chatShell() {
	return `<header class="bar"><a class="back icon-btn" href="#" aria-label="Sessions">${ICONS.back}</a><button class="title" id="title" aria-haspopup="dialog"></button>
<button class="tasks-pill" id="tasks-pill" aria-haspopup="dialog" hidden></button><button class="icon-btn stop" id="stop" aria-label="Stop" hidden>${ICONS.stop}</button></header>
<div class="statusbar" id="statusbar" role="button" tabindex="0" aria-haspopup="dialog" aria-label="Status" hidden></div>
<section class="scroll" id="scroll"><div class="older" id="older"></div><div class="log" id="log">
<div class="part" id="msgs"></div><div class="part" id="live"></div><div class="part" id="pending"></div><div class="part" id="working"></div></div></section>
<div id="banner"></div><div class="commands" id="commands" role="listbox" aria-label="Commands" hidden></div><div class="thumbs" id="thumbs" hidden></div>
<form class="composer" id="composer"><label class="attach" id="attach">${ICONS.attach}
<input type="file" id="file" accept="image/*" multiple aria-label="Attach photos"></label>
<textarea id="text" rows="1" placeholder="Reply" aria-label="Reply" maxlength="32768"></textarea>
<button class="send" aria-label="Send">${ICONS.send}</button></form>
<div class="backdrop" id="backdrop" hidden></div><section class="sheet" id="sheet" role="dialog" aria-label="Session status" hidden></section>
<div class="viewer" id="viewer" role="dialog" aria-label="Image" hidden><img id="viewer-img" alt="Image"></div>`;
}

/**
 * A message's images, each a button that shows it full screen; their `src` is set once fetched
 * (see showPictures), so the log's HTML stays small and the same while they load.
 * @param {Message} m
 */
function picturesHtml(m) {
	if (!m.images?.length) return "";
	const buttons = m.images.map(
		(image) =>
			`<button type="button" class="pic" data-entry="${esc(m.id)}" data-index="${esc(image.index)}" aria-label="Image ${esc(image.index + 1)}, full screen"><img alt="Image"></button>`,
	);
	return `<div class="pictures">${buttons.join("")}</div>`;
}

/** The `⎿` lines under a tool call, or under the turn an error or an interruption ended. @param {string[]} lines */
function outHtml(lines) {
	return `<span class="out"><span class="hook" aria-hidden="true">⎿</span><span class="lines">${esc(lines.join("\n"))}</span></span>`;
}

/**
 * A tool call: `● Bash(npm test)`, and what it did on a line under it
 * (output.js); a tap shows the whole output. An edit shows its diff at once.
 * @param {string} name @param {string} summary @param {Message | undefined} result @param {string} key @param {boolean} [running]
 */
function toolHtml(name, summary, result, key, running = false) {
	const call = `<span class="call"><span class="bullet" aria-hidden="true">●</span> <b>${esc(name.charAt(0).toUpperCase() + name.slice(1))}</b>${summary ? `(${esc(summary)})` : ""}</span>`;
	if (!result) return `<div class="t${running ? " running" : ""}">${call}</div>`;
	const kind = result.ok ? "t ok" : "t err";
	if (result.diff) {
		const { added, removed } = diffCounts(result.diff);
		return `<div class="${kind}">${call}${outHtml([diffSummary(added, removed)])}
${diffHtml(result.diff, result.diffTruncated)}</div>${picturesHtml(result)}`;
	}
	const full = state.chat.outputs.get(result.id);
	const text = shownText(full?.text ?? result.text ?? "", result.images);
	const cut = full?.text !== undefined ? full.truncated : result.truncated;
	const out = outHtml(resultSummary(name, { text, ok: result.ok, truncated: cut }));
	// Nothing more to show than its line; its images show without opening it.
	if (!text.trim()) return `<div class="${kind}">${call}${out}</div>${picturesHtml(result)}`;
	return `<details class="${kind}" data-key="${esc(key)}"><summary>${call}${out}</summary>
<pre>${esc(text)}${cut ? "\n…" : ""}</pre>${fullOutputHtml(result, full)}</details>${picturesHtml(result)}`;
}

/**
 * The button that fetches a cut-short output whole (see loadOutput), and why it failed if it did.
 * An old session file's messages have no ids to ask by.
 * @param {Message} result @param {{ text?: string, error?: string, loading?: boolean } | undefined} full
 */
function fullOutputHtml(result, full) {
	if (!result.truncated || !ENTRY_ID.test(result.id) || full?.text !== undefined) return "";
	const error = full?.error ? `<p class="error">${esc(full.error)}</p>` : "";
	const label = full?.loading ? "Loading…" : full?.error ? "Try again" : "Show full output";
	return `${error}<button type="button" class="full" data-entry="${esc(result.id)}"${full?.loading ? " disabled" : ""}>${label}</button>`;
}

/**
 * The log's four parts: the transcript, the reply in progress, the prompts sent and not yet in
 * the transcript, and the working line. Each is replaced only when it changes (see updatePart), so
 * a streamed chunk leaves the transcript alone: a selection in it, and its images, stay.
 * @param {Session | undefined} session
 */
function logParts(session) {
	const calls = new Set(state.chat.messages.flatMap((m) => (m.tools ?? []).map((t) => t.id)));
	const running = new Set((state.chat.live?.tools ?? []).filter((t) => t.running).map((t) => t.id));
	const live = state.chat.live ? liveHtml(state.chat.live, calls) : "";
	const pending = pendingHtml();
	// The reply in progress replaces the working line once it shows something.
	const streaming = live !== "" || running.size > 0;
	const working =
		session?.state === "working" && !streaming
			? `<div class="working">✻ ${esc(session.detail || "Working…")}</div>`
			: "";
	let msgs = transcriptHtml(calls, running);
	if (!msgs && !live && !pending && !working) {
		msgs = state.chat.messagesLoaded ? `<p class="empty">Nothing in this session yet.</p>` : loaderHtml();
	}
	return { msgs, live, pending, working };
}

/** @param {Set<string>} calls the transcript's tool calls @param {Set<string>} running those the reply in progress runs */
function transcriptHtml(calls, running) {
	/** @type {Map<string, Message>} */
	const results = new Map();
	for (const m of state.chat.messages) if (m.kind === "toolResult" && m.toolCallId) results.set(m.toolCallId, m);
	const parts = [];
	// Finished calls in a row, and the thinking between them, fold into one line (see groupHtml).
	/** @type {string[]} */
	let held = [];
	/** @type {string[]} */
	let names = [];
	let groupKey = "";
	const flush = () => {
		if (names.length) parts.push(groupHtml(names, held, groupKey));
		else parts.push(...held);
		held = [];
		names = [];
	};
	// The session's start is shown only once no older messages are left to load.
	let prompted = state.chat.more;
	for (const m of state.chat.messages) {
		// A call's result shows in its call's block, and a hidden marker not at all: neither ends the run.
		const ofCall = m.kind === "toolResult" && m.toolCallId && calls.has(m.toolCallId);
		const hidden = m.kind === "marker" && markerKind(m.text ?? "", !prompted) === "hidden";
		if (m.kind !== "assistant" && !ofCall && !hidden) flush();
		if (m.kind === "user") {
			prompted = true;
			parts.push(
				`<div class="u${m.images?.length ? " pics" : ""}">${picturesHtml(m)}${esc(shownText(m.text ?? "", m.images))}</div>`,
			);
		} else if (m.kind === "assistant") {
			if (m.thinking) held.push(thinkingBlock(m.thinking, `think:${m.id}`));
			if (m.text) {
				flush();
				parts.push(`<div class="a">${md(m.text)}</div>`);
			}
			for (const [index, tool] of (m.tools ?? []).entries()) {
				const key = tool.id || `${m.id}:${index}`;
				const result = results.get(tool.id);
				// What runs, or waits on its result, shows on its own.
				if (!result || running.has(tool.id)) {
					flush();
					parts.push(toolHtml(tool.name, tool.summary, result, key, running.has(tool.id)));
					continue;
				}
				if (!names.length) groupKey = `group:${key}`;
				names.push(tool.name);
				held.push(toolHtml(tool.name, tool.summary, result, key));
			}
			if (m.error || m.aborted) flush();
			if (m.error) parts.push(`<div class="t err">${outHtml([m.error])}</div>`);
			// Stopped from the phone or by Esc on the Mac.
			if (m.aborted) parts.push(`<div class="t interrupted">${outHtml(["Interrupted"])}</div>`);
		} else if (m.kind === "toolResult" && !(m.toolCallId && calls.has(m.toolCallId))) {
			// A `!` line's, which pi ran rather than the model: `● Bash(ls)`.
			parts.push(toolHtml(m.toolName ?? "tool", m.command ?? "", m, m.id));
		} else if (m.kind === "marker") {
			const kind = markerKind(m.text ?? "", !prompted);
			if (kind === "interrupted") parts.push(`<div class="t interrupted">${outHtml([m.text ?? ""])}</div>`);
			else if (kind === "plain") parts.push(`<div class="marker">${esc(m.text)}</div>`);
		}
	}
	flush();
	return parts.join("");
}

/**
 * Finished tool calls folded into one line: "▸ Ran 2 commands, edited a file";
 * a tap shows each call, and a tap on a call its output.
 * @param {string[]} names the calls' tools @param {string[]} blocks the calls', and the thinking between them @param {string} key
 */
function groupHtml(names, blocks, key) {
	return `<details class="run" data-key="${esc(key)}"><summary>${esc(groupSummary(names))}</summary><div class="steps">${blocks.join("")}</div></details>`;
}

/** Hidden until tapped. @param {string} thinking @param {string} key */
function thinkingBlock(thinking, key) {
	return `<details class="think" data-key="${esc(key)}"><summary>Thinking</summary><pre>${esc(thinking)}</pre></details>`;
}

/** Each sent prompt's images show large, from what was sent (see paintPending). */
function pendingHtml() {
	return state.chat.pending
		.map(({ id, prompt, images }) => {
			const buttons = images.map(
				(_, index) =>
					`<button type="button" class="pic" data-pending="${id}" data-index="${index}" aria-label="Image ${index + 1}, full screen"><img alt="Image"></button>`,
			);
			const pictures = buttons.length ? `<div class="pictures">${buttons.join("")}</div>` : "";
			return `<div class="u${pictures ? " pics" : ""}">${pictures}${esc(prompt)}</div><div class="queued">sent · waiting for the session</div>`;
		})
		.join("");
}

/**
 * The reply in progress, after the transcript. A tool call the transcript already shows has its
 * spinner there instead of a second block here.
 * @param {LiveSnapshot} live @param {Set<string>} calls
 */
function liveHtml(live, calls) {
	const parts = [];
	if (live.thinking) parts.push(thinkingBlock(live.thinking, "think:live"));
	if (live.text) parts.push(`<div class="a">${markdown(live.text)}</div>`);
	for (const tool of live.tools) {
		if (!calls.has(tool.id)) parts.push(toolHtml(tool.name, tool.summary, undefined, tool.id, tool.running));
	}
	return parts.join("");
}

/** A session the phone can prompt or change: running, with a terminal on the Mac showing pi. @param {Session | undefined} session */
function canAct(session) {
	return session?.alive === true && state.terminalOpen;
}

/** @param {Session | undefined} session */
function bannerHtml(session) {
	if (!state.online) {
		return `<div class="banner off">Mac unreachable — it may be asleep, offline, or remote control is off. Retrying…</div>`;
	}
	const error = state.error ? `<div class="banner off">${esc(state.error)}</div>` : "";
	if (state.loaded && !state.terminalOpen) {
		return `${error}<div class="banner closed">pi is not open on the Mac: everything here is read only until a terminal there shows it again.</div>`;
	}
	// A dialog is answered on the Mac, as pi asks it there: the phone only says what it waits on.
	if (session?.state === "needs") {
		const title = session.dialog?.title;
		const text = title ? `Waiting on the Mac: ${esc(title)}` : "Waiting for an answer on the Mac.";
		return `${error}<div class="banner needs">${text}</div>`;
	}
	if (session && !session.alive) {
		return `${error}<div class="banner closed">Disconnected: this session was closed on the Mac. It reconnects here once it is opened there again.</div>`;
	}
	if (error) return error;
	if (!session && state.homeScreenHint) {
		return `<div class="banner hint"><span>Now Share → Add to Home Screen. The app opens already paired.</span>
<button class="dismiss" id="dismiss-hint" aria-label="Dismiss">×</button></div>`;
	}
	return "";
}

function updateHtml() {
	return state.updateReady
		? `<div class="banner hint"><span>A new version of bluclawd is ready.</span>
<button class="answer" id="reload-app">Reload</button></div>`
		: "";
}

/** Its line, then its gauge. @param {Report["context"]} context */
function contextHtml(context) {
	if (!context) return "";
	if (context.tokens === null || context.percent === null) {
		return `<div class="context"><span>Context</span><span>${esc(tokens(context.contextWindow))} · after the next reply</span></div>`;
	}
	const percent = Math.min(100, Math.max(0, context.percent));
	// A class per 10%: the CSP allows no inline style for a width.
	const step = Math.ceil(percent / 10) * 10;
	const level = contextLevel(percent);
	const color = level === "normal" ? "" : ` ${level}`;
	return `<div class="context"><span>Context</span><span class="context-used ${level}">${esc(tokens(context.tokens))} / ${esc(tokens(context.contextWindow))} · ${esc(Math.round(percent))}%</span></div>
<div class="gauge" role="meter" aria-label="Context used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(Math.round(percent))}"><span class="p${esc(step)}${color}"></span></div>`;
}

/** Tokens and cost on one line. @param {Report["usage"]} usage */
function usageHtml(usage) {
	if (!usage) return "";
	const parts = [`↑ ${tokens(usage.input)}`, `↓ ${tokens(usage.output)}`];
	if (usage.cacheRead) parts.push(`R ${tokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W ${tokens(usage.cacheWrite)}`);
	parts.push(`$${usage.cost.toFixed(3)}`);
	return `<p class="meta">${esc(parts.join(" · "))}</p>`;
}

/** @param {Session | undefined} session */
function sheetHtml(session) {
	const report = state.chat.report;
	const pinned = session?.band === "pinned";
	const pin = session
		? `<button class="icon-btn${pinned ? " on" : ""}" id="pin" aria-label="${pinned ? "Unpin" : "Pin to the top"}" aria-pressed="${pinned}">${pinned ? ICONS.pinned : ICONS.pin}</button>`
		: "";
	const head = `<header class="sheet-bar"><h2>Status</h2><span class="sheet-tools">${pin}<button class="icon-btn close" id="sheet-close" aria-label="Close">${ICONS.close}</button></span></header>
${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}`;
	if (report === undefined) return `${head}${loaderHtml()}`;
	if (report === null) {
		const why = session && !session.alive ? "session_not_running" : "no_status";
		return `${head}<p class="muted">${esc(errorText(why))}</p>`;
	}
	return `${head}${settingsHtml(report)}
<div class="numbers">${contextHtml(report.context)}${usageHtml(report.usage)}${backgroundUsageHtml(report.backgroundSubagentUsage)}${whereHtml(report, session && shortPath(session.cwd))}</div>`;
}

/** Built once each time the sheet opens, so what is typed stays while the rest refreshes. @param {Session | undefined} session */
function renameHtml(session) {
	return `<form class="rename" id="rename-form"><label for="rename">Name</label>
<input id="rename" value="${esc(session?.label ?? "")}" maxlength="100" autocomplete="off" enterkeyhint="done">
<button class="save" id="rename-save" aria-label="Save name">${ICONS.check}</button></form>`;
}

/** For a stored session (none runs it), Delete, which asks first. @param {Session | undefined} session */
function manageHtml(session) {
	if (!session || session.alive) return "";
	const remove = state.chat.confirmDelete
		? `<div class="confirm-delete"><span>Delete it from the list? Its session file stays on the Mac.</span>
<button class="unpair cancel" id="delete-cancel">Cancel</button><button class="unpair" id="delete-confirm">Delete</button></div>`
		: `<button class="action danger" id="delete">Delete<small>Off the list; its session file stays on the Mac.</small></button>`;
	return `<div class="actions">${remove}</div>`;
}

const TASK_KINDS = { shell: "Shell", monitor: "Monitor", agent: "Agent" };

/** The pane's background tasks, as /tasks lists them: each one's output a tap away, and Stop, confirmed in place. */
function tasksHtml() {
	const tasks = state.chat.report?.tasks ?? [];
	const now = Date.now();
	const rows = tasks.map((task) => {
		const id = esc(task.id);
		const output = state.chat.taskOutputs.get(task.id);
		const stopping = state.chat.stoppingTasks.has(task.id);
		const kind = `${TASK_KINDS[task.kind] ?? task.kind}${task.foreground ? " · foreground" : ""}${task.status && task.status !== "running" ? ` · ${task.status}` : ""}${task.model ? ` · ${task.model}` : ""}`;
		const shown = output?.lines
			? `<pre class="task-out">${esc(output.lines.join("\n") || "(No output yet)")}</pre>`
			: output?.error
				? `<p class="error">${esc(errorText(output.error))}</p>`
				: "";
		const outputButton = task.output
			? `<button class="task-btn" data-output="${id}"${output?.loading ? " disabled" : ""}>${output?.loading ? "Loading…" : output?.lines ? "Hide output" : "Output"}</button>`
			: "";
		const stop =
			state.chat.confirmStop === task.id
				? `<div class="confirm-delete"><span>Stop this task?</span><button class="unpair cancel" data-stop-cancel>Cancel</button><button class="unpair" data-stop-confirm="${id}">Stop</button></div>`
				: `<button class="task-btn danger" data-stop="${id}"${stopping ? " disabled" : ""}>${stopping ? "Stopping…" : "Stop"}</button>`;
		return `<li class="task"><div class="task-head"><span class="task-kind">${esc(kind)}</span><span class="task-age">${esc(elapsedText(task.startedAt, now))}</span></div>
<div class="task-label">${esc(task.label)}</div><div class="task-actions">${outputButton}${stop}</div>${shown}</li>`;
	});
	return `<header class="sheet-bar"><h2>Background tasks</h2><button class="icon-btn close" id="sheet-close" aria-label="Close">${ICONS.close}</button></header>
${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}${rows.length ? `<ul class="tasks">${rows.join("")}</ul>` : `<p class="muted">No background tasks are running.</p>`}`;
}

// ---- render ----

function render() {
	const view = !getToken() ? "pair" : state.chat ? `chat:${state.chat.id}` : "list";
	if (view !== shown) {
		shown = view;
		closePicker();
		app.innerHTML = view === "pair" ? pairView() : view === "list" ? listShell() : chatShell();
		if (view === "pair") bindPair();
		else if (view === "list") bindList();
		else bindChat();
	}
	if (view === "list") updateList();
	else if (view !== "pair") updateChat();
}

function updateList() {
	const live = state.online && state.terminalOpen;
	const online = $("#online");
	const status = live ? "Online" : state.online ? "pi is closed on the Mac" : "Offline";
	online.setAttribute("aria-label", status);
	online.title = status;
	online.classList.toggle("on", live);
	$("#notify").hidden = !state.offerPush;
	const banner = $("#banner");
	const bannerNow = updateHtml() + bannerHtml(undefined);
	// Rebuilt only when it changes, so a tap on its dismiss button is not lost to a refresh.
	if (banner.dataset.html !== bannerNow) {
		banner.innerHTML = bannerNow;
		banner.dataset.html = bannerNow;
	}
	// Replaced only when it changes, so the loading mascot keeps rolling its eyes.
	const rows = rowsHtml();
	if ($("#rows").dataset.html !== rows) {
		$("#rows").innerHTML = rows;
		$("#rows").dataset.html = rows;
	}
	$("#search-clear").hidden = state.query === "";
	updateDirectories();
	updateModels();
	updateNewCommands();
	const start = $("#start");
	start.disabled = state.starting !== undefined || !state.terminalOpen;
	start.classList.toggle("busy", state.starting !== undefined);
	$("#new-task").classList.toggle("starting", state.starting !== undefined);
	updatePhoneSheet();
}

/** The list's ⋯ sheet: this phone's way out, confirmed in place. The Mac removes any other. */
function updatePhoneSheet() {
	const sheet = $("#sheet");
	sheet.hidden = $("#backdrop").hidden = !state.phoneSheet;
	if (!state.phoneSheet) return;
	const error = state.error ? `<p class="error">${esc(state.error)}</p>` : "";
	const action = state.confirmDisconnect
		? `<div class="confirm-delete"><span>Disconnect this phone? It will have to pair again.</span>
<button class="unpair cancel" id="disconnect-cancel">Cancel</button><button class="unpair" id="disconnect-confirm">Disconnect</button></div>`
		: `<button class="action danger" id="disconnect">Disconnect this phone<small>Only this one: it stops reaching the Mac until it pairs again. Other paired phones stay connected.</small></button>`;
	const html = `<header class="sheet-bar"><h2>This phone</h2><button class="icon-btn close" id="sheet-close" aria-label="Close">${ICONS.close}</button></header>
${error}<div class="actions">${action}</div><p class="version">bluclawd ${VERSION}</p>`;
	if (sheet.dataset.html === html) return;
	sheet.innerHTML = html;
	sheet.dataset.html = html;
}

/**
 * The directory field, which starts with the most recent directory, and its suggestions while it
 * has the focus: the recent directories that match what is typed, then the folders its path may go
 * on to (completeDirectory). A recent one is a choice; a folder is a step, as a shell's Tab.
 */
function updateDirectories() {
	const field = $("#cwd");
	if (!state.cwdEdited && field.value === "" && state.directories.length)
		field.value = shortPath(state.directories[0]);
	const list = $("#cwd-list");
	const typed = field.value.trim();
	const recent = state.directories
		.map(shortPath)
		.filter((d) => !state.cwdEdited || (d !== typed && fold(d).includes(fold(typed))));
	const folders = state.cwdEdited ? state.completions.map(shortPath).filter((d) => !recent.includes(d)) : [];
	/** @param {string} path @param {boolean} step */
	const item = (path, step) => {
		const cut = path.lastIndexOf("/");
		return `<button type="button" class="command" role="option" data-dir="${esc(path)}"${step ? " data-step" : ""}><b>${esc(path.slice(cut + 1) || path)}</b><small>${esc(path.slice(0, cut + 1))}</small></button>`;
	};
	const html = [...recent.map((d) => item(d, false)), ...folders.map((d) => item(d, true))].join("");
	if (list.dataset.html !== html) {
		list.innerHTML = html;
		list.dataset.html = html;
	}
	list.hidden = html === "" || document.activeElement !== field;
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let completing;

/** The folders the typed path may go on to, unless more was typed meanwhile. */
function completeDirectory() {
	clearTimeout(completing);
	const typed = $("#cwd").value.trim();
	if (!/^[~/]/.test(typed)) {
		state.completions = [];
		updateDirectories();
		return;
	}
	completing = setTimeout(async () => {
		try {
			const folders = await api.completeDirectory(typed);
			if ($("#cwd")?.value.trim() !== typed) return;
			state.completions = folders;
			updateDirectories();
		} catch (error) {
			if (error instanceof Unauthorized) handleError(error);
		}
	}, 150);
}

/** The new session's model, pi's default unless one the running panes offer is picked. */
function updateModels() {
	const button = $("#new-model");
	const model = state.models.find((m) => `${m.provider}/${m.id}` === state.newModel);
	const html = `<span>${esc(model ? (model.name ?? model.id) : "Default model")}</span>${ICONS.updown}`;
	if (button.dataset.html !== html) {
		button.innerHTML = html;
		button.dataset.html = html;
	}
	button.hidden = false;
}

async function pickResume() {
	/** @type {HTMLElement | null} */ (document.activeElement)?.blur();
	const cwd = $("#cwd").value.trim();
	openPicker({ title: "Looking for past sessions…", groups: [], value: "" }, () => {});
	try {
		const sessions = await api.pastSessions(cwd);
		openPicker(
			{
				title: sessions.length ? "Resume a past session" : "No past sessions in this directory",
				groups: [{ options: sessions.map((s) => ({ value: s.sessionFile, label: s.label })) }],
				value: "",
			},
			(file) => {
				const session = sessions.find((s) => s.sessionFile === file);
				if (!session) return;
				if (session.id) location.hash = `#s/${encodeURIComponent(session.id)}`;
				else void resumePast(session.cwd, file);
			},
		);
	} catch (error) {
		closePicker();
		handleError(error);
	}
}

/** @param {string} cwd @param {string} sessionFile */
async function resumePast(cwd, sessionFile) {
	state.starting = {};
	render();
	try {
		const { pane } = await api.resume(cwd, sessionFile);
		waitForPane(pane);
	} catch (error) {
		state.starting = undefined;
		handleError(error);
	}
}

const NEW_COMMANDS = [
	{ name: "cd", description: "Set the directory new sessions start in" },
	{ name: "model", description: "Set the model for new sessions" },
	{ name: "resume", description: "Resume a past session" },
];

function updateNewCommands() {
	const value = $("#task").value;
	const commands = value.startsWith("/") ? matchCommands(NEW_COMMANDS, value) : [];
	const list = $("#new-commands");
	list.innerHTML = commands
		.map(
			(c) =>
				`<button type="button" class="command" role="option" data-new-command="${c.name}"><b>/${c.name}</b><small>${esc(c.description)}</small></button>`,
		)
		.join("");
	list.hidden = commands.length === 0;
}

/** @param {string} name */
function runNewCommand(name) {
	const task = $("#task");
	task.value = "";
	grow(task);
	updateNewCommands();
	if (name === "model") pickNewModel();
	else if (name === "resume") pickResume();
	else if (name === "cd") {
		setNewOptions(true);
		$("#cwd").focus();
	}
}

function pickNewModel() {
	// The keyboard down, so the sheet shows whole.
	/** @type {HTMLElement | null} */ (document.activeElement)?.blur();
	const toValue = (/** @type {{ provider: string, id: string }} */ m) => `${m.provider}/${m.id}`;
	const groups = [{ options: [{ value: "", label: "Default model" }] }, ...modelGroups(state.models, toValue)];
	openPicker({ title: "Model", groups, value: state.newModel }, (value) => {
		state.newModel = value;
		updateModels();
	});
}

/**
 * A setting of the status sheet, picked as the Mac would: the sheet shows the new value at once,
 * and the pane's next report confirms it (or puts back the old one).
 * @param {string} key its `data-pick`
 */
function pickSetting(key) {
	const report = state.chat.report;
	if (!report) return;
	if (key === "model") {
		const current = String(
			report.models.findIndex((m) => m.provider === report.model?.provider && m.id === report.model?.id),
		);
		openPicker(
			{ title: "Model", groups: modelGroups(report.models, (_m, index) => String(index)), value: current },
			(value) => {
				if (value === current) return;
				state.chat.report = { ...report, model: report.models[Number(value)] };
				render();
				void switchModel(value);
			},
		);
	} else if (key === "trust") {
		const options = TRUST.map(([value, , label]) => ({ value, label }));
		openPicker({ title: "Trust", groups: [{ options }], value: report.trust ?? "" }, (trust) => {
			if (trust === report.trust) return;
			state.chat.report = { ...report, trust };
			render();
			void switchSetting((id) => api.setTrust(id, trust));
		});
	}
}

/**
 * The thinking slider at a level of the report's: shown as it moves, sent once let go (`send`),
 * as a picked setting is.
 * @param {number} index @param {boolean} send
 */
function slideThinking(index, send) {
	const report = state.chat.report;
	const level = report?.thinkingLevels?.[index];
	if (!report || level === undefined) return;
	sliding = !send;
	const slider = /** @type {HTMLInputElement | null} */ (document.getElementById("thinking"));
	if (slider) {
		slider.value = String(index);
		slider.setAttribute("aria-valuetext", level);
		slider.parentElement?.setAttribute("data-thinking", level);
		const value = slider.parentElement?.querySelector(".value");
		if (value) value.textContent = level;
	}
	if (!send) return;
	if (level === report.thinkingLevel) {
		render();
		return;
	}
	state.chat.report = { ...report, thinkingLevel: level };
	render();
	void switchSetting((id) => api.setThinking(id, level));
}

function updateChat() {
	const session = state.sessions.find((s) => s.id === state.chat.id);
	$("#title").textContent = session?.label ?? "";
	// Mid-turn, a dialog waiting on an answer included.
	const turn = session?.state === "working" || session?.state === "needs";
	if (!turn) state.chat.stopping = false;
	const stop = $("#stop");
	stop.hidden = !turn || !state.terminalOpen;
	stop.disabled = state.chat.stopping;
	stop.classList.toggle("busy", state.chat.stopping);
	const bar = $("#statusbar");
	const lines = state.chat.report?.statusline?.lines;
	// The user's own pistatusline, as on the Mac; else the bar's own reading of the report.
	if (lines) {
		paintStatusline(bar, lines);
		markStatuslineEnd(bar);
	} else {
		const barNow = barHtml(state.chat.report, session && shortPath(session.cwd));
		if (bar.dataset.html !== barNow) {
			bar.classList.remove("pistatusline");
			bar.innerHTML = barNow;
			bar.dataset.html = barNow;
			bar.hidden = barNow === "";
		}
	}
	const tasks = state.chat.report?.tasks?.length ?? 0;
	const pill = $("#tasks-pill");
	pill.hidden = tasks === 0;
	const pillNow = `<span>${ICONS.tasks}${tasks}</span>`;
	if (pill.dataset.html !== pillNow) {
		pill.innerHTML = pillNow;
		pill.dataset.html = pillNow;
	}
	pill.setAttribute("aria-label", `${tasks} background task${tasks === 1 ? "" : "s"}`);
	const scroll = $("#scroll");
	const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
	const height = scroll.scrollHeight;
	const banner = $("#banner");
	const bannerNow = updateHtml() + bannerHtml(session);
	// Rebuilt only when it changes, so a tap on Answer is not lost to a refresh.
	const bannerChanged = banner.dataset.html !== bannerNow;
	if (bannerChanged) {
		banner.innerHTML = bannerNow;
		banner.dataset.html = bannerNow;
	}
	// Its height stays the same while loading, so only what is put above moves the log.
	const older = $("#older");
	older.hidden = !state.chat.more;
	older.textContent = state.chat.loadingOlder ? "Loading…" : "";
	const parts = logParts(session);
	const msgs = updatePart($("#msgs"), parts.msgs);
	if (msgs) showPictures($("#msgs"));
	const pending = updatePart($("#pending"), parts.pending);
	if (pending) paintPending();
	const live = updatePart($("#live"), parts.live);
	const working = updatePart($("#working"), parts.working);
	// The banner sits under the log, so the log's end stays in view above it.
	if ((msgs || pending || live || working || bannerChanged) && atBottom && !prepending)
		scroll.scrollTop = scroll.scrollHeight;
	// Also when the page loaded was empty and only "#older" went.
	if (prepending) scroll.scrollTop += scroll.scrollHeight - height;
	prepending = false;
	// Closed on the Mac, or no terminal there shows pi: read only here.
	const closed = session !== undefined && !canAct(session);
	updateSheet(session);
	const text = $("#text");
	text.disabled = closed;
	$(".send").disabled = closed || state.chat.reading > 0;
	const attach = $("#attach");
	const file = $("#file");
	file.disabled = closed || state.chat.attachments.length + state.chat.reading >= ATTACH_MAX;
	attach.classList.toggle("busy", state.chat.reading > 0);
	file.setAttribute("aria-label", state.chat.reading ? "Reading the photos…" : "Attach photos");
	text.placeholder = !closed ? "Reply" : session?.alive ? "Read only" : "Disconnected";
	updateThumbs();
	updateCommands();
}

/** The session's commands for what the reply box starts with (matchCommands), above it; none reported, none shown. */
function updateCommands() {
	const list = $("#commands");
	const found = matchCommands(commandsCache.get(state.chat.id), $("#text").value);
	const html = found
		.map(
			(c) =>
				`<button type="button" class="command" role="option" data-command="${esc(c.name.replace(/^\//, ""))}"><b>/${esc(c.name.replace(/^\//, ""))}</b>${c.description ? `<small>${esc(c.description)}</small>` : ""}</button>`,
		)
		.join("");
	if (list.dataset.html === html) return;
	list.innerHTML = html;
	list.dataset.html = html;
	list.hidden = html === "";
}

/** What each of the log's parts holds. @type {WeakMap<Element, string>} */
const partHtml = new WeakMap();

/**
 * A part of the log, replaced only when its HTML changes; what only adds to the end (a new
 * message, another sent prompt) is appended, so what was there stays as it is.
 * @param {HTMLElement} part @param {string} html @returns {boolean} whether it changed
 */
function updatePart(part, html) {
	const was = partHtml.get(part) ?? "";
	if (html === was) return false;
	partHtml.set(part, html);
	if (html.startsWith(was)) {
		part.insertAdjacentHTML("beforeend", html.slice(was.length));
		return true;
	}
	const open = new Set(
		[...part.querySelectorAll("details[open]")].map((d) => /** @type {HTMLElement} */ (d).dataset.key),
	);
	part.innerHTML = html;
	for (const d of part.querySelectorAll("details")) if (open.has(d.dataset.key)) d.open = true;
	return true;
}

/** The images for the next prompt, above the composer, each with its remove button. */
function updateThumbs() {
	const thumbs = $("#thumbs");
	const html = state.chat.attachments
		.map(
			(a, i) =>
				`<span class="thumb"><img src="${esc(a.thumb)}" alt="Image ${i + 1}"><button type="button" class="remove" data-index="${i}" aria-label="Remove image ${i + 1}">✕</button></span>`,
		)
		.join("");
	if (thumbs.dataset.html === html) return;
	thumbs.innerHTML = html;
	thumbs.dataset.html = html;
	thumbs.hidden = html === "";
}

/** Rebuilt only when it changes, so an open model picker is not reset under the finger. @param {Session | undefined} session */
function updateSheet(session) {
	const sheet = $("#sheet");
	const open = state.chat.sheetOpen || state.chat.tasksSheet;
	sheet.hidden = !open;
	$("#backdrop").hidden = !open;
	if (!open) return;
	sheet.setAttribute("aria-label", state.chat.tasksSheet ? "Background tasks" : "Session status");
	if (state.chat.tasksSheet) {
		const html = tasksHtml();
		if (sheet.dataset.html === html) return;
		sheet.innerHTML = html;
		sheet.dataset.html = html;
		return;
	}
	// The status, then the session's name, pin and delete: each part replaced only when it changes,
	// and the name's field not at all, so it keeps what is typed in it.
	if (sheet.dataset.html !== "status") {
		sheet.innerHTML = `<div class="part" id="sheet-status"></div>${renameHtml(session)}<div class="part" id="sheet-manage"></div>`;
		sheet.dataset.html = "status";
	}
	// Not under a finger on the thinking slider: a new one would drop the drag.
	if (!sliding) updatePart($("#sheet-status"), sheetHtml(session));
	updatePart($("#sheet-manage"), manageHtml(session));
	$("#rename-save").disabled = state.chat.saving;
}

/** @param {{ code: string } | { secret: string } | { handoff: string }} credential */
async function pair(credential) {
	try {
		const token = await api.pair(credential, deviceName());
		try {
			setToken(token);
		} catch {
			$("#pair-error").textContent = "This browser blocks storage; remote control needs it";
			return;
		}
		state.homeScreenHint = !standalone();
		render();
		connect();
		void offerHandoff();
	} catch (error) {
		$("#pair-error").textContent = errorText(error instanceof Error ? error.message : String(error));
	}
}

/**
 * A browser's pairing, carried into the Home Screen app added from it, which may not share its
 * storage: iOS opens that app at the manifest's start_url, which the daemon sets to this device's
 * handoff (once, 30 minutes) when the manifest is asked for with it.
 */
async function offerHandoff() {
	if (standalone() || !getToken()) return;
	try {
		const handoff = await api.handoff();
		$('link[rel="manifest"]').href = `manifest.webmanifest?handoff=${encodeURIComponent(handoff)}`;
	} catch (error) {
		// Otherwise the Home Screen app asks for a code.
		if (error instanceof Unauthorized) handleError(error);
	}
}

function bindPair() {
	$("#pair").addEventListener("submit", (/** @type {Event} */ event) => {
		event.preventDefault();
		void pair({ code: $("#code").value.replace(/\D/g, "") });
	});
}

/** @param {HTMLTextAreaElement} text */
function grow(text) {
	text.style.height = "auto";
	text.style.height = `${Math.min(text.scrollHeight, 140)}px`;
}

/** @param {boolean} expanded */
function setNewOptions(expanded) {
	$("#new-task").classList.toggle("expanded", expanded);
	const button = $("#new-options");
	button.setAttribute("aria-expanded", String(expanded));
	button.setAttribute("aria-label", expanded ? "Hide task options" : "Show task options");
	if (!expanded) $("#cwd").blur();
}

function bindList() {
	const mode = $("#view-mode");
	mode.value = state.viewMode;
	mode.addEventListener("change", () => {
		state.viewMode = viewMode(mode.value);
		try {
			localStorage.setItem(VIEW_MODE_KEY, state.viewMode);
		} catch {
			// The view still changes when browser storage is blocked.
		}
		updateList();
	});
	const task = $("#task");
	$("#new-options").addEventListener("click", () => {
		setNewOptions(!$("#new-task").classList.contains("expanded"));
	});
	task.addEventListener("input", () => {
		grow(task);
		updateNewCommands();
	});
	$("#new-commands").addEventListener("pointerdown", (/** @type {Event} */ event) => event.preventDefault());
	$("#new-commands").addEventListener("click", (/** @type {Event} */ event) => {
		const item = /** @type {HTMLElement | null} */ (
			/** @type {Element} */ (event.target).closest("[data-new-command]")
		);
		if (item?.dataset.newCommand) runNewCommand(item.dataset.newCommand);
	});
	$("#new-resume").addEventListener("click", pickResume);
	// Outside the rows, which every update replaces, so it keeps its focus, caret and keyboard.
	const search = $("#search");
	search.value = state.query;
	/** @param {string} query */
	const find = (query) => {
		state.query = query;
		updateList();
	};
	// Every keystroke, the first one included, filters at once.
	search.addEventListener("input", () => find(search.value));
	search.addEventListener("focus", () => {
		$("#search-cancel").hidden = false;
	});
	search.addEventListener("blur", () => {
		$("#search-cancel").hidden = true;
	});
	search.addEventListener("keydown", (/** @type {KeyboardEvent} */ event) => {
		if (event.key !== "Escape") return;
		search.value = "";
		find("");
		search.blur();
	});
	// Search's key on the keyboard only puts it away: the rows show already.
	$("#search-form").addEventListener("submit", (/** @type {Event} */ event) => {
		event.preventDefault();
		search.blur();
	});
	// Kept from taking the focus, so the keyboard stays up for the next query.
	$("#search-clear").addEventListener("pointerdown", (/** @type {Event} */ event) => event.preventDefault());
	$("#search-clear").addEventListener("click", () => {
		search.value = "";
		find("");
		search.focus();
	});
	$("#search-cancel").addEventListener("pointerdown", (/** @type {Event} */ event) => event.preventDefault());
	$("#search-cancel").addEventListener("click", () => {
		search.value = "";
		find("");
		search.blur();
	});
	$("#phone-menu").addEventListener("click", () => {
		state.phoneSheet = true;
		state.confirmDisconnect = false;
		state.error = undefined;
		updateList();
	});
	$("#backdrop").addEventListener("click", closePhoneSheet);
	$("#sheet").addEventListener("click", (/** @type {Event} */ event) => {
		const target = /** @type {Element} */ (event.target);
		if (target.closest("#sheet-close")) closePhoneSheet();
		else if (target.closest("#disconnect, #disconnect-cancel")) {
			state.confirmDisconnect = target.closest("#disconnect") !== null;
			updateList();
		} else if (target.closest("#disconnect-confirm")) void disconnect();
	});
	$("#notify").addEventListener("click", () => void enablePush());
	$("#banner").addEventListener("click", (/** @type {Event} */ event) => {
		if (!(/** @type {Element} */ (event.target).closest("#dismiss-hint"))) return;
		state.homeScreenHint = false;
		updateList();
	});
	// Kept from taking the focus: the field losing it would hide this button (with no task typed yet)
	// before the tap lands on it.
	$("#new-model").addEventListener("pointerdown", (/** @type {Event} */ event) => event.preventDefault());
	$("#new-model").addEventListener("click", pickNewModel);
	const cwd = $("#cwd");
	cwd.addEventListener("focus", () => {
		// The most recent directory, selected: typing replaces it, and its list offers the others.
		// iOS ignores a selection made while it focuses the field.
		if (!state.cwdEdited) requestAnimationFrame(() => cwd.setSelectionRange(0, cwd.value.length));
		updateDirectories();
	});
	cwd.addEventListener("blur", updateDirectories);
	cwd.addEventListener("input", () => {
		state.cwdEdited = true;
		updateDirectories();
		completeDirectory();
	});
	// Done puts the keyboard away; the task starts from its own button.
	cwd.addEventListener("keydown", (/** @type {KeyboardEvent} */ event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		cwd.blur();
	});
	const dirs = $("#cwd-list");
	// Kept from taking the focus, so the keyboard stays up while a path is built.
	dirs.addEventListener("pointerdown", (/** @type {Event} */ event) => event.preventDefault());
	dirs.addEventListener("click", (/** @type {Event} */ event) => {
		const item = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest("[data-dir]"));
		if (!item) return;
		state.cwdEdited = true;
		const step = item.dataset.step !== undefined;
		cwd.value = `${item.dataset.dir}${step ? "/" : ""}`;
		// Its end in view, where the next folder goes.
		cwd.setSelectionRange(cwd.value.length, cwd.value.length);
		cwd.scrollLeft = cwd.scrollWidth;
		if (step) {
			state.completions = [];
			completeDirectory();
			updateDirectories();
		} else cwd.blur();
	});
	$("#new-task").addEventListener("submit", (/** @type {Event} */ event) => {
		event.preventDefault();
		void startTask();
	});
}

async function startTask() {
	const task = $("#task");
	const value = task.value.trim();
	if (NEW_COMMANDS.some((c) => value === `/${c.name}`)) {
		runNewCommand(value.slice(1));
		return;
	}
	// "~/a/" as a folder step left it: the same directory.
	const cwd = $("#cwd")
		.value.trim()
		.replace(/(.)\/+$/, "$1");
	if (!value || state.starting) return;
	if (!cwd) {
		showError("Type the directory to start it in.");
		return;
	}
	state.starting = {};
	render();
	try {
		const { pane } = await api.start(cwd, value, state.newModel || undefined);
		task.value = "";
		grow(task);
		waitForPane(pane);
	} catch (error) {
		state.starting = undefined;
		handleError(error);
	}
}

function bindChat() {
	olderObserver?.disconnect();
	olderObserver = new IntersectionObserver(
		(entries) => {
			if (entries.some((entry) => entry.isIntersecting)) void loadOlder();
		},
		{ root: $("#scroll"), rootMargin: `${OLDER_MARGIN}px 0px 0px 0px` },
	);
	olderObserver.observe($("#older"));
	pictureObserver?.disconnect();
	pictureObserver = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				pictureObserver?.unobserve(entry.target);
				const { entry: entryId, index } = /** @type {HTMLElement} */ (entry.target).dataset;
				if (entryId) void loadPicture(entryId, Number(index));
			}
		},
		{ root: $("#scroll"), rootMargin: `${OLDER_MARGIN}px 0px` },
	);
	pictureSizes?.disconnect();
	pictureSizes = new ResizeObserver(keepPlace);
	stuck = true;
	const scroll = $("#scroll");
	scroll.addEventListener("scroll", () => {
		stuck = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
	});
	// A picture keeps its placeholder's height until its image is in (load does not bubble).
	$("#log").addEventListener(
		"load",
		(/** @type {Event} */ event) => {
			const pic = /** @type {Element} */ (event.target).closest(".pic");
			pic?.classList.add("loaded");
		},
		true,
	);
	$("#viewer").addEventListener("click", closeViewer);
	const text = $("#text");
	text.addEventListener("input", () => {
		grow(text);
		updateCommands();
	});
	$("#composer").addEventListener("submit", (/** @type {Event} */ event) => {
		event.preventDefault();
		void send();
	});
	const commands = $("#commands");
	// The reply box keeps its focus, and iOS its keyboard, while a suggestion is tapped.
	commands.addEventListener("pointerdown", (/** @type {Event} */ event) => event.preventDefault());
	commands.addEventListener("click", (/** @type {Event} */ event) => {
		const command = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest(".command"));
		if (!command) return;
		text.value = `/${command.dataset.command} `;
		grow(text);
		text.focus();
		text.setSelectionRange(text.value.length, text.value.length);
		updateCommands();
	});
	const file = $("#file");
	file.addEventListener("change", () => {
		const files = [...file.files];
		file.value = "";
		void attach(files);
	});
	$("#thumbs").addEventListener("click", (/** @type {Event} */ event) => {
		const remove = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest(".remove"));
		if (!remove) return;
		state.chat.attachments.splice(Number(remove.dataset.index), 1);
		render();
	});
	$("#stop").addEventListener("click", async () => {
		const chat = state.chat;
		if (!chat || chat.stopping) return;
		chat.stopping = true;
		render();
		try {
			await api.abort(chat.id);
		} catch (error) {
			chat.stopping = false;
			handleError(error);
		}
	});
	// Back to the list's own entry, rather than a new one after this chat's.
	$(".back").addEventListener("click", (/** @type {Event} */ event) => {
		if (!state.chat?.backToList) return;
		event.preventDefault();
		history.back();
	});
	$("#title").addEventListener("click", openSheet);
	$("#statusbar").addEventListener("scroll", () => markStatuslineEnd($("#statusbar")), { passive: true });
	$("#statusbar").addEventListener("click", openSheet);
	$("#statusbar").addEventListener("keydown", (/** @type {KeyboardEvent} */ event) => {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		openSheet();
	});
	$("#tasks-pill").addEventListener("click", openTasks);
	$("#backdrop").addEventListener("click", closeSheet);
	const sheet = $("#sheet");
	sheet.addEventListener("click", (/** @type {Event} */ event) => {
		const target = /** @type {Element} */ (event.target);
		if (target.closest("#sheet-close")) closeSheet();
		else if (target.closest("[data-pick]"))
			pickSetting(/** @type {HTMLElement} */ (target.closest("[data-pick]")).dataset.pick ?? "");
		else if (target.closest("[data-level]"))
			slideThinking(Number(/** @type {HTMLElement} */ (target.closest("[data-level]")).dataset.level), true);
		else if (target.closest("#pin")) void togglePin();
		else if (target.closest("#delete, #delete-cancel")) {
			state.chat.confirmDelete = target.closest("#delete") !== null;
			render();
		} else if (target.closest("#delete-confirm")) void deleteSession();
		else if (target.closest("[data-output]"))
			void toggleTaskOutput(/** @type {HTMLElement} */ (target.closest("[data-output]")).dataset.output ?? "");
		else if (target.closest("[data-stop], [data-stop-cancel]")) {
			state.chat.confirmStop = /** @type {HTMLElement | null} */ (target.closest("[data-stop]"))?.dataset.stop;
			render();
		} else if (target.closest("[data-stop-confirm]"))
			void stopTask(/** @type {HTMLElement} */ (target.closest("[data-stop-confirm]")).dataset.stopConfirm ?? "");
	});
	for (const type of ["input", "change"])
		sheet.addEventListener(type, (/** @type {Event} */ event) => {
			const target = /** @type {HTMLInputElement} */ (event.target);
			if (target.id === "thinking") slideThinking(Number(target.value), type === "change");
		});
	// Let go where it started, Safari sends no `change`; and its `change` may come after this.
	for (const type of ["pointerup", "pointercancel"])
		window.addEventListener(type, () => {
			const slider = /** @type {HTMLInputElement | null} */ (document.getElementById("thinking"));
			if (sliding && slider) slideThinking(Number(slider.value), true);
		});
	sheet.addEventListener("submit", (/** @type {Event} */ event) => {
		event.preventDefault();
		if (/** @type {Element} */ (event.target).id === "rename-form") void rename();
	});
	$("#log").addEventListener("click", (/** @type {Event} */ event) => {
		const full = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest(".full"));
		if (full?.dataset.entry) {
			void loadOutput(full.dataset.entry);
			return;
		}
		const pic = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest(".pic"));
		if (!pic) return;
		const url = pic.dataset.pending
			? pendingPicture(pic)
			: state.chat.pictures.get(pictureKey(pic.dataset.entry ?? "", pic.dataset.index ?? ""));
		if (url) openViewer(url);
	});
}

/** The bar's report shows until the fresh one is in. */
function openSheet() {
	state.chat.sheetOpen = true;
	state.chat.tasksSheet = false;
	state.error = undefined;
	state.chat.confirmDelete = false;
	// A fresh name field, holding the name the session has now.
	$("#sheet").dataset.html = "";
	render();
	void loadStatus();
}

function closeSheet() {
	state.chat.sheetOpen = false;
	state.chat.confirmDelete = false;
	state.chat.tasksSheet = false;
	state.chat.confirmStop = undefined;
	state.chat.taskOutputs.clear();
	render();
}

/** Its list is the report's, which the pane sends again while the chat is open. */
function openTasks() {
	state.chat.tasksSheet = true;
	state.chat.sheetOpen = false;
	state.error = undefined;
	state.chat.confirmStop = undefined;
	state.chat.taskOutputs.clear();
	render();
}

/** A task's last lines under it, or hidden again. @param {string} taskId */
async function toggleTaskOutput(taskId) {
	const chat = state.chat;
	if (!chat || chat.taskOutputs.get(taskId)?.loading) return;
	if (chat.taskOutputs.get(taskId)?.lines) {
		chat.taskOutputs.delete(taskId);
		render();
		return;
	}
	chat.taskOutputs.set(taskId, { loading: true });
	render();
	try {
		const { lines, size } = await api.taskOutput(chat.id, taskId);
		if (chat.tasksSheet) chat.taskOutputs.set(taskId, { lines, size });
	} catch (error) {
		if (error instanceof Unauthorized) return handleError(error);
		const code = error instanceof Error ? error.message : String(error);
		chat.taskOutputs.set(taskId, { error: error instanceof TypeError ? "unreachable" : code });
	}
	render();
}

/** As /tasks' `x` does: the model is told. The task stays listed until the pane's next report. @param {string} taskId */
async function stopTask(taskId) {
	const chat = state.chat;
	if (!chat) return;
	chat.confirmStop = undefined;
	chat.stoppingTasks.add(taskId);
	render();
	try {
		await api.stopTask(chat.id, taskId);
	} catch (error) {
		chat.stoppingTasks.delete(taskId);
		handleError(error);
	}
}

/** The pane reports the switch within a heartbeat, which refreshes the sheet. @param {string} value */
async function switchModel(value) {
	const id = state.chat?.id;
	const model = state.chat?.report?.models[Number(value)];
	if (!id || !model) return;
	try {
		await api.setModel(id, model.provider, model.id);
	} catch (error) {
		handleError(error);
		// Back to the model the pane reported, shown before it went.
		void loadStatus();
	}
}

/** The thinking level or trust mode, as a model switch: the pane reports the change. @param {(id: string) => Promise<unknown>} call */
async function switchSetting(call) {
	const id = state.chat?.id;
	if (!id) return;
	try {
		await call(id);
	} catch (error) {
		handleError(error);
		// Back to what the pane reported, shown before it went.
		void loadStatus();
	}
}

/** The name in the sheet's field, shown at once: a pane takes it on its next heartbeat (see holdRename). */
async function rename() {
	const chat = state.chat;
	const field = $("#rename");
	const name = field?.value.trim() ?? "";
	if (!chat || chat.saving || name === state.sessions.find((s) => s.id === chat.id)?.label) return;
	if (!name) {
		showError(errorText("invalid_name"));
		return;
	}
	const id = chat.id;
	chat.saving = true;
	render();
	try {
		await api.rename(id, name);
		renamed = { id, name, until: Date.now() + RENAME_HOLD_MS };
		holdRename();
		field.blur();
	} catch (error) {
		handleError(error);
	} finally {
		chat.saving = false;
		render();
	}
}

async function togglePin() {
	const id = state.chat?.id;
	const session = state.sessions.find((s) => s.id === id);
	if (!id || !session) return;
	try {
		await api.pin(id, session.band !== "pinned");
		await loadSessions();
	} catch (error) {
		handleError(error);
	}
}

/** A stored session off the list (its file stays), and back to the list. */
async function deleteSession() {
	const chat = state.chat;
	if (!chat) return;
	chat.confirmDelete = false;
	try {
		await api.deleteSession(chat.id);
	} catch (error) {
		handleError(error);
		return;
	}
	if (state.chat !== chat) return;
	closeSheet();
	// As "‹ Sessions" goes: to the list's own entry when the chat was opened from it.
	if (chat.backToList) history.back();
	else location.hash = "";
}

/** A cut-short tool result's whole output, into its block in place of the cut one. @param {string} entry */
async function loadOutput(entry) {
	const chat = state.chat;
	if (!chat || chat.outputs.get(entry)?.loading) return;
	chat.outputs.set(entry, { loading: true });
	render();
	try {
		const { text, truncated } = await api.output(chat.id, entry);
		if (state.chat !== chat) return;
		chat.outputs.set(entry, { text, truncated });
	} catch (error) {
		if (error instanceof Unauthorized) {
			handleError(error);
			return;
		}
		if (state.chat !== chat) return;
		chat.outputs.set(entry, { error: failure(error) });
	}
	render();
}

/**
 * Picked photos, each made small enough to send (image.js), for the next prompt. Anything not an
 * image, and any image that cannot be read, is named in the error; the rest still go.
 * @param {File[]} files
 */
async function attach(files) {
	const chat = state.chat;
	if (!chat) return;
	/** @type {string[]} */
	const problems = [];
	const images = files.filter((file) => {
		if (isImageFile(file)) return true;
		problems.push(`“${file.name}” is not a photo: only images can be attached.`);
		return false;
	});
	const room = ATTACH_MAX - chat.attachments.length;
	if (images.length > room) problems.push(errorText("too_many_images"));
	const picked = images.slice(0, Math.max(room, 0));
	chat.reading += picked.length;
	render();
	for (const file of picked) {
		try {
			const image = await readImage(file);
			// Another pick may have filled it meanwhile.
			if (chat.attachments.length < ATTACH_MAX) chat.attachments.push(image);
		} catch (error) {
			const tooLarge = error instanceof Error && error.message === "image_too_large";
			problems.push(`“${file.name}”: ${errorText(tooLarge ? "image_too_large" : "unreadable_image")}`);
		}
		chat.reading--;
		render();
	}
	if (state.chat !== chat) return;
	if (problems.length) showError(problems.join(" "));
	else render();
}

/** An image of the open chat's, by its message's id and its position there. @param {string} entry @param {string | number} index */
function pictureKey(entry, index) {
	return `${entry}\n${index}`;
}

/** A picture button gets its image if fetched, and says so if it could not be. @param {HTMLElement} button */
function paint(button) {
	const key = pictureKey(button.dataset.entry ?? "", button.dataset.index ?? "");
	const url = state.chat.pictures.get(key);
	const img = /** @type {HTMLImageElement} */ (button.querySelector("img"));
	if (url) {
		if (img.getAttribute("src") !== url) img.src = url;
		return true;
	}
	if (state.chat.picturesFailed.has(key)) {
		button.classList.add("failed");
		img.alt = "Image unavailable";
		return true;
	}
	return false;
}

/** After the log is rebuilt: its pictures fetched already show at once, the rest as they near the screen. @param {HTMLElement} log */
function showPictures(log) {
	pictureObserver?.disconnect();
	for (const button of /** @type {NodeListOf<HTMLElement>} */ (log.querySelectorAll(".pic"))) {
		pictureSizes?.observe(button);
		if (!paint(button)) pictureObserver?.observe(button);
	}
}

/** The sent prompts' images, from what was sent. */
function paintPending() {
	for (const button of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#pending .pic"))) {
		const img = /** @type {HTMLImageElement} */ (button.querySelector("img"));
		const url = pendingPicture(button);
		if (!url || img.getAttribute("src") === url) continue;
		pictureSizes?.observe(button);
		img.src = url;
	}
}

/** @param {HTMLElement} button @returns {string | undefined} */
function pendingPicture(button) {
	const entry = state.chat.pending.find((p) => String(p.id) === button.dataset.pending);
	const image = entry?.images[Number(button.dataset.index)];
	return image && `data:${image.mimeType};base64,${image.data}`;
}

/**
 * An image's size changes as it loads: from its placeholder's, and again whenever the transcript
 * is rebuilt. One above what is on screen moves the log by as much, so what is on screen stays;
 * the log's end stays in view if it was.
 * @param {ResizeObserverEntry[]} entries
 */
function keepPlace(entries) {
	const scroll = $("#scroll");
	if (!scroll) return;
	const top = scroll.getBoundingClientRect().top;
	let above = 0;
	for (const entry of entries) {
		const button = /** @type {HTMLElement} */ (entry.target);
		const height = entry.borderBoxSize[0]?.blockSize ?? 0;
		const was = Number(button.dataset.height ?? height);
		button.dataset.height = String(height);
		if (!button.isConnected) {
			pictureSizes?.unobserve(button);
			continue;
		}
		if (button.getBoundingClientRect().bottom - (height - was) <= top) above += height - was;
	}
	if (stuck) scroll.scrollTop = scroll.scrollHeight;
	else if (above) scroll.scrollTop += above;
}

/** @param {string} entry @param {number} index */
async function loadPicture(entry, index) {
	const chat = state.chat;
	const key = pictureKey(entry, index);
	if (!chat || chat.pictures.has(key) || chat.picturesLoading.has(key) || chat.picturesFailed.has(key)) return;
	chat.picturesLoading.add(key);
	try {
		const url = await dataUrl(await api.image(chat.id, entry, index));
		if (state.chat !== chat) return;
		if (chat.pictures.size >= PICTURES_MAX)
			chat.pictures.delete(/** @type {string} */ (chat.pictures.keys().next().value));
		chat.pictures.set(key, url);
	} catch (error) {
		if (error instanceof Unauthorized) {
			handleError(error);
			return;
		}
		// Offline or the Mac failing: it is fetched again once the log is next rebuilt.
		const message = error instanceof Error ? error.message : String(error);
		if (state.chat !== chat || error instanceof TypeError || /^HTTP 5\d\d$/.test(message)) return;
		chat.picturesFailed.add(key);
	} finally {
		chat.picturesLoading.delete(key);
	}
	for (const button of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#log .pic"))) {
		if (button.dataset.entry === entry && button.dataset.index === String(index)) paint(button);
	}
}

/** @param {string} url */
function openViewer(url) {
	$("#viewer-img").src = url;
	$("#viewer").hidden = false;
}

function closeViewer() {
	$("#viewer").hidden = true;
	$("#viewer-img").removeAttribute("src");
}

async function send() {
	const text = $("#text");
	const value = text.value.trim();
	const chat = state.chat;
	const session = state.sessions.find((s) => s.id === chat?.id);
	// Photos still being read go with it once they are in.
	if (!value || !chat || !canAct(session) || chat.reading) return;
	// Left in the reply box, to change. A command listed for the phone goes, and the pane runs it.
	if (chat.attachments.length === 0 && refused(value, commandsCache.get(chat.id))) {
		showError(errorText("terminal_command"));
		return;
	}
	const images = chat.attachments;
	text.value = "";
	text.style.height = "auto";
	chat.attachments = [];
	const entry = addPending(chat, value, images, Date.now());
	setTimeout(() => checkSent(chat, entry), PROMPT_GIVE_UP_MS);
	render();
	$("#scroll").scrollTop = $("#scroll").scrollHeight;
	try {
		await api.prompt(
			chat.id,
			value,
			images.map(({ mimeType, data }) => ({ mimeType, data })),
		);
	} catch (error) {
		forget(chat, entry);
		putBack(chat, entry);
		handleError(error, "Not sent: ");
	}
}

/** @typedef {import("./chat.js").Chat} Chat @typedef {import("./chat.js").Pending} Pending */

/** A prompt that did not reach its session, back in the reply box above what was typed since, with its images. @param {Chat} chat @param {Pending} entry */
function putBack(chat, entry) {
	if (state.chat !== chat) return;
	const text = $("#text");
	text.value = text.value ? `${entry.prompt}\n${text.value}` : entry.prompt;
	grow(text);
	if (!chat.attachments.length) chat.attachments = entry.images;
}

/** A sent prompt still waiting PROMPT_GIVE_UP_MS on (see giveUp). @param {Chat} chat @param {Pending} entry */
function checkSent(chat, entry) {
	if (state.chat !== chat || !chat.pending.includes(entry) || state.starting) return;
	const verdict = checkPending(chat, entry, state.sessions.find((s) => s.id === chat.id)?.state);
	if (verdict === "drop") render();
	else if (verdict === "fail") {
		putBack(chat, entry);
		showError(errorText("not_delivered"));
	}
}

// ---- this phone ----

function closePhoneSheet() {
	state.phoneSheet = false;
	state.confirmDisconnect = false;
	render();
}

/** This phone unpaired, and back to pairing: the Mac is where any other phone is removed. */
async function disconnect() {
	state.confirmDisconnect = false;
	try {
		const self = (await api.devices()).find((device) => device.current);
		if (!self) throw new Error("unknown_device");
		await api.removeDevice(self.id);
	} catch (error) {
		// Already gone from the Mac: the phone is signed out all the same.
		if (!(error instanceof Error && error.message === "unknown_device")) {
			handleError(error);
			return;
		}
	}
	clearToken();
	source?.close();
	source = undefined;
	state.phoneSheet = false;
	render();
}

// ---- routing ----

/**
 * The QR code's link, or the Home Screen app's start_url, pairs this app unless it is paired
 * already: the app opens at its start_url every time. The secret leaves the address at once, so it
 * is in no bookmark or history; pairing renders once its answer is in.
 */
function claimLink() {
	const link = pairLink(location.hash);
	if (!link) return;
	history.replaceState(null, "", location.pathname + location.search);
	if (!getToken()) void pair(link);
}

function route() {
	claimLink();
	const previous = state.chat;
	const match = /^#s\/(.+)$/.exec(location.hash);
	const open = match ? decodeURIComponent(match[1]) : undefined;
	if (open !== previous?.id) {
		clearTimeout(previous?.liveClear);
		// Following a resumed session to its pane keeps the replies still pending on screen until pi
		// writes them, and its entry, which replaces the old one's, still follows the list's.
		const follows = open !== undefined && open === previous?.next;
		state.chat = open === undefined ? undefined : openChat(open, follows ? previous : undefined);
		if (state.chat && !previous) state.chat.backToList = true;
		state.error = undefined;
		state.phoneSheet = false;
		state.confirmDisconnect = false;
		connect();
	}
	render();
}

/**
 * iOS leaves the layout viewport, and 100dvh, the screen's height while the keyboard is up, and
 * scrolls the page to show the field typed in, pushing the header out of sight. The app takes the
 * height that shows instead, a sheet sits on the keyboard, and the page stays at its top.
 */
function fitViewport() {
	const viewport = window.visualViewport;
	if (!viewport) return;
	if (window.scrollY) window.scrollTo(0, 0);
	const root = document.documentElement;
	// In layout pixels, as a pinch zoom leaves them; whole ones, so nothing lays out on a half pixel
	// and its text blurs.
	const height = Math.round(viewport.height * viewport.scale);
	const keyboard = Math.max(0, Math.round(root.clientHeight - height - viewport.offsetTop * viewport.scale));
	root.style.setProperty("--app-h", `${height}px`);
	root.style.setProperty("--keyboard", `${keyboard}px`);
	root.classList.toggle("keyboard", keyboard > KEYBOARD_MIN);
}

// A tap on a button or a link is the next action an error lasts until (see showError); it shows
// once the tap is handled, which may bring another.
document.addEventListener(
	"click",
	(/** @type {Event} */ event) => {
		if (state.error === undefined || !(/** @type {Element} */ (event.target).closest("button, a"))) return;
		state.error = undefined;
		clearTimeout(errorTimer);
		setTimeout(render);
	},
	true,
);
window.addEventListener("hashchange", route);
// A change of appearance repaints pistatusline's lines.
darkScheme.addEventListener("change", render);
window.visualViewport?.addEventListener("resize", fitViewport);
window.visualViewport?.addEventListener("scroll", fitViewport);
fitViewport();
// The stream is open only while the app is on screen: the Mac sends no notification to a phone
// that has it open, and iOS suspends a backgrounded app's stream anyway. Reopened on return, it
// fetches everything again (see connect), so the chat catches up.
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") {
		connect();
		// A fresh one: Safari may sit in the background longer than a handoff lasts.
		void offerHandoff();
	} else closeStream();
});
window.addEventListener("pagehide", closeStream);
// Back from the page cache, which keeps no stream.
window.addEventListener("pageshow", (/** @type {PageTransitionEvent} */ event) => {
	if (event.persisted && document.visibilityState === "visible") connect();
});
// The list's ages, and the running time of each background task.
setInterval(() => {
	if (shown === "list") updateList();
	else if (shown.startsWith("chat:")) updateChat();
}, 30_000);
if ("serviceWorker" in navigator) {
	// The first install takes control too, and that is no new version.
	const updating = navigator.serviceWorker.controller !== null;
	navigator.serviceWorker.register("sw.js").catch(() => {});
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (!updating) return;
		state.updateReady = true;
		render();
	});
	// A Home Screen app comes back from the background without a page load, which is when the
	// browser looks for a new sw.js on its own.
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") return;
		navigator.serviceWorker
			.getRegistration()
			.then((registration) => registration?.update())
			.catch(() => {});
	});
	app.addEventListener("click", (/** @type {Event} */ event) => {
		if (/** @type {Element} */ (event.target).closest("#reload-app")) location.reload();
	});
	// A notification tapped while the app is open: sw.js asks it to open that session.
	navigator.serviceWorker.addEventListener("message", (/** @type {MessageEvent} */ event) => {
		const id = event.data?.open;
		if (typeof id === "string") location.hash = `#s/${encodeURIComponent(id)}`;
	});
}

claimLink();
const opened = /^#s\/(.+)$/.exec(location.hash)?.[1];
if (opened) state.chat = openChat(decodeURIComponent(opened));
render();
connect();
void offerHandoff();
