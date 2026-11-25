// @ts-check
import { api, clearToken, getToken, PING_MS, pairLink, setToken, tryStorage, Unauthorized } from "./api.js";
import { applyLatest, applyOlder, arrive, listed, nextGiveUp, openChat, promptSent, replyEndedAt } from "./chat.js";
import { setNewOptions } from "./composer.js";
import { allows, deleteHtml, pinHtml, renameHtml } from "./controls.js";
import { diffCounts, diffHtml } from "./diff.js";
import { ICONS, toolIcon } from "./icons.js";
import { ATTACH_MAX, dataUrl, isImageFile, readImage } from "./image.js";
import {
	ageAt,
	ageText,
	isUnseen,
	midTurn,
	paneUp,
	replyBox,
	rowTone,
	STATE_WORDS,
	sessionGroups,
	sharedWarning,
	statusGlyph,
	viewMode,
} from "./list.js";
import { refused, shownText } from "./live.js";
import { markdown } from "./markdown.js";
import { fleetState, loaderHtml, mascotHtml, mascotState } from "./mascot.js";
import { diffSummary, groupSummary, markerKind, resultSummary } from "./output.js";
import { pendingStore } from "./pending.js";
import { closePicker, modelGroups, openPicker } from "./picker.js";
import { filterSessions, fold, matchCommands } from "./search.js";
import { createSkillDraft, skillProvenance } from "./skills.js";
import {
	barHtml,
	compactLines,
	contextLevel,
	elapsedText,
	runUsageHtml,
	settingsHtml,
	spanStyle,
	TRUST,
	tokens,
	whereHtml,
} from "./statusbar.js";
import { composerAction, duration, SECOND_TAP_GUARD_MS, turnSince, turnTimes } from "./turn.js";

/**
 * @typedef {{ act: true } | { act: false, reason: "silent" | "starting" | "not_running" }} Verdict
 * @typedef {{ act: true } | { act: false, reason: string }} ActionVerdict
 * @typedef {{ id: string, label: string, cwd: string, band: string, state: string, alive: boolean, detail: string, createdAt?: string, finishedAt?: string, turnStartedAt?: string, dialog?: { kind: string, title?: string }, settledCount?: number, livePanes?: number, starting?: true, silent?: true, verdict: Verdict, actions: Record<import("./controls.js").ChatAction, ActionVerdict> }} Session
 */
/** @typedef {{ kind: string, id: string, at?: string, text?: string, thinking?: string, tools?: {id: string, name: string, summary: string}[], error?: string, aborted?: boolean, toolCallId?: string, toolName?: string, command?: string, ok?: boolean, truncated?: boolean, diff?: string, diffTruncated?: boolean, images?: {index: number, mimeType: string}[] }} Message */
/** @typedef {{ text: string, thinking?: string, tools: {id: string, name: string, summary: string, running: boolean}[] }} LiveSnapshot */
/** @typedef {{ id: string, name: string, createdAt: string, lastUsedAt?: string, current: boolean }} Device */
/** @typedef {import("./image.js").Attachment} Attachment */
/** @typedef {import("./statusbar.js").Report} Report */

const VERSION = "0.0.65";
const VIEW_MODE_KEY = "bluclawd-view-mode";
const keptPending = pendingStore(() => localStorage);

const SEEN_KEY = "bluclawd-seen";
const seen = loadSeen();

/** @returns {import("./list.js").Seen} */
function loadSeen() {
	const kept = tryStorage(() => JSON.parse(localStorage.getItem(SEEN_KEY) ?? "null"), null);
	if (typeof kept?.since === "string" && kept.at && typeof kept.at === "object") return kept;
	const fresh = { since: new Date().toISOString(), at: {} };
	tryStorage(() => localStorage.setItem(SEEN_KEY, JSON.stringify(fresh)), undefined);
	return fresh;
}

/** @param {string} id */
function markSeen(id) {
	seen.at[id] = new Date().toISOString();
	if (state.loaded) {
		for (const key of Object.keys(seen.at)) {
			if (key !== id && !state.sessions.some((s) => s.id === key)) delete seen.at[key];
		}
	}
	tryStorage(() => localStorage.setItem(SEEN_KEY, JSON.stringify(seen)), undefined);
}

function loadViewMode() {
	return viewMode(tryStorage(() => localStorage.getItem(VIEW_MODE_KEY), null));
}
const OFFLINE_AFTER_MS = 5000;
const WATCHDOG_MS = PING_MS + 10_000;
const START_TIMEOUT_MS = 60_000;
const LIVE_CLEAR_MS = 3000;
const ERROR_MS = 6000;
/** Less taken off the visible height than this is a toolbar, not the keyboard. */
const KEYBOARD_MIN = 120;
const RENAME_HOLD_MS = 15_000;
const ENTRY_ID = /^[0-9a-f-]{8,36}$/;
const ERRORS = {
	session_not_running: "This session is not running. Open it on the Mac to continue.",
	pi_not_open: "pi is not open on the Mac. Open it in a terminal there to continue.",
	session_busy: "The session is busy. Try again once it is done.",
	no_status: "This session has not reported its status yet.",
	session_silent: "This session is not answering on the Mac, which may be asleep or busy.",
	pane_too_old:
		"This session has not reported yet. Try again in a moment; if this persists, restart it (it may run an older bluclawd).",
	invalid_cwd: "That directory does not exist on the Mac.",
	invalid_skills: "Selected skills are unavailable. Remove them and select them again.",
	invalid_model: "That model name is not valid.",
	invalid_thinking: "The model does not offer that thinking level.",
	invalid_trust: "That trust mode is not one of always, ask or never.",
	invalid_entry: "That message is no longer in this session.",
	not_delivered: "Not delivered — check the session on the Mac.",
	unreachable: "Could not reach the Mac: check that Tailscale is on in this phone and the Mac is awake.",
	no_launch: "Run /remote-control in a pi on the Mac once, so the phone knows how to start pi.",
	start_failed: "The Mac could not start the session.",
	start_timeout: "The session did not start. Try again.",
	unknown_session: "This session is gone.",
	unknown_device: "That phone was removed already.",
	invalid_code: "That code is wrong or was already used. Run /remote-control on the Mac for a new one.",
	expired_code: "That code expired. Run /remote-control on the Mac for a new one.",
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
	session_starting: "This session is already starting.",
	unknown_entry: "That output is no longer in this session.",
	not_found: "The Mac does not know that request. It may run an older bluclawd.",
	terminal_command: "That command runs only on the Mac, so the phone does not send it.",
	command_refused: "That command runs only on the Mac, so the phone does not send it.",
	unsent_draft: "Clear the unsent text in this session's prompt on the Mac first, then send the command again.",
	forbidden: "Only the Mac removes another phone: run /remote-control there.",
	unknown_task: "That task has ended already.",
	no_output: "That task has no output to show.",
};

const RETURNED = {
	invalid_skills: "Selected skills could not be loaded. Select them again before retrying.",
	busy: "Not sent: the session is busy. Send it again once it is done.",
	draft: "Not sent: clear the unsent text in this session's prompt on the Mac first.",
	dialog: "Not sent: a dialog is open in this session on the Mac. Answer or close it first.",
	compacting: "Not sent: the session is compacting. Send it again once that is done.",
	session_changed: "Not sent: the Mac switched to another session before this one took it.",
	unreachable: "Not sent: the session's prompt on the Mac could not be reached.",
	pane_gone: "Not delivered: the session went away on the Mac before it took this.",
	daemon_restarted: "Not delivered: bluclawd restarted on the Mac before the session took this.",
	dequeued:
		"Not delivered: pi dropped this from its queue when its turn was stopped or the session reloaded on the Mac, so it may be in the Mac's prompt.",
};

