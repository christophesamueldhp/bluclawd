// @ts-check
/**
 * bluclawd's remote control on a phone: the session list (agent view's bands) with a composer
 * that starts a session, and one session's chat, whose title and status bar open its status sheet. Only the
 * parts that change are re-rendered, so the composers keep their text, focus and keyboard while
 * updates arrive.
 */
import { api, clearToken, getToken, pairLink, setToken, Unauthorized } from "./api.js";
import { diffCounts, diffHtml } from "./diff.js";
import { ageAt, successor } from "./list.js";
import { giveUp, promptKey, promptText, refused, sentText, settle, shortcut, shownText } from "./live.js";
import { markdown } from "./markdown.js";
import { filterSessions } from "./search.js";
import { barHtml, factsHtml, thinkingHtml, tokens } from "./statusbar.js";

/**
 * `sessionId`: pi's, the same under another row id; `dialog`: the one it waits on, while it needs input.
 * @typedef {{ id: string, label: string, cwd: string, band: string, state: string, alive: boolean, resumable: boolean, detail: string, createdAt?: string, finishedAt?: string, sessionId?: string, dialog?: { kind: string, title?: string } }} Session
 */
/** @typedef {{ kind: string, id: string, text?: string, thinking?: string, tools?: {id: string, name: string, summary: string}[], error?: string, toolCallId?: string, toolName?: string, ok?: boolean, truncated?: boolean, diff?: string, diffTruncated?: boolean, images?: {index: number, mimeType: string}[] }} Message */
/** @typedef {{ text: string, thinking?: string, tools: {id: string, name: string, summary: string, running: boolean}[] }} LiveSnapshot */
/** @typedef {{ id: string, name: string, createdAt: string, lastUsedAt?: string, current: boolean }} Device `current`: this one */
/** @typedef {{ mimeType: string, data: string, thumb: string }} Attachment base64 `data`, a data URL `thumb` */
/** @typedef {import("./statusbar.js").Report} Report */

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
/** A sent prompt holds the session's actions back until its turn is seen starting, or this long:
 *  one pi does not show verbatim (a command, a template) is never matched in the transcript. */
const PENDING_GRACE_MS = 15_000;
/** A sent prompt the session neither ran nor wrote by then never reached it (pi turns one away while compacting). */
const PROMPT_GIVE_UP_MS = 20_000;
/** An error shows this long, unless a tap or another screen ends it sooner. */
const ERROR_MS = 6000;
const COPIED_MS = 1500;
const SCREEN_POLL_MS = 2000;
/** Less taken off the visible height than this is a toolbar, not the keyboard. */
const KEYBOARD_MIN = 120;
/** The daemon takes at most 4 images, 2 MB each, with a prompt. */
const ATTACH_MAX = 4;
/** A photo is scaled to this on its long side and sent as a JPEG. */
const IMAGE_SIDE_MAX = 1600;
const JPEG_QUALITY = 0.85;
/** A PNG, GIF or WebP this small and no larger than IMAGE_SIDE_MAX goes as it is (a screenshot stays sharp). */
const KEEP_BYTES_MAX = 1024 * 1024;
const KEEP_TYPES = ["image/png", "image/gif", "image/webp"];
const THUMB_SIDE = 160;
/** pi redraws a moment after a key reaches it. */
const SCREEN_SETTLE_MS = 150;
/** Yes or No, once sent, waits this long for the row to leave its dialog before it can be sent again. */
const ANSWERED_MS = 10_000;
/** A pane takes a new name on its next heartbeat; the phone shows it meanwhile, this long at most. */
const RENAME_HOLD_MS = 15_000;
/** pi's entry ids, which a tool result's whole output is asked for by. */
const ENTRY_ID = /^[0-9a-f-]{8,36}$/;
/** The terminal sheet's keys: tmux's name, the button's face, and its spoken name when not tmux's. */
const PRESS = [
	["Up", "↑"],
	["Down", "↓"],
	["Left", "←"],
	["Right", "→"],
	["Enter", "⏎"],
	["Escape", "Esc"],
	["Tab", "Tab"],
	["Space", "␣"],
	["BSpace", "⌫", "Backspace"],
];
const ERRORS = {
	session_not_running: "This session is not running. Open it on the Mac to continue.",
	session_busy: "The session is busy. Try again once it is done.",
	no_status: "This session has not reported its status yet.",
	pane_too_old:
		"This session has not reported yet. Try again in a moment; if this persists, restart it (it may run an older bluclawd).",
	invalid_cwd: "That directory does not exist on the Mac.",
	invalid_model: "That model name is not valid.",
	invalid_thinking: "The model does not offer that thinking level.",
	invalid_trust: "That trust mode is not one of always, ask or never.",
	invalid_entry: "That message is no longer in this session.",
	not_moved: "The session did not move. If its prompt on the Mac has unsent text, clear it and retry.",
	not_delivered: "Not delivered — check the session on the Mac.",
	unreachable: "Could not reach the Mac.",
	invalid_keys: "That can't be typed into the session. Use the keys for Enter, Tab and Esc.",
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
	image_too_large: "That image is too large to send.",
	images_need_running: "Images go only to a running session: send the text to resume it, then attach them.",
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
	terminal_command: "That command drives the Mac's terminal, so the phone does not send it.",
};