const state = {
	/** @type {Session[]} */ sessions: [],
	/** @type {import("./chat.js").Chat | undefined} */ chat: undefined,
	/** @type {string[]} */ directories: [],
	/** @type {import("./statusbar.js").ReportModel[]} */ models: [],
	newModel: "",
	cwdEdited: false,
	/** @type {string[]} */
	completions: [],
	query: "",
	viewMode: loadViewMode(),
	/** @type {{ id?: string } | undefined} */
	starting: undefined,
	loaded: false,
	online: true,
	terminalOpen: true,
	offerPush: false,
	/** Paired in Safari, though the Home Screen app is the one iOS notifies. */
	homeScreenHint: false,
	stayInBrowser: false,
	pendingSecret: /** @type {string | undefined} */ (undefined),
	/** A new build's service worker took over, and this page still runs the old one until it reloads. */
	updateReady: false,
	phoneSheet: false,
	confirmDisconnect: false,
	/** @type {string | undefined} */ error: undefined,
};

/** @param {string} selector @returns {any} */
const $ = (selector) => document.querySelector(selector);
const app = $("#app");
/** @type {ReturnType<typeof api.events> | undefined} */
let source;
let streamId = "";
/** @type {ReturnType<typeof setTimeout> | undefined} */
let offlineTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let watchdog;
const OLDER_MARGIN = 400;
const OLDER_RETRY_MS = 2000;
const STATUS_COLS = 200;
/** @type {Map<string, import("./statusbar.js").Command[]>} */
const commandsCache = new Map();
const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");
/** @type {ReturnType<typeof setTimeout> | undefined} */
let startTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let errorTimer;
/** @type {"" | "install" | "pair" | "list" | `chat:${string}`} */
let shown = "";
let prepending = false;
/** @type {IntersectionObserver | undefined} */
let olderObserver;
/** @type {IntersectionObserver | undefined} */
let pictureObserver;
const PICTURES_MAX = 30;
/** @type {ResizeObserver | undefined} */
let pictureSizes;
let atLogEnd = true;
let sliding = false;
/** @type {number | undefined} */
let noticeAt;
/** @type {{ id: string, name: string, until: number } | undefined} */
let renamed;
let badged = -1;
/** @type {string | undefined} */
let notice;

/** @param {unknown} text */
function esc(text) {
	return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

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
	return ageText(iso, Date.now());
}

function deviceName() {
	const ua = navigator.userAgent;
	const name = /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android" : "Browser";
	return standalone() ? `${name} (Home Screen)` : name;
}

/** @param {string} path */
function shortPath(path) {
	return path.replace(/^\/(Users|home)\/[^/]+/, "~");
}

function standalone() {
	return matchMedia("(display-mode: standalone)").matches || /** @type {any} */ (navigator).standalone === true;
}

/** A browser tab on iOS, whose Home Screen app keeps storage of its own, so pairing here does not pair that app. */
function iosTab() {
	return /** @type {any} */ (navigator).standalone === false;
}

/** @param {unknown} error @param {string} [prefix] */
function handleError(error, prefix = "") {
	if (error instanceof Unauthorized) {
		closeStream();
		render();
		return;
	}
	showError(prefix + failure(error));
}

/** @param {unknown} error */
function loadError(error) {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof TypeError || /^HTTP 5\d\d$/.test(message)) return;
	handleError(error);
}

/** @param {unknown} error */
function failure(error) {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof TypeError) return errorText("unreachable");
	return errorText(/^HTTP 5\d\d$/.test(message) ? "internal_error" : message);
}

/** @param {string} text */
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
		keptPending.prune(state.sessions.map((s) => s.id));
		holdRename();
		if (chat && state.chat === chat && listed(chat, was, state.sessions.find((s) => s.id === chat.id)?.state, asked))
			void loadMessages();
		state.loaded = true;
		badge(state.sessions.filter((s) => s.state === "needs").length);
		if (notice) showError(notice);
		notice = undefined;
		const starting = state.starting;
		if (starting?.id && paneUp(state.sessions, starting.id)) {
			state.starting = undefined;
			clearTimeout(startTimer);
			if (!state.chat) {
				location.hash = `#s/${encodeURIComponent(starting.id)}`;
				return;
			}
		}
		if (state.chat && !state.sessions.some((s) => s.id === state.chat?.id)) {
			leaveChat(state.chat);
			return;
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

/** @param {number} count */
function badge(count) {
	if (count === badged || !("setAppBadge" in navigator)) return;
	badged = count;
	setBadgeWhereAllowed(count);
}

/** @param {number} count */
function setBadgeWhereAllowed(count) {
	try {
		(count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
	} catch {}
}

async function loadDirectories() {
	try {
		state.directories = await api.directories();
		render();
	} catch (error) {
		loadError(error);
	}
}

/** @param {string} id */
function waitForPane(id) {
	const starting = { id };
	state.starting = starting;
	clearTimeout(startTimer);
	startTimer = setTimeout(() => {
		if (state.starting !== starting) return;
		state.starting = undefined;
		if (state.chat) arrive(state.chat, { startTimedOut: true }, Date.now());
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

async function loadOlder() {
	const chat = state.chat;
	const first = chat?.messages[0];
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
	// The observer only reports a change. A short or dropped page can leave the top in view, and so
	// can a failed one, tried again a little later so that it does not repeat as fast as it fails.
	if (!failed) {
		if ($("#scroll").scrollTop < OLDER_MARGIN) void loadOlder();
	} else {
		setTimeout(() => {
			if (state.chat === chat && $("#scroll")?.scrollTop < OLDER_MARGIN) void loadOlder();
		}, OLDER_RETRY_MS);
	}
}

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
	carryOut(chat, arrive(chat, { status: report }, Date.now()));
	if (report && !chat.commandsAsked) {
		chat.commandsAsked = true;
		void loadCommands();
	}
	for (const task of chat.stoppingTasks) {
		if (!report?.tasks?.some((t) => t.id === task)) chat.stoppingTasks.delete(task);
	}
	const skipped = report?.notice;
	if (skipped && skipped.at !== noticeAt) {
		noticeAt = skipped.at;
		showError(skipped.text);
		return;
	}
	render();
}

async function loadCommands() {
	const chat = state.chat;
	if (!chat) return;
	try {
		const commands = await api.commands(chat.id);
		commandsCache.set(chat.id, commands);
		if (state.chat === chat) render();
	} catch (error) {
		if (error instanceof Unauthorized) handleError(error);
	}
}

/**
 * pistatusline's lines, span by span. Each one's colours are set on its element, which the CSP
 * allows where it refuses a style attribute.
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

/** @param {HTMLElement} bar */
function markStatuslineEnd(bar) {
	bar.classList.toggle("end", bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 1);
}

function replyEndedUnplaced() {
	const chat = state.chat;
	if (!chat) return;
	clearTimeout(chat.liveClear);
	chat.liveRetracted = true;
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

function closeStream() {
	source?.close();
	source = undefined;
	clearTimeout(offlineTimer);
	clearTimeout(watchdog);
	offlineTimer = watchdog = undefined;
}

function connect() {
	closeStream();
	if (!getToken() || document.visibilityState === "hidden") return;
	streamId = crypto.getRandomValues(new Uint32Array(2)).join("-");
	const current = api.events(state.chat?.id, streamId);
	source = current;
	// A sleeping Mac leaves the connection hanging without an error, so the timer starts with every stream.
	offlineTimer = setTimeout(() => setOnline(false), OFFLINE_AFTER_MS);
	const alive = () => {
		clearTimeout(watchdog);
		watchdog = setTimeout(() => {
			setOnline(false);
			current.reconnect();
			alive();
		}, WATCHDOG_MS);
	};
	alive();
	current.addEventListener("open", () => {
		clearTimeout(offlineTimer);
		offlineTimer = undefined;
		alive();
		setOnline(true);
		void checkPush();
		if (state.chat?.live) replyEndedUnplaced();
		void loadSessions();
		void loadMessages();
		void loadStatus();
	});
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
		const { sessionId, live, entryId } = JSON.parse(event.data);
		const chat = state.chat;
		if (!chat || sessionId !== chat.id) return;
		if (!live) {
			if (entryId) replyEndedAt(chat, entryId);
			else replyEndedUnplaced();
			void loadMessages();
			return;
		}
		clearTimeout(chat.liveClear);
		chat.liveRetracted = false;
		chat.live = live;
		render();
	});
	current.addEventListener("status", (/** @type {MessageEvent} */ event) => {
		alive();
		const { sessionId, outcomes } = JSON.parse(event.data);
		const chat = state.chat;
		if (!chat || sessionId !== chat.id) return;
		if (carryOut(chat, arrive(chat, { outcomes }, Date.now()))) render();
		void loadStatus();
	});
	current.addEventListener("outcomes", (/** @type {MessageEvent} */ event) => {
		alive();
		const { sessionId, outcomes } = JSON.parse(event.data);
		const chat = state.chat;
		if (!chat || sessionId !== chat.id) return;
		carryOut(chat, arrive(chat, { replay: outcomes }, Date.now()));
		render();
	});
	current.addEventListener("ping", alive);
	current.addEventListener("error", () => {
		offlineTimer ??= setTimeout(() => setOnline(false), OFFLINE_AFTER_MS);
	});
	current.addEventListener("unauthorized", () => handleError(new Unauthorized("unauthorized")));
}

function pushSupported() {
	return standalone() && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

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
	// Asked before any await, because iOS shows the prompt only while the tap still counts as a user gesture.
	const permission = Notification.requestPermission();
	if (enablingPush) return;
	enablingPush = true;
	try {
		if ((await permission) !== "granted") throw new Error("push_denied");
		const { publicKey } = await api.pushKey();
		const { pushManager } = await navigator.serviceWorker.ready;
		// One made for an earlier key (a reset remote.json) cannot be reused.
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

function pairView() {
	const how = standalone()
		? "On the Mac, run <code>/remote-control</code> and type the 6-digit code shown under the QR code."
		: "On the Mac, run <code>/remote-control</code> and scan the QR code with your phone's camera. Can't scan? Type the 6-digit code shown under it.";
	return `<form class="pair" id="pair">
${mascotHtml("wave", "big")}<h1>bluclawd</h1>
<p class="muted">${how}</p>
<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000" aria-label="Pairing code">
<button>Pair</button><div class="error" id="pair-error"></div></form>`;
}

/** Pairing on iOS happens in the Home Screen app, once, because it keeps its token and only it gets notifications. */
function installView() {
	return `<div class="pair install">
${mascotHtml("wave", "big")}<h1>bluclawd</h1>
<ol><li>Tap Share, then <b>Add to Home Screen</b>.</li><li>Open bluclawd from the Home Screen.</li><li>Type the 6-digit code shown on the Mac under the QR code.</li></ol>
<p class="muted">It stays paired from then on, and can notify you.</p>
<button type="button" class="link" id="stay">Use in Safari instead</button></div>`;
}

function listShell() {
	return `<header class="bar"><span class="avatar" id="avatar"></span><h1>Sessions</h1><span class="dot" id="online" role="img"></span>
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
function statusWord(s) {
	return s.silent ? "Not responding" : (STATE_WORDS[/** @type {keyof typeof STATE_WORDS} */ (s.state)] ?? s.state);
}

/** @param {import("./mascot.js").MascotState} acting */
function showAvatar(acting) {
	const avatar = $("#avatar");
	if (avatar.dataset.state === acting) return;
	avatar.dataset.state = acting;
	avatar.innerHTML = mascotHtml(acting);
}

/** @param {Session} s */
function rowHtml(s) {
	const glyph =
		s.alive && !s.silent && s.state === "working"
			? '<span class="session-spinner"></span>'
			: s.silent
				? "✻"
				: statusGlyph(s);
	const status = statusWord(s);
	const tone = rowTone(s);
	const where = s.cwd.split("/").filter(Boolean).at(-1);
	const doing = s.dialog?.title || s.detail;
	const warning = sharedWarning(s);
	const detail = [
		warning && `<span class="shared-warning">${esc(warning)}</span>`,
		where && esc(where),
		doing && esc(doing),
	]
		.filter(Boolean)
		.join(" · ");
	const said = status === STATE_WORDS.idle ? "" : `<span class="session-state ${esc(tone)}">${esc(status)}</span>`;
	const unseen = isUnseen(s, seen);
	const mark = unseen ? '<span class="unseen-dot" role="img" aria-label="Unseen"></span>' : "";
	return `<a class="row${s.alive ? "" : " closed"}${unseen ? " unseen" : ""}" href="#s/${encodeURIComponent(s.id)}"><span class="glyph ${esc(tone)}" aria-hidden="true">${glyph}</span>
<span class="name">${mark}${esc(s.label)}<small>${detail}</small></span>
<span class="age">${said}<span>${age(ageAt(s))}</span></span></a>`;
}

function rowsHtml() {
	if (!state.loaded) return loaderHtml();
	if (state.sessions.length === 0)
		return `<div class="empty">${mascotHtml("idle", "mid")}<p>No sessions. Start one below.</p></div>`;
	const found = filterSessions(state.sessions, state.query);
	if (found.length === 0) return `<p class="empty">No sessions match “${esc(state.query.trim())}”.</p>`;
	return sessionGroups(found, state.viewMode)
		.map(({ title, rows }) => `<h2 class="band">${esc(title)}</h2>${rows.map(rowHtml).join("")}`)
		.join("");
}

function chatShell() {
	return `<header class="bar"><a class="back icon-btn" href="#" aria-label="Sessions">${ICONS.back}</a><span class="avatar" id="avatar"></span><button class="title" id="title" aria-haspopup="dialog"><span class="name" id="title-name"></span><small id="title-state"></small></button>
</header>
<div class="statusbar" id="statusbar" role="button" tabindex="0" aria-haspopup="dialog" aria-label="Status" hidden></div>
<section class="scroll" id="scroll"><div class="older" id="older"></div><div class="log" id="log">
<div class="part" id="msgs"></div><div class="part" id="live"></div><div class="part" id="pending"></div><div class="part" id="working"></div></div>
<div class="float" id="float" hidden></div></section>
<div id="banner"></div><div class="commands" id="commands" role="listbox" aria-label="Commands" hidden></div><div id="selected-skills"></div><div class="thumbs" id="thumbs" hidden></div>
<form class="composer" id="composer"><label class="attach" id="attach">${ICONS.attach}
<input type="file" id="file" accept="image/*" multiple aria-label="Attach photos"></label>
<textarea id="text" rows="1" placeholder="Reply" aria-label="Reply" maxlength="32768"></textarea>
<button class="send" aria-label="Send">${ICONS.send}</button></form>
<div class="backdrop" id="backdrop" hidden></div><section class="sheet" id="sheet" role="dialog" aria-label="Session status" hidden></section>
<div class="viewer" id="viewer" role="dialog" aria-label="Image" hidden><img id="viewer-img" alt="Image"></div>`;
}

/** @param {Message} m */
function picturesHtml(m) {
	if (!m.images?.length) return "";
	const buttons = m.images.map(
		(image) =>
			`<button type="button" class="pic" data-entry="${esc(m.id)}" data-index="${esc(image.index)}" aria-label="Image ${esc(image.index + 1)}, full screen"><img alt="Image"></button>`,
	);
	return `<div class="pictures">${buttons.join("")}</div>`;
}

/** @param {string[]} lines */
function outHtml(lines) {
	return `<span class="out"><span class="hook" aria-hidden="true">⎿</span><span class="lines">${esc(lines.join("\n"))}</span></span>`;
}

/** @param {string} name @param {string} summary @param {Message | undefined} result @param {string} key @param {boolean} [running] */
function toolHtml(name, summary, result, key, running = false) {
	const call = `<span class="call"><span class="tool">${toolIcon(name)}</span><span class="said"><b>${esc(name.charAt(0).toUpperCase() + name.slice(1))}</b>${summary ? ` ${esc(summary)}` : ""}</span></span>`;
	if (!result) return `<div class="t${running ? " running" : ""}">${call}</div>`;
	const kind = result.ok ? "t" : "t err";
	if (result.diff) {
		const { added, removed } = diffCounts(result.diff);
		return `<div class="${kind}">${call}${outHtml([diffSummary(added, removed)])}
${diffHtml(result.diff, result.diffTruncated)}</div>${picturesHtml(result)}`;
	}
	const full = state.chat.outputs.get(result.id);
	const text = shownText(full?.text ?? result.text ?? "", result.images);
	const cut = full?.text !== undefined ? full.truncated : result.truncated;
	const out = outHtml(resultSummary(name, { text, ok: result.ok, truncated: cut }));
	if (!text.trim()) return `<div class="${kind}">${call}${out}</div>${picturesHtml(result)}`;
	return `<details class="${kind}" data-key="${esc(key)}"><summary>${call}${out}</summary>
<pre>${esc(text)}${cut ? "\n…" : ""}</pre>${fullOutputHtml(result, full)}</details>${picturesHtml(result)}`;
}

/** @param {Message} result @param {{ text?: string, error?: string, loading?: boolean } | undefined} full */
function fullOutputHtml(result, full) {
	if (!result.truncated || !ENTRY_ID.test(result.id) || full?.text !== undefined) return "";
	const error = full?.error ? `<p class="error">${esc(full.error)}</p>` : "";
	const label = full?.loading ? "Loading…" : full?.error ? "Try again" : "Show full output";
	return `${error}<button type="button" class="full" data-entry="${esc(result.id)}"${full?.loading ? " disabled" : ""}>${label}</button>`;
}

/** @param {Session | undefined} session */
function logParts(session) {
	const calls = new Set(state.chat.messages.flatMap((m) => (m.tools ?? []).map((t) => t.id)));
	const running = new Set((state.chat.live?.tools ?? []).filter((t) => t.running).map((t) => t.id));
	const live = [...state.chat.held.map((h) => ({ ...h, tools: [] })), ...(state.chat.live ? [state.chat.live] : [])]
		.map((l) => liveHtml(l, calls))
		.join("");
	const pending = pendingHtml();
	const working = workingHtml(session);
	let msgs = transcriptHtml(calls, running, midTurn(session));
	if (!msgs && !live && !pending && !working) {
		msgs = state.chat.messagesLoaded
			? `<div class="empty">${mascotHtml("idle", "mid")}<p>Nothing in this session yet.</p></div>`
			: loaderHtml();
	}
	return { msgs, live, pending, working };
}

const WORKING_WORDS = { thinking: "Thinking…", writing: "Writing…", tool: "Running a tool…" };

/** @param {Session | undefined} session */
function workingHtml(session) {
	const acting = mascotState(session, state.chat.live, state.online);
	const words = WORKING_WORDS[/** @type {keyof typeof WORKING_WORDS} */ (acting)];
	if (!session || !words) return "";
	const tool = state.chat.live?.tools.find((t) => t.running);
	const since = turnSince(state.chat.messages, state.chat.pending);
	const time = since ? `<span class="elapsed" data-since="${esc(since)}"></span>` : "";
	return `<div class="working">${mascotHtml(acting)}<span class="label">${esc(tool ? `Running ${tool.name}…` : words)}</span>${time}</div>`;
}

/** @param {Set<string>} calls @param {Set<string>} running @param {boolean} midTurn */
function transcriptHtml(calls, running, midTurn) {
	const times = turnTimes(state.chat.messages, midTurn);
	/** @type {Map<string, Message>} */
	const results = new Map();
	for (const m of state.chat.messages) if (m.kind === "toolResult" && m.toolCallId) results.set(m.toolCallId, m);
	const parts = [];
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
	let prompted = state.chat.more;
	for (const m of state.chat.messages) {
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
			if (m.aborted) parts.push(`<div class="t interrupted">${outHtml(["Interrupted"])}</div>`);
		} else if (m.kind === "toolResult" && !(m.toolCallId && calls.has(m.toolCallId))) {
			parts.push(toolHtml(m.toolName ?? "tool", m.command ?? "", m, m.id));
		} else if (m.kind === "marker") {
			const kind = markerKind(m.text ?? "", !prompted);
			if (kind === "interrupted") parts.push(`<div class="t interrupted">${outHtml([m.text ?? ""])}</div>`);
			else if (kind === "plain") parts.push(`<div class="marker">${esc(m.text)}</div>`);
		}
		const took = times.get(m.id);
		if (took !== undefined && took >= 1000) {
			flush();
			parts.push(`<div class="turn-time">Worked for ${esc(duration(took))}</div>`);
		}
	}
	flush();
	return parts.join("");
}

/** @param {string[]} names @param {string[]} blocks @param {string} key */
function groupHtml(names, blocks, key) {
	return `<details class="run" data-key="${esc(key)}"><summary>${ICONS.wrench}${esc(groupSummary(names))}</summary><div class="steps">${blocks.join("")}</div></details>`;
}

/** @param {string} thinking @param {string} key */
function thinkingBlock(thinking, key) {
	return `<details class="think" data-key="${esc(key)}"><summary>${ICONS.brain}Thinking</summary><pre>${esc(thinking)}</pre></details>`;
}

const PENDING_LABELS = {
	sent: "sent · waiting for the session",
	taken: "taken",
	queued: "queued · after the current turn",
};

function pendingHtml() {
	return state.chat.pending
		.map(({ id, prompt, images, outcome }) => {
			const buttons = images.map(
				(_, index) =>
					`<button type="button" class="pic" data-pending="${id}" data-index="${index}" aria-label="Image ${index + 1}, full screen"><img alt="Image"></button>`,
			);
			const pictures = buttons.length ? `<div class="pictures">${buttons.join("")}</div>` : "";
			return `<div class="u${pictures ? " pics" : ""}">${pictures}${esc(prompt)}</div><div class="queued">${PENDING_LABELS[outcome ?? "sent"]}</div>`;
		})
		.join("");
}

/** @param {LiveSnapshot} live @param {Set<string>} calls */
function liveHtml(live, calls) {
	const parts = [];
	if (live.thinking) parts.push(thinkingBlock(live.thinking, "think:live"));
	if (live.text) parts.push(`<div class="a">${markdown(live.text)}</div>`);
	for (const tool of live.tools) {
		if (!calls.has(tool.id)) parts.push(toolHtml(tool.name, tool.summary, undefined, tool.id, tool.running));
	}
	return parts.join("");
}

/** @param {Session | undefined} session */
function canAct(session) {
	return session !== undefined && replyBox(session, state.terminalOpen).open;
}

/** @param {Session | undefined} session */
function bannerHtml(session) {
	if (!state.online) {
		if (state.chat) return "";
		return `<div class="banner off">Mac unreachable: check that Tailscale is on in this phone and the Mac is awake, with remote control on. Retrying…</div>`;
	}
	const error = state.error ? `<div class="banner off">${esc(state.error)}</div>` : "";
	if (state.loaded && !state.terminalOpen) {
		return `${error}<div class="banner closed">pi is not open on the Mac: everything here is read only until a terminal there shows it again.</div>`;
	}
	if (session?.state === "needs") {
		const title = session.dialog?.title;
		const text = title ? `Waiting on the Mac: ${esc(title)}` : "Waiting for an answer on the Mac.";
		return `${error}<div class="banner needs">${text}</div>`;
	}
	if (session && !session.alive) {
		return `${error}<div class="banner closed">Disconnected: this session was closed on the Mac. It reconnects here once it is opened there again.</div>`;
	}
	if (session?.silent) {
		return `${error}<div class="banner closed">Not responding: this session stopped answering on the Mac, which may be asleep or busy. Waiting for it…</div>`;
	}
	if (error) return error;
	if (!session && state.homeScreenHint) {
		return `<div class="banner hint"><span>Now add it to the Home Screen: the app opens already paired.</span>
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

/** @param {Report["context"]} context */
function contextHtml(context) {
	if (!context) return "";
	if (context.tokens === null || context.percent === null) {
		return `<div class="context"><span>Context</span><span>${esc(tokens(context.contextWindow))} · after the next reply</span></div>`;
	}
	const percent = Math.min(100, Math.max(0, context.percent));
	const step = Math.ceil(percent / 10) * 10;
	const level = contextLevel(percent);
	const color = level === "normal" ? "" : ` ${level}`;
	return `<div class="context"><span>Context</span><span class="context-used ${level}">${esc(tokens(context.tokens))} / ${esc(tokens(context.contextWindow))} · ${esc(Math.round(percent))}%</span></div>
<div class="gauge" role="meter" aria-label="Context used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${esc(Math.round(percent))}"><span class="p${esc(step)}${color}"></span></div>`;
}

/** @param {Report["usage"]} usage */
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
	const head = `<header class="sheet-bar"><h2>Status</h2><span class="sheet-tools">${pinHtml(session)}<button class="icon-btn close" id="sheet-close" aria-label="Close">${ICONS.close}</button></span></header>
${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}`;
	if (report === undefined) return `${head}${loaderHtml()}`;
	if (report === null || session?.silent) {
		const why = session && !session.alive ? "session_not_running" : session?.silent ? "session_silent" : "no_status";
		return `${head}<p class="muted">${esc(errorText(why))}</p>`;
	}
	return `${head}${settingsHtml(report, allows(session, "settings"))}
<div class="numbers">${contextHtml(report.context)}${usageHtml(report.usage)}${runUsageHtml(report.subagentUsage)}${whereHtml(report, session && shortPath(session.cwd))}</div>`;
}

const TASK_KINDS = { shell: "Shell", monitor: "Monitor", agent: "Agent" };

function tasksHtml() {
	const tasks = state.chat.report?.tasks ?? [];
	const closed = !allows(
		state.sessions.find((s) => s.id === state.chat.id),
		"tasks",
	);
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
				: `<button class="task-btn danger" data-stop="${id}"${stopping || closed ? " disabled" : ""}>${stopping ? "Stopping…" : "Stop"}</button>`;
		return `<li class="task"><div class="task-head"><span class="task-kind">${esc(kind)}</span><span class="task-age">${esc(elapsedText(task.startedAt, now))}</span></div>
<div class="task-label">${esc(task.label)}</div><div class="task-actions">${outputButton}${stop}</div>${shown}</li>`;
	});
	return `<header class="sheet-bar"><h2>Background tasks</h2><button class="icon-btn close" id="sheet-close" aria-label="Close">${ICONS.close}</button></header>
${state.error ? `<p class="error">${esc(state.error)}</p>` : ""}${rows.length ? `<ul class="tasks">${rows.join("")}</ul>` : `<p class="muted">No background tasks are running.</p>`}`;
}

function render() {
	const unpaired = iosTab() && !state.stayInBrowser ? "install" : "pair";
	/** @type {typeof shown} */
	const view = !getToken() ? unpaired : state.chat ? `chat:${state.chat.id}` : "list";
	if (view !== shown) {
		shown = view;
		closePicker();
		app.innerHTML =
			view === "install"
				? installView()
				: view === "pair"
					? pairView()
					: view === "list"
						? listShell()
						: chatShell();
		if (view === "install") bindInstall();
		else if (view === "pair") bindPair();
		else if (view === "list") bindList();
		else bindChat();
	}
	if (view === "list") updateList();
	else if (view !== "pair" && view !== "install") updateChat();
	if (state.chat) keptPending.save(state.chat);
}

function updateList() {
	const live = state.online && state.terminalOpen;
	const online = $("#online");
	const status = live ? "Online" : state.online ? "pi is closed on the Mac" : "Offline";
	online.setAttribute("aria-label", status);
	online.title = status;
	online.classList.toggle("on", live);
	showAvatar(fleetState(state.sessions, live));
	$("#notify").hidden = !state.offerPush;
	const banner = $("#banner");
	const bannerNow = updateHtml() + bannerHtml(undefined);
	if (banner.dataset.html !== bannerNow) {
		banner.innerHTML = bannerNow;
		banner.dataset.html = bannerNow;
	}
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
	$("#new-resume").hidden = !state.terminalOpen;
	start.classList.toggle("busy", state.starting !== undefined);
	$("#new-task").classList.toggle("starting", state.starting !== undefined);
	updatePhoneSheet();
}

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
		const { id } = await api.resume(cwd, sessionFile);
		waitForPane(id);
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

function newCommands() {
	return state.terminalOpen ? NEW_COMMANDS : NEW_COMMANDS.filter((c) => c.name !== "resume");
}

function updateNewCommands() {
	const value = $("#task").value;
	const commands = value.startsWith("/") ? matchCommands(newCommands(), value) : [];
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
		setNewOptions(true, $);
		$("#cwd").focus();
	}
}

function pickNewModel() {
	/** @type {HTMLElement | null} */ (document.activeElement)?.blur();
	const toValue = (/** @type {{ provider: string, id: string }} */ m) => `${m.provider}/${m.id}`;
	const groups = [{ options: [{ value: "", label: "Default model" }] }, ...modelGroups(state.models, toValue)];
	openPicker({ title: "Model", groups, value: state.newModel }, (value) => {
		state.newModel = value;
		updateModels();
	});
}

/** @param {string} key */
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
		openPicker({ title: "Trust", groups: [{ options }], value: report.trust ?? "" }, (value) => {
			const trust = TRUST.find(([known]) => known === value)?.[0];
			if (!trust || trust === report.trust) return;
			state.chat.report = { ...report, trust };
			render();
			void switchSetting((id) => api.setTrust(id, trust));
		});
	}
}