const state = {
	/** @type {Session[]} */ sessions: [],
	/** @type {string | undefined} */ open: undefined,
	/** @type {Message[]} */ messages: [],
	/**
	 * Prompts sent and not yet in the transcript. `text`: as the transcript will show it (see
	 * promptKey); `prompt`: as typed, `images`: as sent. `started`: the session was seen working since.
	 * `last`: the transcript's last message when it was sent.
	 * @type {{ id: number, text: string, prompt: string, images: Attachment[], before: number, sentAt: number, started?: boolean, last: string }[]}
	 */
	pending: [],
	/** Images for the open session's next prompt. @type {Attachment[]} */
	attachments: [],
	/** The open session's reply in progress, streamed by its pane. @type {LiveSnapshot | undefined} */ live: undefined,
	/** @type {string[]} */ directories: [],
	/** What a new session can start with. @type {import("./statusbar.js").ReportModel[]} */ models: [],
	/** What the session list is searched for. */
	query: "",
	/**
	 * A pane started from here, until its row is listed (`pane` is unset while the request is out).
	 * `from`: the stored session it resumes, whose row is gone meanwhile.
	 * @type {{ pane?: string, from?: string } | undefined}
	 */
	starting: undefined,
	loaded: false,
	messagesLoaded: false,
	/** Older messages are left before the first one shown. */
	more: false,
	/** Older messages are on their way. */
	loadingOlder: false,
	online: true,
	/** Show "Enable notifications". */
	offerPush: false,
	/** The open session's status sheet. */
	sheetOpen: false,
	/** Its pane's report: undefined while loading, null when it has sent none. @type {Report | null | undefined} */
	report: undefined,
	/** Compact was asked for and the pane has not reported since: Send waits, closing the sheet or not. */
	compacting: false,
	/** /model was typed: its picker gets the focus once the sheet shows it. */
	focusModel: false,
	/** Stop was asked for and the session is still mid-turn. */
	stopping: false,
	/** Tree, fork or clone was asked for and the open chat's transcript has not changed since. */
	navigating: false,
	/**
	 * The message whose actions the sheet shows instead of the status. `back`: a reply the session
	 * can go back to.
	 * @type {{ id: string, text: string, kind: string, back: boolean } | undefined}
	 */
	menu: undefined,
	/** Its text was just copied. */
	copied: false,
	/** The terminal sheet: the pane's screen, and keys to answer its dialog with. */
	terminal: false,
	/** Paired in Safari: the Home Screen app is the one iOS notifies. */
	homeScreenHint: false,
	/** The paired phones screen is open (`#phones`). */
	phones: false,
	/** The paired phones: undefined while loading. @type {Device[] | undefined} */
	devices: undefined,
	/** The phone whose Remove asks to be confirmed. @type {string | undefined} */
	confirming: undefined,
	/** What the pane shows: undefined while loading. @type {string[] | undefined} */
	screen: undefined,
	/** Keys or text are on their way to the pane. */
	typing: false,
	/** Yes or No went to the open session's confirm dialog at this time (see ANSWERED_MS). @type {number | undefined} */
	answered: undefined,
	/** The open session's new name is on its way. */
	saving: false,
	/** Its Delete asks to be confirmed. */
	confirmDelete: false,
	/** The terminal sheet's own error code, so the banner keeps its Answer button. @type {string | undefined} */
	termError: undefined,
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
/** @type {ReturnType<typeof setTimeout> | undefined} */
let errorTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let copiedTimer;
/** The transcript a tree, fork or clone left, to tell on a reconnect whether it has moved. */
let navigatedFrom = "";
/** Which view the DOM holds: "pair", "list", "phones" or "chat:<id>". */
let shown = "";
/** The next log update prepends older messages: it keeps what is on screen in place. */
let prepending = false;
/** @type {IntersectionObserver | undefined} */
let olderObserver;
/** Fetches a message's image as it nears the screen. @type {IntersectionObserver | undefined} */
let pictureObserver;
/**
 * The open session's images fetched so far, as data URLs (the CSP allows no blob: URL), by
 * pictureKey; the oldest go past PICTURES_MAX, and are fetched again if shown again.
 * @type {Map<string, string>}
 */
const pictures = new Map();
const PICTURES_MAX = 30;
/** @type {Set<string>} */
const picturesLoading = new Set();
/** Not fetched again until the session is opened again. @type {Set<string>} */
const picturesFailed = new Set();
/** Keeps the log where it was as images change size (see bindChat). @type {ResizeObserver | undefined} */
let pictureSizes;
/** The log was scrolled to its end before its last change of size. */
let stuck = true;
let pendingId = 0;
/**
 * The pane a resumed session's chat moved to: the replies still pending move with it.
 * @type {string | undefined}
 */
let followed;
/** The open chat was opened from the list, whose history entry "‹ Sessions" goes back to. */
let backToList = false;
/** The open chat's pi session, as last listed: its row may go, and the chat follows it to its next one. @type {string | undefined} */
let openSessionId;
/** The last notice a pane's report carried (its `at`): each shows once. @type {number | undefined} */
let noticeAt;
/** A name just given, shown until the list has it (see holdRename). @type {{ id: string, name: string, until: number } | undefined} */
let renamed;
/**
 * The open session's tool results asked for in full, by entry id: the text, or why it is not there.
 * @type {Map<string, { text?: string, truncated?: boolean, error?: string, loading?: boolean }>}
 */
const outputs = new Map();
/** The count on the app's badge; none set yet. */
let badged = -1;
/**
 * A message for the list, shown by its next refresh (which would otherwise clear it).
 * @type {string | undefined}
 */
let notice;
/**
 * The open session's turn ended, as of a list asked for at this time: the next transcript fetch
 * drops the prompts sent before then that it still lacks, which pi did not write as sent.
 * @type {number | undefined}
 */
let turnEndedAt;

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
		// The terminal sheet closes: no polling meanwhile, and it does not pop up again once paired anew.
		state.terminal = false;
		pollScreen();
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
		const was = state.sessions.find((s) => s.id === state.open)?.state;
		state.sessions = await api.sessions();
		holdRename();
		const now = state.sessions.find((s) => s.id === state.open)?.state;
		if (now === "working") {
			for (const p of state.pending) if (p.sentAt < asked) p.started = true;
		} else if (was === "working" && now !== undefined && now !== "needs") {
			turnEndedAt = asked;
			void loadMessages();
		}
		state.loaded = true;
		badge(state.sessions.filter((s) => s.state === "needs").length);
		if (notice) showError(notice);
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
			// A task started from the list opens, unless another screen was opened meanwhile.
			if (!starting.from && !state.open && !state.phones) {
				location.hash = `#s/${encodeURIComponent(starting.pane)}`;
				return;
			}
		}
		// The open session under another row id (it quit on the Mac, or resumed there): followed as a
		// resume from here is, unless that resume is the one under way.
		const open = state.sessions.find((s) => s.id === state.open);
		if (open) openSessionId = open.sessionId;
		else if (state.open && state.starting?.from !== state.open) {
			const next = successor(state.sessions, state.open, openSessionId);
			if (next) {
				followed = next;
				location.replace(`#s/${encodeURIComponent(next)}`);
				return;
			}
		}
		render();
		if (!state.open) {
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

/** @param {string} pane @param {string} [from] */
function waitForPane(pane, from) {
	const starting = { pane, from };
	state.starting = starting;
	clearTimeout(startTimer);
	startTimer = setTimeout(() => {
		if (state.starting !== starting) return;
		state.starting = undefined;
		// What was sent reached no session.
		state.pending = [];
		if (from !== undefined && state.open === from) {
			// Back to the list, where the message outlives the reconnect.
			notice = errorText("start_timeout");
			location.hash = "";
			route();
			return;
		}
		showError(errorText("start_timeout"));
	}, START_TIMEOUT_MS);
	void loadSessions();
}

async function loadMessages() {
	const id = state.open;
	if (!id || state.starting?.from === id) return;
	const request = ++messagesRequest;
	try {
		const page = await api.messages(id);
		if (state.open !== id || request !== messagesRequest) return;
		/** @type {Message[]} */
		const latest = page.messages;
		// Older messages loaded above stay while the latest page follows on from them (it starts
		// among them); after a tree, fork or clone it does not, and replaces them.
		const at = latest.length ? state.messages.findIndex((m) => m.id === latest[0].id) : -1;
		if (at > 0) state.messages = [...state.messages.slice(0, at), ...latest];
		else {
			// A pending reply's count no longer includes the copies of its text that went with them.
			const kept = new Set(latest.map((m) => m.id));
			const gone = state.messages.filter((m) => !kept.has(m.id));
			for (const p of state.pending) p.before -= userCount(gone, p.text);
			state.messages = latest;
			state.more = page.more;
		}
		state.messagesLoaded = true;
		state.live = settle(state.live, liveEnded, latest);
		// A sent prompt is pending until the transcript has one more copy of its text than when it was sent.
		state.pending = state.pending.filter((p) => userCount(state.messages, p.text) <= p.before);
		const ended = turnEndedAt;
		turnEndedAt = undefined;
		if (ended !== undefined) state.pending = state.pending.filter((p) => p.sentAt >= ended);
		render();
	} catch (error) {
		loadError(error);
	}
}

/** The page before the first message shown, put above it; again while the top stays in view. */
async function loadOlder() {
	const id = state.open;
	const first = state.messages[0];
	// An old session file's messages have no ids to page by.
	if (!id || !first?.id || !state.more || state.loadingOlder) return;
	state.loadingOlder = true;
	render();
	let failed = false;
	try {
		const page = await api.messages(id, first.id);
		// Not after a refresh that replaced the log meanwhile: this page would be another branch's.
		if (state.open === id && state.messages[0]?.id === first.id) {
			/** @type {Message[]} */
			const older = page.messages;
			for (const p of state.pending) p.before += userCount(older, p.text);
			state.messages = [...older, ...state.messages];
			state.more = page.more;
			prepending = true;
		}
	} catch (error) {
		failed = true;
		loadError(error);
	}
	if (state.open !== id) return;
	state.loadingOlder = false;
	render();
	// The observer only reports a change: a short or dropped page can leave the top in view, and so
	// can a failed one, tried again a little later so that it does not repeat as fast as it fails.
	if (!failed) {
		if ($("#scroll").scrollTop < OLDER_MARGIN) void loadOlder();
	} else {
		setTimeout(() => {
			if (state.open === id && $("#scroll")?.scrollTop < OLDER_MARGIN) void loadOlder();
		}, OLDER_RETRY_MS);
	}
}

/** For the status bar too, so whenever a chat is open. */
async function loadStatus() {
	const id = state.open;
	if (!id) return;
	const request = ++statusRequest;
	/** @type {Report | null} */
	let report;
	try {
		report = await api.status(id);
	} catch (error) {
		if (!(error instanceof Error && error.message === "no_status")) {
			loadError(error);
			return;
		}
		report = null;
	}
	if (state.open !== id || request !== statusRequest) return;
	state.report = report;
	// The pane skipped a fork, clone or edit sent from here: it will not move, so nothing waits on it.
	const skipped = report?.notice;
	if (skipped && skipped.at !== noticeAt) {
		noticeAt = skipped.at;
		endNavigating();
		showError(skipped.text);
		return;
	}
	render();
}

async function loadScreen() {
	const id = state.open;
	if (!id || !state.terminal || state.termError === "unknown_session") return;
	const request = ++screenRequest;
	try {
		const lines = await api.screen(id);
		if (state.open !== id || !state.terminal || request !== screenRequest) return;
		state.screen = lines;
		render();
	} catch (error) {
		// A stale reply must not stop a newer sheet's polling.
		if (error instanceof Unauthorized || request === screenRequest) terminalError(error);
	}
}

/** In the sheet, not the banner. @param {unknown} error */
function terminalError(error) {
	if (error instanceof Unauthorized) {
		handleError(error);
		return;
	}
	const message = error instanceof Error ? error.message : String(error);
	if (!(error instanceof TypeError) && !/^HTTP 5\d\d$/.test(message)) state.termError = message;
	// A gone pane stays gone: its last screen and the message stay, the polling stops.
	if (message === "unknown_session") pollScreen();
	render();
}

/** While the terminal sheet is open and the app is on screen. */
function pollScreen() {
	clearInterval(screenTimer);
	screenTimer = undefined;
	if (state.terminal && state.termError !== "unknown_session" && document.visibilityState === "visible") {
		screenTimer = setInterval(() => void loadScreen(), SCREEN_POLL_MS);
	}
}

/** @param {Message[]} messages @param {string} text */
function userCount(messages, text) {
	// Trimmed: a prompt starting with @ reaches pi with a space before it.
	return messages.filter((m) => m.kind === "user" && sentText(m.text ?? "") === text).length;
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
	return `<form class="pair" id="pair">
<div class="logo">✻</div><h1>bluclawd</h1>
<p class="muted">On the Mac, run <code>/remote-control</code> and scan the QR code with your phone's camera. Can't scan? Type the 6-digit code shown under it.</p>
<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000000" aria-label="Pairing code">
<button>Pair</button><div class="error" id="pair-error"></div></form>`;
}

function listShell() {
	return `<header class="bar"><h1>Sessions</h1><button class="notify" id="notify" hidden>Enable notifications</button>
<span class="muted" id="online"></span><a class="phones" href="#phones" aria-label="Paired phones">⋯</a></header>
<div id="banner"></div><div class="search"><input type="search" id="search" placeholder="Search" aria-label="Search sessions" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search"></div>
<section class="scroll" id="rows"></section>
<form class="composer new" id="new-task"><textarea id="task" rows="1" placeholder="New task…" aria-label="New task" maxlength="32768"></textarea>
<select class="pick" id="new-model" aria-label="Model" hidden></select>
<div class="where"><select id="cwd" aria-label="Directory"></select>
<input id="cwd-other" placeholder="/path/to/project" aria-label="Directory path" autocapitalize="off" autocomplete="off" spellcheck="false" hidden>
<button class="start" id="start">Start</button></div></form>`;
}

/** @param {Session} s */
function rowHtml(s) {
	const glyph = s.state === "needs" ? "✻" : s.state === "working" ? "" : "∙";
	return `<a class="row" href="#s/${encodeURIComponent(s.id)}"><span class="glyph ${esc(s.state)}" aria-hidden="true">${glyph}</span>
<span class="name">${esc(s.label)}<small>${esc(s.detail || s.state)}</small></span>
<span class="age">${age(ageAt(s))}</span></a>`;
}

function rowsHtml() {
	if (!state.loaded) return `<p class="empty">Loading…</p>`;
	if (state.sessions.length === 0) return `<p class="empty">No sessions. Start one below.</p>`;
	const found = filterSessions(state.sessions, state.query);
	if (found.length === 0) return `<p class="empty">No sessions match “${esc(state.query.trim())}”.</p>`;
	return BANDS.map(([key, title]) => {
		const rows = found.filter((s) => s.band === key);
		return rows.length ? `<h2 class="band">${title}</h2>${rows.map(rowHtml).join("")}` : "";
	}).join("");
}

function chatShell() {
	return `<header class="bar"><a class="back" href="#">‹ Sessions</a><button class="title" id="title" aria-haspopup="dialog"></button>
<button class="stop" id="stop" hidden>Stop</button></header>
<button class="statusbar" id="statusbar" aria-haspopup="dialog" aria-label="Status" hidden></button>
<div id="banner"></div><section class="scroll" id="scroll"><div class="older" id="older"></div><div class="log" id="log">
<div class="part" id="msgs"></div><div class="part" id="live"></div><div class="part" id="pending"></div><div class="part" id="working"></div></div></section>
<div class="thumbs" id="thumbs" hidden></div>
<form class="composer" id="composer"><button type="button" class="attach" id="attach" aria-label="Attach image"><span aria-hidden="true">+</span></button>
<input type="file" id="file" accept="image/*" multiple hidden>
<textarea id="text" rows="1" placeholder="Reply" aria-label="Reply" maxlength="32768"></textarea>
<button class="send" aria-label="Send"><span aria-hidden="true">↑</span></button></form>
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

/** @param {string} name @param {string} summary @param {Message | undefined} result @param {string} key @param {boolean} [running] */
function toolHtml(name, summary, result, key, running = false) {
	const title = `${esc(name.charAt(0).toUpperCase() + name.slice(1))}(${esc(summary)})`;
	if (!result) return `<div class="t${running ? " running" : ""}">${title}</div>`;
	const head = `<details class="t${result.ok ? "" : " err"}" data-key="${esc(key)}"><summary>${title}<br>⎿ `;
	// An edit shows what it changed, rather than that it did.
	if (result.diff) {
		const { added, removed } = diffCounts(result.diff);
		return `${head}<span class="plus">+${added}</span> <span class="minus">−${removed}</span></summary>
${diffHtml(result.diff, result.diffTruncated)}</details>${picturesHtml(result)}`;
	}
	const full = outputs.get(result.id);
	const text = shownText(full?.text ?? result.text ?? "", result.images);
	const cut = full?.text !== undefined ? full.truncated : result.truncated;
	const first = text.split("\n").find((line) => line.trim()) ?? (result.ok ? "done" : "error");
	// Its images show without opening it.
	return `${head}${esc(first)}</summary>
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
	const calls = new Set(state.messages.flatMap((m) => (m.tools ?? []).map((t) => t.id)));
	const running = new Set((state.live?.tools ?? []).filter((t) => t.running).map((t) => t.id));
	const live = state.live ? liveHtml(state.live, calls) : "";
	const pending = pendingHtml();
	// The reply in progress replaces the working line once it shows something.
	const streaming = live !== "" || running.size > 0;
	const working =
		session?.state === "working" && !streaming
			? `<div class="working">✻ ${esc(session.detail || "Working…")}</div>`
			: "";
	let msgs = transcriptHtml(calls, running);
	if (!msgs && !live && !pending && !working) {
		msgs = `<p class="empty">${state.messagesLoaded ? "Nothing in this session yet." : "Loading…"}</p>`;
	}
	return { msgs, live, pending, working };
}

/** @param {Set<string>} calls the transcript's tool calls @param {Set<string>} running those the reply in progress runs */
function transcriptHtml(calls, running) {
	/** @type {Map<string, Message>} */
	const results = new Map();
	for (const m of state.messages) if (m.kind === "toolResult" && m.toolCallId) results.set(m.toolCallId, m);
	const parts = [];
	/** @param {Message} m */
	const more = (m) =>
		`<button class="more" data-id="${esc(m.id)}" aria-label="${snippet(m.text) ? `Actions for “${esc(snippet(m.text))}”` : "Actions for this message"}" aria-haspopup="dialog">⋯</button>`;
	for (const m of state.messages) {
		if (m.kind === "user") {
			parts.push(
				`<div class="mine${m.images?.length ? " pics" : ""}">${more(m)}<div class="u">${picturesHtml(m)}${esc(shownText(m.text ?? "", m.images))}</div></div>`,
			);
		} else if (m.kind === "assistant") {
			if (m.thinking) {
				parts.push(
					`<details class="think" data-key="think:${esc(m.id)}"><summary>Thinking</summary><pre>${esc(m.thinking)}</pre></details>`,
				);
			}
			if (m.text) parts.push(`<div class="theirs"><div class="a">${md(m.text)}</div>${more(m)}</div>`);
			for (const [index, tool] of (m.tools ?? []).entries()) {
				const key = tool.id || `${m.id}:${index}`;
				parts.push(toolHtml(tool.name, tool.summary, results.get(tool.id), key, running.has(tool.id)));
			}
			if (m.error) parts.push(`<div class="t err">${esc(m.error)}</div>`);
		} else if (m.kind === "toolResult" && !(m.toolCallId && calls.has(m.toolCallId))) {
			parts.push(toolHtml(m.toolName ?? "tool", "", m, m.id));
		} else if (m.kind === "marker") parts.push(`<div class="marker">${esc(m.text)}</div>`);
	}
	return parts.join("");
}

/** Each sent prompt's images show large, from what was sent (see paintPending). */
function pendingHtml() {
	return state.pending
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
	if (live.thinking) {
		parts.push(
			`<details class="think" data-key="think:live"><summary>Thinking</summary><pre>${esc(live.thinking)}</pre></details>`,
		);
	}
	if (live.text) parts.push(`<div class="a">${markdown(live.text)}</div>`);
	for (const tool of live.tools) {
		if (!calls.has(tool.id)) parts.push(toolHtml(tool.name, tool.summary, undefined, tool.id, tool.running));
	}
	return parts.join("");
}

/** @param {Session | undefined} session */
function bannerHtml(session) {
	if (!state.online) {
		return `<div class="banner off">Mac unreachable — it may be asleep, offline, or remote control is off. Retrying…</div>`;
	}
	const error = state.error ? `<div class="banner off">${esc(state.error)}</div>` : "";
	// An error does not hide the way to answer.
	if (session?.state === "needs") {
		const title = session.dialog?.title;
		const text = title
			? `Waiting: ${esc(title)}`
			: "This session is waiting for an answer to a dialog. A reply sent here becomes its next prompt.";
		// Answer stays beside Yes and No: the screen shows what is being confirmed.
		const confirm = isConfirm(session);
		return `${error}<div class="banner needs${confirm ? " confirm" : ""}"><span>${text}</span>${confirm ? replyHtml() : ""}
<button class="answer" id="answer" aria-haspopup="dialog">Answer</button></div>`;
	}
	if (error) return error;
	if (!session && state.homeScreenHint) {
		return `<div class="banner hint"><span>Now Share → Add to Home Screen. The app opens already paired.</span>
<button class="dismiss" id="dismiss-hint" aria-label="Dismiss">×</button></div>`;
	}
	return "";
}

/** @param {Session | undefined} session */
function isConfirm(session) {
	return session?.state === "needs" && session.dialog?.kind === "confirm";
}

/** A confirm dialog's answers, held back while one is on its way or just went (see replyConfirm). */
function replyHtml() {
	const disabled = state.typing || state.answered !== undefined ? " disabled" : "";
	return `<button class="reply" data-reply="yes"${disabled}>Yes</button><button class="reply" data-reply="no"${disabled}>No</button>`;
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
${thinkingHtml(report)}
<dt>Context</dt><dd>${contextHtml(report.context)}</dd>
<dt>Tokens</dt><dd>${usage ? `↑ ${esc(tokens(usage.input))} in · ↓ ${esc(tokens(usage.output))} out${usage.cacheRead ? ` · R ${esc(tokens(usage.cacheRead))}` : ""}${usage.cacheWrite ? ` · W ${esc(tokens(usage.cacheWrite))}` : ""}` : "Unknown"}</dd>
<dt>Cost</dt><dd>${usage ? `$${esc(usage.cost.toFixed(3))}` : "Unknown"}</dd>
${factsHtml(report, session && shortPath(session.cwd), Date.now())}
</dl><button class="compact" id="compact"${busy ? " disabled" : ""}>${state.compacting ? "Compacting…" : "Compact"}</button>
<button class="compact clone" id="clone"${busy ? " disabled" : ""}>Clone session</button>`;
}

/** Built once each time the sheet opens, so what is typed stays while the rest refreshes. @param {Session | undefined} session */
function renameHtml(session) {
	return `<form class="rename" id="rename-form"><label for="rename">Name</label>
<input id="rename" value="${esc(session?.label ?? "")}" maxlength="100" autocomplete="off" enterkeyhint="done">
<button class="save" id="rename-save">Save</button></form>`;
}

/** Pin, and for a stored session (none runs it) Delete, which asks first. @param {Session | undefined} session */
function manageHtml(session) {
	if (!session) return "";
	const pinned = session.band === "pinned";
	const pin = `<button class="action" id="pin">${pinned ? "Unpin" : "Pin"}<small>${pinned ? "Back in its band in the list." : "At the top of the list."}</small></button>`;
	if (session.alive) return `<div class="actions">${pin}</div>`;
	const remove = state.confirmDelete
		? `<div class="confirm-delete"><span>Delete it from the list? Its session file stays on the Mac.</span>
<button class="unpair cancel" id="delete-cancel">Cancel</button><button class="unpair" id="delete-confirm">Delete</button></div>`
		: `<button class="action danger" id="delete">Delete<small>Off the list; its session file stays on the Mac.</small></button>`;
	return `<div class="actions">${pin}${remove}</div>`;
}

/**
 * Waiting on an answer is mid-turn too, and compacting, going back or forking would cut the turn
 * short; a second one before the first has moved the session would race it. So would one right
 * behind a sent prompt, whose turn may not have started yet (see PENDING_GRACE_MS).
 * @param {Session | undefined} session
 */
function isBusy(session) {
	return (
		session?.state === "working" ||
		session?.state === "needs" ||
		state.compacting ||
		state.navigating ||
		state.pending.some((p) => !p.started && Date.now() - p.sentAt < PENDING_GRACE_MS) ||
		!session?.alive
	);
}

/** A message's first line, short enough for a button's label. @param {string | undefined} text */
function snippet(text) {
	const line = (text ?? "").trim().split("\n")[0];
	return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

/** @param {Session | undefined} session @param {NonNullable<typeof state.menu>} menu */
function menuHtml(session, menu) {
	// A step between tool calls, or where the session already is, is not a reply to go back to.
	const moves = menu.kind === "user" || menu.back;
	const busy = moves && isBusy(session);
	const why = !session?.alive
		? errorText("session_not_running")
		: state.navigating
			? "Available once the session has moved."
			: "Available once the session is idle.";
	const disabled = busy ? " disabled" : "";
	const copy = `<button class="action" id="copy">${state.copied ? "Copied" : "Copy"}<small>${menu.kind === "user" ? "This message's text." : "This reply's text, as markdown."}</small></button>`;
	const actions =
		menu.kind === "user"
			? `<button class="action" id="edit-new"${disabled}>Edit in a new session<small>A new session without this message and everything after it, with its text in the reply box.</small></button>
<button class="action" id="edit-here"${disabled}>Edit here<small>This message and everything after it leave this session's branch, and its text goes in the reply box.</small></button>`
			: menu.back
				? `<button class="action" id="back-here"${disabled}>Go back to here<small>Everything after this reply leaves this session's branch.</small></button>`
				: "";
	return `<header class="sheet-bar"><h2>${menu.kind === "user" ? "Your message" : "Reply"}</h2><button class="close" id="sheet-close">Done</button></header>
<p class="quote">${esc(menu.text)}</p>${busy ? `<p class="muted">${esc(why)}</p>` : ""}
<div class="actions">${copy}${actions}</div>`;
}

/**
 * The open message's text to the clipboard: the Clipboard API within the tap (Safari allows it
 * only there), else a selected text field and the copy command.
 */
function copyMessage() {
	const menu = state.menu;
	if (!menu) return;
	const text = menu.kind === "user" ? promptText(menu.text) : menu.text;
	const done = () => {
		state.copied = true;
		clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => {
			state.copied = false;
			render();
		}, COPIED_MS);
		render();
	};
	const fallback = () => {
		const field = document.createElement("textarea");
		field.value = text;
		field.readOnly = true;
		field.className = "clip";
		document.body.append(field);
		field.select();
		field.setSelectionRange(0, text.length);
		const copied = document.execCommand("copy");
		field.remove();
		if (copied) done();
		else showError("This browser did not allow copying.");
	};
	if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, fallback);
	else fallback();
}

function terminalHtml() {
	const keys = PRESS.map(
		([key, face, label = key]) => `<button class="press" data-press="${key}" aria-label="${label}">${face}</button>`,
	).join("");
	return `<header class="sheet-bar"><h2>Answer</h2><button class="close" id="sheet-close">Done</button></header>
<p class="error" id="term-error" hidden></p><pre class="screen" id="screen" tabindex="0" aria-label="The session's screen"></pre>
<div class="confirm-keys" id="confirm-keys" role="group" aria-label="Answer the confirmation" hidden><button class="press" data-reply="yes">Yes</button><button class="press" data-reply="no">No</button></div>
<div class="keys" role="group" aria-label="Keys">${keys}</div>
<form class="term-text" id="term-form"><input id="term-input" aria-label="Text to type" placeholder="Text to type" maxlength="1024" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="send">
<button class="term-send" id="term-send">Send</button></form>`;
}

// ---- render ----

function render() {
	const view = !getToken() ? "pair" : state.open ? `chat:${state.open}` : state.phones ? "phones" : "list";
	if (view !== shown) {
		shown = view;
		app.innerHTML =
			view === "pair" ? pairView() : view === "list" ? listShell() : view === "phones" ? phonesShell() : chatShell();
		if (view === "pair") bindPair();
		else if (view === "list") bindList();
		else if (view === "phones") bindPhones();
		else bindChat();
	}
	if (view === "list") updateList();
	else if (view === "phones") updatePhones();
	else if (view !== "pair") updateChat();
}