/** @param {number} index @param {boolean} send */
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
	$("#title-name").textContent = session?.label ?? "";
	const word = $("#title-state");
	word.textContent = !session ? "" : state.online ? statusWord(session) : "Offline";
	word.className = `session-state ${session && state.online ? rowTone(session) : "off"}`;
	showAvatar(mascotState(session, state.chat.live, state.online));
	if (!midTurn(session)) state.chat.stopping = false;
	const bar = $("#statusbar");
	const lines = state.chat.report?.statusline?.lines;
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
	const scroll = $("#scroll");
	const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
	const height = scroll.scrollHeight;
	const banner = $("#banner");
	const bannerNow = updateHtml() + bannerHtml(session);
	const bannerChanged = banner.dataset.html !== bannerNow;
	if (bannerChanged) {
		banner.innerHTML = bannerNow;
		banner.dataset.html = bannerNow;
	}
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
	if (working) tickElapsed();
	const float = updateFloat(session);
	if ((msgs || pending || live || working || float || bannerChanged) && atBottom && !prepending)
		scroll.scrollTop = scroll.scrollHeight;
	if (prepending) scroll.scrollTop += scroll.scrollHeight - height;
	prepending = false;
	const box = session ? replyBox(session, state.terminalOpen) : { open: true, placeholder: "Reply" };
	const closed = !box.open;
	updateSheet(session);
	const text = $("#text");
	text.disabled = closed;
	updateSend(session);
	const attach = $("#attach");
	const file = $("#file");
	file.disabled = closed || state.chat.attachments.length + state.chat.reading >= ATTACH_MAX;
	attach.classList.toggle("busy", state.chat.reading > 0);
	file.setAttribute("aria-label", state.chat.reading ? "Reading the photos…" : "Attach photos");
	text.placeholder = box.placeholder;
	updateThumbs();
	updateCommands();
}