function updateList() {
	$("#online").textContent = state.online ? "● online" : "offline";
	$("#online").classList.toggle("on", state.online);
	$("#notify").hidden = !state.offerPush;
	const banner = $("#banner");
	const bannerNow = bannerHtml(undefined);
	// Rebuilt only when it changes, so a tap on its dismiss button is not lost to a refresh.
	if (banner.dataset.html !== bannerNow) {
		banner.innerHTML = bannerNow;
		banner.dataset.html = bannerNow;
	}
	$("#rows").innerHTML = rowsHtml();
	updateDirectories();
	updateModels();
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

/** The running panes' models by provider, after "Default" (pi's own choice); none offered, no picker. */
function updateModels() {
	const select = $("#new-model");
	let html = `<option value="">Default</option>`;
	state.models.forEach((model, index) => {
		if (model.provider !== state.models[index - 1]?.provider) {
			html += `${index ? "</optgroup>" : ""}<optgroup label="${esc(model.provider)}">`;
		}
		html += `<option value="${esc(`${model.provider}/${model.id}`)}">${esc(model.name ?? model.id)}</option>`;
	});
	if (state.models.length) html += "</optgroup>";
	if (select.dataset.html !== html) {
		const chosen = select.value;
		select.innerHTML = html;
		select.dataset.html = html;
		if ([...select.options].some((o) => o.value === chosen)) select.value = chosen;
	}
	select.hidden = state.models.length === 0;
}

function updateChat() {
	const session = state.sessions.find((s) => s.id === state.open);
	const resuming = state.starting?.from !== undefined && state.starting.from === state.open;
	// Kept while a resumed session's row gives way to its pane's.
	if (!resuming) $("#title").textContent = session?.label ?? "";
	// Mid-turn, a dialog waiting on an answer included.
	const turn = session?.state === "working" || session?.state === "needs";
	if (!turn) state.stopping = false;
	if (session?.state !== "needs") state.answered = undefined;
	const stop = $("#stop");
	stop.hidden = !turn;
	stop.disabled = state.stopping;
	stop.textContent = state.stopping ? "Stopping…" : "Stop";
	const bar = $("#statusbar");
	const barNow = barHtml(state.report, session && shortPath(session.cwd), Date.now());
	if (bar.dataset.html !== barNow) {
		bar.innerHTML = barNow;
		bar.dataset.html = barNow;
		bar.hidden = barNow === "";
	}
	const banner = $("#banner");
	const bannerNow = bannerHtml(session);
	// Rebuilt only when it changes, so a tap on Answer is not lost to a refresh.
	if (banner.dataset.html !== bannerNow) {
		banner.innerHTML = bannerNow;
		banner.dataset.html = bannerNow;
	}
	const scroll = $("#scroll");
	const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
	const height = scroll.scrollHeight;
	// Its height stays the same while loading, so only what is put above moves the log.
	const older = $("#older");
	older.hidden = !state.more;
	older.textContent = state.loadingOlder ? "Loading…" : "";
	const parts = logParts(session);
	const msgs = updatePart($("#msgs"), parts.msgs);
	if (msgs) showPictures($("#msgs"));
	const pending = updatePart($("#pending"), parts.pending);
	if (pending) paintPending();
	const live = updatePart($("#live"), parts.live);
	const working = updatePart($("#working"), parts.working);
	if ((msgs || pending || live || working) && atBottom && !prepending) scroll.scrollTop = scroll.scrollHeight;
	// Also when the page loaded was empty and only "#older" went.
	if (prepending) scroll.scrollTop += scroll.scrollHeight - height;
	prepending = false;
	const stranded = session !== undefined && !session.alive && !session.resumable;
	// One pane starts at a time, so a resume waits for any start in flight.
	const blocked = resuming || stranded || (state.starting !== undefined && session?.resumable === true);
	updateSheet(session);
	const text = $("#text");
	text.disabled = blocked || state.compacting;
	$(".send").disabled = blocked || state.navigating || state.compacting;
	// A resumed session's first prompt is an argument to pi, which carries no images.
	$("#attach").disabled = blocked || session?.resumable === true || state.attachments.length >= ATTACH_MAX;
	text.placeholder = resuming
		? "Starting…"
		: state.compacting
			? "Compacting…"
			: stranded
				? "Not running: open it on the Mac"
				: session?.resumable
					? "Reply resumes it (text only)"
					: "Reply";
	updateThumbs();
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
	const html = state.attachments
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
	const open = state.sheetOpen || state.menu !== undefined || state.terminal;
	sheet.hidden = !open;
	$("#backdrop").hidden = !open;
	if (!open) return;
	sheet.setAttribute(
		"aria-label",
		state.terminal ? "Answer the dialog" : state.menu ? "Message actions" : "Session status",
	);
	if (state.terminal) {
		updateTerminal(sheet, session);
		return;
	}
	if (state.menu) {
		const html = menuHtml(session, state.menu);
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
	updatePart($("#sheet-status"), sheetHtml(session));
	updatePart($("#sheet-manage"), manageHtml(session));
	$("#rename-save").disabled = state.saving;
	// Asked for by /model: there once the report is in.
	const model = $("#model");
	if (state.focusModel && model) {
		state.focusModel = false;
		model.focus();
	}
}

/**
 * Built once, so the text field keeps its text and keyboard; then only the screen changes, and
 * whether it offers Yes and No.
 * @param {HTMLElement} sheet @param {Session | undefined} session
 */
function updateTerminal(sheet, session) {
	if (sheet.dataset.html !== "terminal") {
		sheet.innerHTML = terminalHtml();
		sheet.dataset.html = "terminal";
	}
	const error = $("#term-error");
	error.textContent = state.termError ? errorText(state.termError) : "";
	error.hidden = !state.termError;
	$("#confirm-keys").hidden = !isConfirm(session);
	const buttons = /** @type {NodeListOf<HTMLButtonElement>} */ (sheet.querySelectorAll(".press, #term-send"));
	for (const button of buttons)
		button.disabled = state.typing || (button.dataset.reply !== undefined && state.answered !== undefined);
	const screen = $("#screen");
	const text = state.screen ? state.screen.join("\n") : "Loading…";
	if (screen.textContent === text) return;
	const atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 40;
	screen.textContent = text;
	if (atBottom) screen.scrollTop = screen.scrollHeight;
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

function bindList() {
	const task = $("#task");
	task.addEventListener("input", () => grow(task));
	// Outside the rows, which every update replaces, so it keeps its focus and keyboard.
	const search = $("#search");
	search.value = state.query;
	search.addEventListener("input", () => {
		state.query = search.value;
		updateList();
	});
	$("#notify").addEventListener("click", () => void enablePush());
	$("#banner").addEventListener("click", (/** @type {Event} */ event) => {
		if (!(/** @type {Element} */ (event.target).closest("#dismiss-hint"))) return;
		state.homeScreenHint = false;
		updateList();
	});
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
		showError("Type the directory to start it in.");
		return;
	}
	state.starting = {};
	render();
	try {
		const { pane } = await api.start(cwd, value, $("#new-model").value || undefined);
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
	text.addEventListener("input", () => grow(text));
	$("#composer").addEventListener("submit", (/** @type {Event} */ event) => {
		event.preventDefault();
		void send();
	});
	const file = $("#file");
	$("#attach").addEventListener("click", () => file.click());
	file.addEventListener("change", () => {
		const files = [...file.files];
		file.value = "";
		void attach(files);
	});
	$("#thumbs").addEventListener("click", (/** @type {Event} */ event) => {
		const remove = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest(".remove"));
		if (!remove) return;
		state.attachments.splice(Number(remove.dataset.index), 1);
		render();
	});
	$("#stop").addEventListener("click", async () => {
		const id = state.open;
		if (!id || state.stopping) return;
		state.stopping = true;
		render();
		try {
			await api.abort(id);
		} catch (error) {
			state.stopping = false;
			handleError(error);
		}
	});
	// Back to the list's own entry, rather than a new one after this chat's.
	$(".back").addEventListener("click", (/** @type {Event} */ event) => {
		if (!backToList) return;
		event.preventDefault();
		history.back();
	});
	$("#title").addEventListener("click", openSheet);
	$("#statusbar").addEventListener("click", openSheet);
	$("#banner").addEventListener("click", (/** @type {Event} */ event) => {
		const target = /** @type {Element} */ (event.target);
		const reply = /** @type {HTMLElement | null} */ (target.closest("[data-reply]"));
		if (reply) void replyConfirm(reply.dataset.reply === "yes");
		else if (target.closest("#answer")) openTerminal();
	});
	$("#backdrop").addEventListener("click", closeSheet);
	const sheet = $("#sheet");
	sheet.addEventListener("click", (/** @type {Event} */ event) => {
		const target = /** @type {Element} */ (event.target);
		const reply = /** @type {HTMLElement | null} */ (target.closest("[data-reply]"));
		if (target.closest("#sheet-close")) closeSheet();
		else if (target.closest("#copy")) copyMessage();
		else if (target.closest("#compact")) void compact();
		else if (target.closest("#clone")) void move((id) => api.clone(id));
		else if (target.closest("#edit-new")) edit("fork");
		else if (target.closest("#edit-here")) edit("tree");
		else if (target.closest("#back-here")) goBack();
		else if (target.closest("#pin")) void togglePin();
		else if (target.closest("#delete, #delete-cancel")) {
			state.confirmDelete = target.closest("#delete") !== null;
			render();
		} else if (target.closest("#delete-confirm")) void deleteSession();
		else if (reply) void replyConfirm(reply.dataset.reply === "yes");
		else if (target.closest(".press")) {
			const key = /** @type {HTMLElement} */ (target.closest(".press")).dataset.press;
			if (key) void answer({ keys: [key] });
		}
	});
	// The text field keeps focus, and iOS its keyboard, while a key is pressed; the click still comes.
	sheet.addEventListener("pointerdown", (/** @type {Event} */ event) => {
		if (/** @type {Element} */ (event.target).closest(".press")) event.preventDefault();
	});
	sheet.addEventListener("submit", (/** @type {Event} */ event) => {
		event.preventDefault();
		if (/** @type {Element} */ (event.target).id === "rename-form") {
			void rename();
			return;
		}
		const text = $("#term-input")?.value;
		if (text) void answer({ text });
	});
	$("#log").addEventListener("click", (/** @type {Event} */ event) => {
		const full = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest(".full"));
		if (full?.dataset.entry) {
			void loadOutput(full.dataset.entry);
			return;
		}
		const pic = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest(".pic"));
		if (pic) {
			const url = pic.dataset.pending
				? pendingPicture(pic)
				: pictures.get(pictureKey(pic.dataset.entry ?? "", pic.dataset.index ?? ""));
			if (url) openViewer(url);
			return;
		}
		const more = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest(".more"));
		const message = state.messages.find(
			(m) => (m.kind === "user" || m.kind === "assistant") && m.id === more?.dataset.id,
		);
		if (!message) return;
		const back = message.kind === "assistant" && !message.tools?.length && message !== state.messages.at(-1);
		state.menu = { id: message.id, text: message.text ?? "", kind: message.kind, back };
		state.copied = false;
		state.error = undefined;
		render();
	});
	sheet.addEventListener("change", (/** @type {Event} */ event) => {
		const target = /** @type {HTMLSelectElement} */ (event.target);
		if (target.id === "model") void switchModel(target.value);
		else if (target.id === "thinking") void switchSetting((id) => api.setThinking(id, target.value));
		else if (target.id === "trust") void switchSetting((id) => api.setTrust(id, target.value));
	});
}