/** @param {Session | undefined} session @returns {boolean} */
function updateFloat(session) {
	const chat = state.chat;
	const items = [];
	if (!state.online) items.push(`<span class="pill-item off">Reconnecting to the Mac…</span>`);
	if (session?.state === "working" && !atLogEnd) {
		const since = turnSince(chat.messages, chat.pending);
		const time = since ? ` for <span class="elapsed" data-since="${esc(since)}"></span>` : "…";
		items.push(
			`<span class="pill-item"><span class="session-spinner" aria-hidden="true"></span>Working${time}</span>`,
		);
	}
	const queued = chat.pending.filter((p) => p.outcome === "queued").length;
	if (queued) items.push(`<span class="pill-item">${queued} queued</span>`);
	const tasks = chat.report?.tasks?.length ?? 0;
	if (tasks) {
		items.push(
			`<button type="button" class="pill-item" data-float="tasks" aria-haspopup="dialog" aria-label="${tasks} background task${tasks === 1 ? "" : "s"}">${ICONS.terminal}${tasks}</button>`,
		);
	}
	if (!atLogEnd)
		items.push(`<button type="button" class="pill-item end" data-float="end" aria-label="To the end">↓</button>`);
	const float = $("#float");
	const html = items.join("");
	if (float.dataset.html === html) return false;
	float.innerHTML = html;
	float.dataset.html = html;
	float.hidden = html === "";
	tickElapsed();
	return true;
}

function tickElapsed() {
	for (const el of document.querySelectorAll(".elapsed[data-since]")) {
		el.textContent = duration(Date.now() - Date.parse(/** @type {HTMLElement} */ (el).dataset.since ?? ""));
	}
}

/** @param {Session | undefined} session */
function updateSend(session) {
	const chat = state.chat;
	const button = $(".send");
	const action = sendAction(session);
	const stop = action === "stop";
	button.dataset.action = action;
	button.classList.toggle("stop", stop);
	button.classList.toggle("queue", action === "queue");
	button.classList.toggle("busy", stop && chat.stopping);
	button.disabled = action === "off" || (stop ? chat.stopping : chat.reading > 0);
	button.setAttribute("aria-label", stop ? "Stop" : action === "queue" ? "Queue" : "Send");
	const icon = stop ? ICONS.stop : ICONS.send;
	if (button.dataset.html !== icon) {
		button.innerHTML = icon;
		button.dataset.html = icon;
	}
}

/** @param {Session | undefined} session */
function sendAction(session) {
	return composerAction({
		content: $("#text").value.trim() !== "",
		turn: midTurn(session),
		open: session ? canAct(session) : true,
		sentAt: state.chat.sentAt,
		now: Date.now(),
	});
}

async function stopTurn() {
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
}

function updateCommands() {
	const list = $("#commands");
	const chat = state.chat;
	if (!chat) return;
	const found = chat.skillDraft.suggestions(commandsCache.get(chat.id) ?? [], $("#text").selectionStart);
	$("#selected-skills").innerHTML = chat.skillDraft.selectedHtml();
	const html = found
		.map(
			({ command: c, start, end }) =>
				`<button type="button" class="command" role="option" data-command="${esc(c.name)}" data-start="${start}" data-end="${end}"><b>/${esc(c.name)}</b>${c.skill ? `<small>${esc(skillProvenance(c))}</small>` : ""}${c.description ? `<small>${esc(c.description)}</small>` : ""}</button>`,
		)
		.join("");
	if (list.dataset.html === html) return;
	list.innerHTML = html;
	list.dataset.html = html;
	list.hidden = html === "";
}

/** @type {WeakMap<Element, string>} */
const partHtml = new WeakMap();

/** @param {HTMLElement} part @param {string} html @returns {boolean} */
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

/** @param {Session | undefined} session */
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
	if (sheet.dataset.html !== "status") {
		sheet.innerHTML = `<div class="part" id="sheet-status"></div><div class="part" id="sheet-rename"></div><div class="part" id="sheet-manage"></div>`;
		sheet.dataset.html = "status";
	}
	if (!sliding) updatePart($("#sheet-status"), sheetHtml(session));
	const rename = $("#sheet-rename");
	const renaming = String(allows(session, "rename"));
	if (rename.dataset.allowed !== renaming) {
		rename.innerHTML = renameHtml(session);
		rename.dataset.allowed = renaming;
	}
	updatePart($("#sheet-manage"), deleteHtml(session, state.chat.confirmDelete));
	const save = $("#rename-save");
	if (save) save.disabled = state.chat.saving;
}

/** @param {{ code: string } | { secret: string }} credential */
async function pair(credential) {
	try {
		const token = await api.pair(credential, deviceName());
		try {
			setToken(token);
		} catch {
			$("#pair-error").textContent = "This browser blocks storage; remote control needs it";
			return;
		}
		// Elsewhere the installed app shares this browser's storage; on iOS it does not.
		state.homeScreenHint = !standalone() && !iosTab();
		render();
		connect();
	} catch (error) {
		$("#pair-error").textContent = failure(error);
	}
}

/** @param {Element} el */
function keepFocusOnTap(el) {
	el.addEventListener("pointerdown", (/** @type {Event} */ event) => event.preventDefault());
}