/** The bar's report shows until the fresh one is in. */
function openSheet() {
	state.sheetOpen = true;
	state.error = undefined;
	state.confirmDelete = false;
	// A fresh name field, holding the name the session has now.
	$("#sheet").dataset.html = "";
	render();
	void loadStatus();
}

function closeSheet() {
	state.sheetOpen = false;
	state.confirmDelete = false;
	state.focusModel = false;
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
	state.termError = undefined;
	// A fresh text field, not the one left from the last time it was open.
	$("#sheet").dataset.html = "";
	render();
	void loadScreen();
	pollScreen();
}

/**
 * Keys, or text, into the open session's pane; then its screen again. The keys go one a request,
 * each once the one before is in: Escape and the key after it would reach pi as one Alt chord.
 * @param {{ keys: string[] } | { text: string }} input @returns {Promise<boolean>} whether all of it went
 */
async function answer(input) {
	const id = state.open;
	if (!id || state.typing) return false;
	state.typing = true;
	state.termError = undefined;
	render();
	try {
		if ("keys" in input) for (const key of input.keys) await api.keys(id, [key]);
		else {
			await api.type(id, input.text);
			const field = $("#term-input");
			if (field?.value === input.text) field.value = "";
		}
		setTimeout(() => void loadScreen(), SCREEN_SETTLE_MS);
		return true;
	} catch (error) {
		// From the banner, the error shows there.
		if (state.terminal) terminalError(error);
		else handleError(error);
		return false;
	} finally {
		state.typing = false;
		render();
	}
}