function bindInstall() {
	$("#stay").addEventListener("click", () => {
		state.stayInBrowser = true;
		render();
		const secret = state.pendingSecret;
		state.pendingSecret = undefined;
		if (secret) void pair({ secret });
	});
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

function bindList() {
	const mode = $("#view-mode");
	mode.value = state.viewMode;
	mode.addEventListener("change", () => {
		state.viewMode = viewMode(mode.value);
		tryStorage(() => localStorage.setItem(VIEW_MODE_KEY, state.viewMode), undefined);
		updateList();
	});
	const task = $("#task");
	$("#new-options").addEventListener("click", () => {
		setNewOptions(!$("#new-task").classList.contains("expanded"), $);
	});
	task.addEventListener("input", () => {
		grow(task);
		updateNewCommands();
	});
	keepFocusOnTap($("#new-commands"));
	$("#new-commands").addEventListener("click", (/** @type {Event} */ event) => {
		const item = /** @type {HTMLElement | null} */ (
			/** @type {Element} */ (event.target).closest("[data-new-command]")
		);
		if (item?.dataset.newCommand) runNewCommand(item.dataset.newCommand);
	});
	$("#new-resume").addEventListener("click", pickResume);
	const search = $("#search");
	search.value = state.query;
	/** @param {string} query */
	const find = (query) => {
		state.query = query;
		updateList();
	};
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
	$("#search-form").addEventListener("submit", (/** @type {Event} */ event) => {
		event.preventDefault();
		search.blur();
	});
	keepFocusOnTap($("#search-clear"));
	$("#search-clear").addEventListener("click", () => {
		search.value = "";
		find("");
		search.focus();
	});
	keepFocusOnTap($("#search-cancel"));
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
	keepFocusOnTap($("#new-model"));
	$("#new-model").addEventListener("click", pickNewModel);
	const cwd = $("#cwd");
	cwd.addEventListener("focus", () => {
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
	cwd.addEventListener("keydown", (/** @type {KeyboardEvent} */ event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		cwd.blur();
	});
	const dirs = $("#cwd-list");
	keepFocusOnTap(dirs);
	dirs.addEventListener("click", (/** @type {Event} */ event) => {
		const item = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest("[data-dir]"));
		if (!item) return;
		state.cwdEdited = true;
		const step = item.dataset.step !== undefined;
		cwd.value = `${item.dataset.dir}${step ? "/" : ""}`;
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
	if (newCommands().some((c) => value === `/${c.name}`)) {
		runNewCommand(value.slice(1));
		return;
	}
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
		const { id } = await api.start(cwd, value, state.newModel || undefined);
		task.value = "";
		grow(task);
		waitForPane(id);
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
	atLogEnd = true;
	const scroll = $("#scroll");
	scroll.addEventListener("scroll", () => {
		const was = atLogEnd;
		atLogEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
		if (atLogEnd !== was) updateFloat(state.sessions.find((s) => s.id === state.chat?.id));
	});
	// A picture keeps its placeholder's height until its image is in. The load event does not bubble.
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
	state.chat.skillDraft = createSkillDraft({
		text: keptPending.draft(state.chat.id),
		selections: keptPending.draftSkills(state.chat.id),
	});
	text.value = state.chat.skillDraft.text;
	/** @type {number | undefined} */
	let beforeEdit;
	text.addEventListener("beforeinput", () => {
		beforeEdit = text.selectionStart;
	});
	text.addEventListener("click", updateCommands);
	text.addEventListener("keyup", updateCommands);
	grow(text);
	text.addEventListener("input", () => {
		state.chat.skillDraft.edit(text.value, beforeEdit, text.selectionStart);
		beforeEdit = undefined;
		grow(text);
		updateCommands();
		updateSend(state.sessions.find((s) => s.id === state.chat.id));
		keptPending.saveDraft(state.chat.id, text.value, state.chat.skillDraft.snapshot().selections);
	});
	$("#composer").addEventListener("submit", (/** @type {Event} */ event) => {
		event.preventDefault();
		if (sendAction(state.sessions.find((s) => s.id === state.chat.id)) === "stop") void stopTurn();
		else void send();
	});
	const commands = $("#commands");
	keepFocusOnTap(commands);
	commands.addEventListener("click", (/** @type {Event} */ event) => {
		const command = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest(".command"));
		if (!command) return;
		const start = Number(command.dataset.start),
			end = Number(command.dataset.end);
		const choice = commandsCache.get(state.chat.id)?.find((c) => c.name === command.dataset.command);
		if (!choice) return;
		const draft = state.chat.skillDraft;
		if (choice.source === "skill") draft.choose(choice, start, end);
		else
			draft.edit(
				`${text.value.slice(0, start)}/${choice.name} ${text.value.slice(end)}`,
				end,
				start + choice.name.length + 2,
			);
		text.value = draft.text;
		keptPending.saveDraft(state.chat.id, text.value, draft.snapshot().selections);
		grow(text);
		text.focus();
		const inserted =
			choice.source === "skill" ? (draft.snapshot().selections.at(-1)?.marker.length ?? 0) : choice.name.length + 2;
		text.setSelectionRange(start + inserted, start + inserted);
		updateCommands();
	});
	$("#selected-skills").addEventListener("click", (/** @type {Event} */ event) => {
		const button = /** @type {HTMLElement | null} */ (
			/** @type {Element} */ (event.target).closest("[data-remove-skill]")
		);
		if (!button) return;
		state.chat.skillDraft.remove(Number(button.dataset.removeSkill));
		text.value = state.chat.skillDraft.text;
		keptPending.saveDraft(state.chat.id, text.value, state.chat.skillDraft.snapshot().selections);
		grow(text);
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
	$("#float").addEventListener("click", (/** @type {Event} */ event) => {
		const button = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest("[data-float]"));
		if (button?.dataset.float === "tasks") openTasks();
		else if (button?.dataset.float === "end") $("#scroll").scrollTop = $("#scroll").scrollHeight;
	});
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
	// A thumb let go where it started gets no `change` from Safari, and its `change` may come after this.
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

function openSheet() {
	state.chat.sheetOpen = true;
	state.chat.tasksSheet = false;
	state.error = undefined;
	state.chat.confirmDelete = false;
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

function openTasks() {
	state.chat.tasksSheet = true;
	state.chat.sheetOpen = false;
	state.error = undefined;
	state.chat.confirmStop = undefined;
	state.chat.taskOutputs.clear();
	render();
}

/** @param {string} taskId */
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

/** @param {string} taskId */
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

/** @param {string} value */
async function switchModel(value) {
	const id = state.chat?.id;
	const model = state.chat?.report?.models[Number(value)];
	if (!id || !model) return;
	try {
		await api.setModel(id, model.provider, model.id);
	} catch (error) {
		handleError(error);
		void loadStatus();
	}
}

/** @param {(id: string) => Promise<unknown>} call */
async function switchSetting(call) {
	const id = state.chat?.id;
	if (!id) return;
	try {
		await call(id);
	} catch (error) {
		handleError(error);
		void loadStatus();
	}
}

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
	leaveChat(chat);
}

/** @type {import("./chat.js").Chat | undefined} */
let leftChat;

/** @param {import("./chat.js").Chat} chat */
function leaveChat(chat) {
	if (leftChat === chat) return;
	leftChat = chat;
	if (chat.backToList) history.back();
	else location.hash = "";
}

/** @param {string} entry */
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

/** @param {File[]} files */
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

/** @param {string} entry @param {string | number} index */
function pictureKey(entry, index) {
	return `${entry}\n${index}`;
}

/** @param {HTMLElement} button */
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

/** @param {HTMLElement} log */
function showPictures(log) {
	pictureObserver?.disconnect();
	for (const button of /** @type {NodeListOf<HTMLElement>} */ (log.querySelectorAll(".pic"))) {
		pictureSizes?.observe(button);
		if (!paint(button)) pictureObserver?.observe(button);
	}
}

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

/** @param {ResizeObserverEntry[]} entries */
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
	if (atLogEnd) scroll.scrollTop = scroll.scrollHeight;
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
	const chat = state.chat;
	const submission = chat?.skillDraft.submit();
	const value = submission?.text ?? text.value.trim();
	const session = state.sessions.find((s) => s.id === chat?.id);
	if (!value || !chat || !canAct(session) || chat.reading) return;
	if (!submission?.skills.length && chat.attachments.length === 0 && refused(value, commandsCache.get(chat.id))) {
		showError(errorText("terminal_command"));
		return;
	}
	const images = chat.attachments;
	const skillDraft = chat.skillDraft.snapshot();
	chat.skillDraft = createSkillDraft();
	text.value = "";
	keptPending.saveDraft(chat.id, "");
	text.style.height = "auto";
	chat.attachments = [];
	const entry = promptSent(chat, value, images, skillDraft, Date.now());
	setTimeout(render, SECOND_TAP_GUARD_MS);
	watchGiveUp();
	render();
	$("#scroll").scrollTop = $("#scroll").scrollHeight;
	try {
		const { lifetime } = await api.prompt(
			chat.id,
			value,
			images.map(({ mimeType, data }) => ({ mimeType, data })),
			entry.id,
			submission?.skills,
		);
		arrive(chat, { accepted: entry, lifetime }, Date.now());
		if (state.chat === chat) keptPending.save(chat);
	} catch (error) {
		carryOut(chat, arrive(chat, { notSent: entry }, Date.now()));
		handleError(error, "Not sent: ");
	}
}

/** @param {Chat} chat @param {import("./chat.js").Next} next @returns {boolean} */
function carryOut(chat, next) {
	for (const { entry } of next.returned) putBack(chat, entry);
	const reason = next.returned.at(-1)?.reason;
	if (reason) showError(RETURNED[/** @type {keyof typeof RETURNED} */ (reason)] ?? errorText("not_delivered"));
	if (next.ask.length) void askWaiting(chat, next.ask);
	watchGiveUp();
	return next.returned.length > 0;
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let giveUpTimer;

function watchGiveUp() {
	clearTimeout(giveUpTimer);
	const chat = state.chat;
	const at = chat && nextGiveUp(chat);
	if (!chat || at === undefined) return;
	giveUpTimer = setTimeout(
		() => {
			if (state.chat !== chat) return;
			const session = state.sessions.find((s) => s.id === chat.id);
			const row = { state: session?.state, silent: session?.silent, starting: state.starting !== undefined };
			const next = arrive(chat, { time: row }, Date.now());
			if (!carryOut(chat, next) && next.dropped) render();
		},
		Math.max(0, at - Date.now()),
	);
}

/** @typedef {import("./chat.js").Chat} Chat @typedef {import("./chat.js").Pending} Pending */

/** @param {Chat} chat @param {Pending} entry */
function putBack(chat, entry) {
	if (state.chat !== chat) return;
	const text = $("#text");
	const previous = chat.skillDraft.snapshot();
	const restored = entry.skillDraft ?? { text: entry.prompt, selections: [] };
	const prefix = restored.text + (previous.text ? "\n" : "");
	chat.skillDraft = createSkillDraft({
		text: prefix + previous.text,
		selections: [
			...restored.selections,
			...previous.selections.map((s) => ({ ...s, start: s.start + prefix.length })),
		],
	});
	text.value = chat.skillDraft.text;
	keptPending.saveDraft(chat.id, text.value, chat.skillDraft.snapshot().selections);
	updateCommands();
	grow(text);
	if (!chat.attachments.length) chat.attachments = entry.images;
}

/** @param {Chat} chat @param {import("./chat.js").Next["ask"]} waiting */
async function askWaiting(chat, waiting) {
	/** @type {import("./chat.js").PromptOutcome[]} */
	let outcomes;
	try {
		outcomes = await api.outcomes(chat.id, waiting);
	} catch (error) {
		if (error instanceof Unauthorized) handleError(error);
		return;
	}
	if (state.chat === chat && carryOut(chat, arrive(chat, { answer: outcomes }, Date.now()))) render();
}

function closePhoneSheet() {
	state.phoneSheet = false;
	state.confirmDisconnect = false;
	render();
}

async function disconnect() {
	state.confirmDisconnect = false;
	try {
		const self = (await api.devices()).find((device) => device.current);
		if (!self) throw new Error("unknown_device");
		await api.removeThisDevice(self.id);
	} catch (error) {
		if (!(error instanceof Error && error.message === "unknown_device")) {
			handleError(error);
			return;
		}
	}
	clearToken();
	closeStream();
	state.phoneSheet = false;
	render();
}

function claimLink() {
	const link = pairLink(location.hash);
	if (!link) return;
	history.replaceState(null, "", location.pathname + location.search);
	if (getToken()) return;
	if (iosTab() && !state.stayInBrowser) state.pendingSecret = link.secret;
	else void pair(link);
}

function route() {
	claimLink();
	const previous = state.chat;
	const match = /^#s\/(.+)$/.exec(location.hash);
	const open = match ? decodeURIComponent(match[1]) : undefined;
	if (open !== previous?.id) {
		clearTimeout(previous?.liveClear);
		if (previous) markSeen(previous.id);
		if (open !== undefined) markSeen(open);
		state.chat = open === undefined ? undefined : openChat(open, keptPending.load(open));
		if (state.chat && !previous) state.chat.backToList = true;
		state.error = undefined;
		state.phoneSheet = false;
		state.confirmDisconnect = false;
		connect();
	}
	render();
}

/**
 * While the keyboard is up, iOS keeps the layout viewport, and 100dvh, at the screen's height. It
 * also scrolls the page to show the field typed in, which pushes the header out of sight. The app
 * takes the height that shows instead, a sheet sits on the keyboard, and the page stays at its top.
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
darkScheme.addEventListener("change", render);
window.visualViewport?.addEventListener("resize", fitViewport);
window.visualViewport?.addEventListener("scroll", fitViewport);
fitViewport();
document.addEventListener("visibilitychange", () => {
	if (document.visibilityState === "visible") {
		connect();
	} else {
		if (state.chat) markSeen(state.chat.id);
		if (source) api.hidden(streamId);
		closeStream();
	}
});
window.addEventListener("pagehide", closeStream);
// Back from the page cache, which keeps no stream.
window.addEventListener("pageshow", (/** @type {PageTransitionEvent} */ event) => {
	if (event.persisted && document.visibilityState === "visible") connect();
});
setInterval(tickElapsed, 1000);
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
	navigator.serviceWorker.addEventListener("message", (/** @type {MessageEvent} */ event) => {
		const id = event.data?.open;
		if (typeof id === "string") location.hash = `#s/${encodeURIComponent(id)}`;
	});
}

claimLink();
const opened = /^#s\/(.+)$/.exec(location.hash)?.[1];
if (opened) {
	const id = decodeURIComponent(opened);
	state.chat = openChat(id, keptPending.load(id));
	markSeen(id);
}
render();
connect();