/**
 * Yes or No to a confirm dialog. pi's is a list of the two: Up or Down picks one wherever its cursor
 * is (it stops at either end), and Enter takes it. Were the dialog gone, Up and Enter would send the
 * editor's last prompt again, and the list lags the pane by up to a heartbeat: so the dialog is
 * looked for once more first, and the answer is not offered again until the row has moved on (or
 * ANSWERED_MS, for a second dialog the list never saw it leave for).
 * @param {boolean} yes
 */
async function replyConfirm(yes) {
	const id = state.open;
	if (!id || state.typing || state.answered !== undefined) return;
	const at = Date.now();
	state.answered = at;
	render();
	await loadSessions();
	const sent =
		state.open === id &&
		isConfirm(state.sessions.find((s) => s.id === id)) &&
		(await answer({ keys: [yes ? "Up" : "Down", "Enter"] }));
	if (!sent && state.answered === at) state.answered = undefined;
	else
		setTimeout(() => {
			if (state.answered !== at) return;
			state.answered = undefined;
			render();
		}, ANSWERED_MS);
	render();
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
		showError(errorText("not_moved"));
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
	void move((id) => api[how](id, menu.id), promptText(menu.text));
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

/** The thinking level or trust mode, as a model switch: the pane reports the change. @param {(id: string) => Promise<unknown>} call */
async function switchSetting(call) {
	const id = state.open;
	if (!id) return;
	try {
		await call(id);
		void loadStatus();
	} catch (error) {
		// Back to what the pane reported.
		$("#sheet").dataset.html = "";
		handleError(error);
	}
}

/** The name in the sheet's field, shown at once: a pane takes it on its next heartbeat (see holdRename). */
async function rename() {
	const id = state.open;
	const field = $("#rename");
	const name = field?.value.trim() ?? "";
	if (!id || state.saving || name === state.sessions.find((s) => s.id === id)?.label) return;
	if (!name) {
		showError(errorText("invalid_name"));
		return;
	}
	state.saving = true;
	render();
	try {
		await api.rename(id, name);
		renamed = { id, name, until: Date.now() + RENAME_HOLD_MS };
		holdRename();
		field.blur();
	} catch (error) {
		handleError(error);
	} finally {
		state.saving = false;
		render();
	}
}

async function togglePin() {
	const id = state.open;
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
	const id = state.open;
	if (!id) return;
	state.confirmDelete = false;
	try {
		await api.deleteSession(id);
	} catch (error) {
		handleError(error);
		return;
	}
	if (state.open !== id) return;
	closeSheet();
	// As "‹ Sessions" goes: to the list's own entry when the chat was opened from it.
	if (backToList) history.back();
	else location.hash = "";
}

/** A cut-short tool result's whole output, into its block in place of the cut one. @param {string} entry */
async function loadOutput(entry) {
	const id = state.open;
	if (!id || outputs.get(entry)?.loading) return;
	outputs.set(entry, { loading: true });
	render();
	try {
		const { text, truncated } = await api.output(id, entry);
		if (state.open !== id) return;
		outputs.set(entry, { text, truncated });
	} catch (error) {
		if (error instanceof Unauthorized) {
			handleError(error);
			return;
		}
		if (state.open !== id) return;
		outputs.set(entry, { error: failure(error) });
	}
	render();
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

/** @param {File[]} files */
async function attach(files) {
	const id = state.open;
	const room = ATTACH_MAX - state.attachments.length;
	if (files.length > room) showError(errorText("too_many_images"));
	for (const file of files.slice(0, Math.max(room, 0))) {
		try {
			const image = await readImage(file);
			if (state.open !== id) return;
			// Another pick may have filled it meanwhile.
			if (state.attachments.length < ATTACH_MAX) state.attachments.push(image);
		} catch {
			showError(errorText("unreadable_image"));
		}
		render();
	}
	render();
}

/**
 * A picked image as a prompt sends it: as it is when small, else scaled down to a JPEG.
 * @param {File} file @returns {Promise<Attachment>}
 */
async function readImage(file) {
	const bitmap = await createImageBitmap(file);
	try {
		const keep =
			KEEP_TYPES.includes(file.type) &&
			file.size <= KEEP_BYTES_MAX &&
			Math.max(bitmap.width, bitmap.height) <= IMAGE_SIDE_MAX;
		const url = keep ? await dataUrl(file) : jpeg(bitmap, IMAGE_SIDE_MAX);
		return {
			mimeType: keep ? file.type : "image/jpeg",
			data: url.slice(url.indexOf(",") + 1),
			thumb: jpeg(bitmap, THUMB_SIDE),
		};
	} finally {
		bitmap.close();
	}
}

/** The image scaled to fit `side` on its long side, as a JPEG data URL. @param {ImageBitmap} bitmap @param {number} side */
function jpeg(bitmap, side) {
	const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(bitmap.width * scale));
	canvas.height = Math.max(1, Math.round(bitmap.height * scale));
	const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
	// A JPEG has no transparency: what was see-through turns white, not black.
	context.fillStyle = "#fff";
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/** An image of the open session's, by its message's id and its position there. @param {string} entry @param {string | number} index */
function pictureKey(entry, index) {
	return `${state.open}\n${entry}\n${index}`;
}

/** A picture button gets its image if fetched, and says so if it could not be. @param {HTMLElement} button */
function paint(button) {
	const key = pictureKey(button.dataset.entry ?? "", button.dataset.index ?? "");
	const url = pictures.get(key);
	const img = /** @type {HTMLImageElement} */ (button.querySelector("img"));
	if (url) {
		if (img.getAttribute("src") !== url) img.src = url;
		return true;
	}
	if (picturesFailed.has(key)) {
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
	const entry = state.pending.find((p) => String(p.id) === button.dataset.pending);
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
	const id = state.open;
	const key = pictureKey(entry, index);
	if (!id || pictures.has(key) || picturesLoading.has(key) || picturesFailed.has(key)) return;
	picturesLoading.add(key);
	try {
		const url = await dataUrl(await api.image(id, entry, index));
		if (state.open !== id) return;
		if (pictures.size >= PICTURES_MAX) pictures.delete(/** @type {string} */ (pictures.keys().next().value));
		pictures.set(key, url);
	} catch (error) {
		if (error instanceof Unauthorized) {
			handleError(error);
			return;
		}
		// Offline or the Mac failing: it is fetched again once the log is next rebuilt.
		const message = error instanceof Error ? error.message : String(error);
		if (state.open !== id || error instanceof TypeError || /^HTTP 5\d\d$/.test(message)) return;
		picturesFailed.add(key);
	} finally {
		picturesLoading.delete(key);
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

/** @param {Blob} blob @returns {Promise<string>} */
function dataUrl(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(blob);
	});
}

async function send() {
	const text = $("#text");
	const value = text.value.trim();
	const id = state.open;
	const session = state.sessions.find((s) => s.id === id);
	const resume = session?.resumable === true;
	// pi turns a prompt away while it compacts, and the transcript would never show it.
	if (!value || !id || state.navigating || state.compacting || (resume && state.starting)) return;
	// Left in the reply box, to change.
	if (refused(value)) {
		showError(errorText("terminal_command"));
		return;
	}
	// What a running session's own sheet does, done here rather than sent.
	const command = session?.alive && !resume ? shortcut(value) : undefined;
	if (command) {
		text.value = "";
		grow(text);
		if (command === "model") {
			state.focusModel = true;
			openSheet();
		} else if (isBusy(session)) showError("Compact is available once the session is idle.");
		else void compact();
		return;
	}
	const images = state.attachments;
	if (resume && images.length) {
		showError(errorText("images_need_running"));
		return;
	}
	if (resume) state.starting = { from: id };
	text.value = "";
	text.style.height = "auto";
	state.attachments = [];
	const key = promptKey(value, images.length);
	const before = userCount(state.messages, key) + state.pending.filter((p) => p.text === key).length;
	const last = state.messages.at(-1)?.id ?? "";
	const entry = { id: ++pendingId, text: key, prompt: value, images, before, sentAt: Date.now(), last };
	state.pending.push(entry);
	// The actions it holds back come back by themselves once the grace is over.
	setTimeout(render, PENDING_GRACE_MS);
	setTimeout(() => checkPending(id, entry), PROMPT_GIVE_UP_MS);
	render();
	$("#scroll").scrollTop = $("#scroll").scrollHeight;
	try {
		const { pane } = await api.prompt(
			id,
			value,
			images.map(({ mimeType, data }) => ({ mimeType, data })),
		);
		if (pane) waitForPane(pane, id);
		else if (resume) {
			state.starting = undefined;
			render();
		}
	} catch (error) {
		if (resume) state.starting = undefined;
		forget(entry);
		putBack(id, entry);
		handleError(error, "Not sent: ");
	}
}

/** @typedef {(typeof state.pending)[number]} Pending */

/** A sent prompt no longer waited for: those sent after it with the same text no longer count it. @param {Pending} entry */
function forget(entry) {
	const at = state.pending.indexOf(entry);
	if (at < 0) return;
	state.pending.splice(at, 1);
	for (const p of state.pending.slice(at)) if (p.text === entry.text) p.before--;
}

/** A prompt that did not reach its session, back in the reply box above what was typed since, with its images. @param {string} id @param {Pending} entry */
function putBack(id, entry) {
	if (state.open !== id) return;
	const text = $("#text");
	text.value = text.value ? `${entry.prompt}\n${text.value}` : entry.prompt;
	grow(text);
	if (!state.attachments.length) state.attachments = entry.images;
}

/** A sent prompt still waiting PROMPT_GIVE_UP_MS on (see giveUp); a resume's is waitForPane's. @param {string} id @param {Pending} entry */
function checkPending(id, entry) {
	if (state.open !== id || !state.pending.includes(entry) || state.starting) return;
	const verdict = giveUp(entry, state.sessions.find((s) => s.id === id)?.state, state.messages.at(-1)?.id ?? "");
	if (verdict === "wait") return;
	forget(entry);
	if (verdict === "drop") render();
	else {
		putBack(id, entry);
		showError(errorText("not_delivered"));
	}
}

// ---- paired phones ----

function phonesShell() {
	return `<header class="bar"><a class="back" href="#">‹ Sessions</a><h1>Paired phones</h1></header>
<div id="banner"></div><section class="scroll" id="devices"></section>`;
}

/** @param {Device} device */
function deviceHtml(device) {
	const id = esc(device.id);
	if (state.confirming === device.id) {
		return `<div class="row device"><span class="name">Remove ${esc(device.name)}?<small>${device.current ? "This phone" : "It"} will have to pair again.</small></span>
<button class="unpair cancel" data-cancel>Cancel</button><button class="unpair" data-confirm="${id}">Remove</button></div>`;
	}
	const day = (/** @type {string} */ iso) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
	const facts = [
		device.current ? "This phone" : "",
		`paired ${day(device.createdAt)}`,
		device.lastUsedAt ? `last used ${day(device.lastUsedAt)}` : "",
	];
	return `<div class="row device"><span class="name">${esc(device.name)}<small>${esc(facts.filter(Boolean).join(" · "))}</small></span>
<button class="unpair" data-remove="${id}">Remove</button></div>`;
}

function updatePhones() {
	const banner = state.error ? `<div class="banner off">${esc(state.error)}</div>` : "";
	if ($("#banner").innerHTML !== banner) $("#banner").innerHTML = banner;
	const devices = state.devices;
	$("#devices").innerHTML = !devices
		? `<p class="empty">Loading…</p>`
		: devices.length
			? devices.map(deviceHtml).join("")
			: `<p class="empty">No paired phones.</p>`;
}

async function loadDevices() {
	try {
		state.devices = await api.devices();
		render();
	} catch (error) {
		loadError(error);
	}
}

/** @param {string} id */
async function removeDevice(id) {
	const device = state.devices?.find((d) => d.id === id);
	state.confirming = undefined;
	try {
		await api.removeDevice(id);
	} catch (error) {
		handleError(error);
		void loadDevices();
		return;
	}
	if (!device?.current) return void loadDevices();
	// Signed out: back to pairing.
	clearToken();
	source?.close();
	history.replaceState(null, "", location.pathname + location.search);
	state.phones = false;
	render();
}

function bindPhones() {
	void loadDevices();
	$("#devices").addEventListener("click", (/** @type {Event} */ event) => {
		const button = /** @type {HTMLElement | null} */ (/** @type {Element} */ (event.target).closest("button"));
		if (!button) return;
		if (button.dataset.remove) state.confirming = button.dataset.remove;
		else if (button.dataset.confirm) void removeDevice(button.dataset.confirm);
		else state.confirming = undefined;
		updatePhones();
	});
}

/** Opening or leaving the paired phones screen. */
function routePhones() {
	const phones = location.hash === "#phones";
	if (phones === state.phones) return;
	state.phones = phones;
	state.devices = undefined;
	state.confirming = undefined;
	state.error = undefined;
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
	const fromList = !state.open && !state.phones;
	routePhones();
	const match = /^#s\/(.+)$/.exec(location.hash);
	const open = match ? decodeURIComponent(match[1]) : undefined;
	if (open !== state.open) {
		// A resumed session's pane replaces its entry, which still follows the list's.
		backToList = open !== undefined && (fromList || (open === followed && backToList));
		// Following a resumed session to its pane keeps the reply on screen until pi writes it.
		if (open === undefined || open !== followed) state.pending = [];
		state.attachments = [];
		pictures.clear();
		picturesLoading.clear();
		picturesFailed.clear();
		outputs.clear();
		followed = undefined;
		openSessionId = undefined;
		turnEndedAt = undefined;
		state.open = open;
		state.messages = [];
		state.messagesLoaded = false;
		state.more = false;
		state.loadingOlder = false;
		state.live = undefined;
		liveEnded = false;
		clearTimeout(liveClear);
		state.error = undefined;
		state.sheetOpen = false;
		state.report = undefined;
		state.compacting = false;
		state.focusModel = false;
		state.stopping = false;
		state.navigating = false;
		clearTimeout(navigateGiveUp);
		state.menu = undefined;
		state.copied = false;
		state.terminal = false;
		state.screen = undefined;
		state.answered = undefined;
		state.confirmDelete = false;
		pollScreen();
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
	// In layout pixels, as a pinch zoom leaves them.
	const height = viewport.height * viewport.scale;
	const keyboard = Math.max(0, root.clientHeight - height - viewport.offsetTop * viewport.scale);
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
window.visualViewport?.addEventListener("resize", fitViewport);
window.visualViewport?.addEventListener("scroll", fitViewport);
fitViewport();
// iOS suspends a backgrounded app's stream: reopen it on return.
document.addEventListener("visibilitychange", () => {
	pollScreen();
	if (document.visibilityState === "visible") {
		connect();
		void loadScreen();
		// A fresh one: Safari may sit in the background longer than a handoff lasts.
		void offerHandoff();
	}
});
// The list's ages, and the status bar's time to each usage limit's reset.
setInterval(() => {
	if (shown === "list") updateList();
	else if (shown.startsWith("chat:")) updateChat();
}, 30_000);
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("sw.js").catch(() => {});
	// A notification tapped while the app is open: sw.js asks it to open that session.
	navigator.serviceWorker.addEventListener("message", (/** @type {MessageEvent} */ event) => {
		const id = event.data?.open;
		if (typeof id === "string") location.hash = `#s/${encodeURIComponent(id)}`;
	});
}

claimLink();
routePhones();
state.open = /^#s\/(.+)$/.exec(location.hash)?.[1];
if (state.open) state.open = decodeURIComponent(state.open);
render();
connect();
void offerHandoff();
