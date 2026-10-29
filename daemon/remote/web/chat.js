// @ts-check
/**
 * The open chat: one session as the phone shows it, from when it opens until another session or the
 * list is shown, and what changes it as the transcript, the list and sent prompts come in. No DOM
 * and no requests: app.js fetches, renders, runs the timers it keeps here, and drops a chat no longer
 * open.
 */
import { giveUp, promptKey, sentText, settle } from "./live.js";

/**
 * @typedef {import("./app.js").Message} Message @typedef {import("./app.js").LiveSnapshot} LiveSnapshot
 * @typedef {import("./app.js").Attachment} Attachment @typedef {import("./app.js").Report} Report
 */
/**
 * A prompt sent and not yet in the transcript. `text`: as the transcript will show it (see
 * promptKey); `prompt`: as typed, `images`: as sent. `before`: the transcript's copies of its text
 * when it was sent. `started`: the session was seen working since. `last`: the transcript's last
 * message when it was sent.
 * @typedef {{ id: number, text: string, prompt: string, images: Attachment[], before: number, sentAt: number, started?: boolean, last: string }} Pending
 */

/** Across chats: a followed chat's pending prompts keep theirs. */
let pendingId = 0;

/**
 * A chat of the session in `id`'s pane. One that follows its session to a new pane (`previous`)
 * carries the prompts still pending, and the way back to the list.
 * @param {string} id @param {{ pending: Pending[], backToList: boolean }} [previous]
 */
export function openChat(id, previous) {
	return {
		id,
		/** @type {Message[]} */ messages: [],
		messagesLoaded: false,
		/** Older messages are left before the first one shown. */
		more: false,
		/** Older messages are on their way. */
		loadingOlder: false,
		/** The reply in progress, streamed by its pane. @type {LiveSnapshot | undefined} */ live: undefined,
		/** The reply on screen has ended (or may have, while the stream was down): see settle(). */
		liveEnded: false,
		/** @type {ReturnType<typeof setTimeout> | undefined} */ liveClear: undefined,
		/** Shared with a chat this one follows, so it is changed in place (see keepPending). @type {Pending[]} */
		pending: previous?.pending ?? [],
		/** Images for the next prompt. @type {Attachment[]} */ attachments: [],
		/** Picked photos still being read into `attachments`. */
		reading: 0,
		/** The new name is on its way. */
		saving: false,
		/** Its pane's report: undefined while loading, null when it has sent none. @type {Report | null | undefined} */
		report: undefined,
		/** Stop was asked for and the session is still mid-turn. */
		stopping: false,
		/** The status sheet. */
		sheetOpen: false,
		/** The background tasks sheet. */
		tasksSheet: false,
		/** Each task's output as last fetched, while shown in the sheet. @type {Map<string, { lines?: string[], size?: number, loading?: boolean, error?: string }>} */
		taskOutputs: new Map(),
		/** The task whose Stop asks to be confirmed. @type {string | undefined} */
		confirmStop: undefined,
		/** Tasks asked to stop that the report still lists. @type {Set<string>} */
		stoppingTasks: new Set(),
		/** Its Delete asks to be confirmed. */
		confirmDelete: false,
		/**
		 * Its images fetched so far, as data URLs (the CSP allows no blob: URL), by pictureKey; the
		 * oldest go past PICTURES_MAX, and are fetched again if shown again.
		 * @type {Map<string, string>}
		 */
		pictures: new Map(),
		/** @type {Set<string>} */ picturesLoading: new Set(),
		/** Not fetched again in this chat. @type {Set<string>} */ picturesFailed: new Set(),
		/** Tool results asked for in full, by entry id: the text, or why it is not there. @type {Map<string, { text?: string, truncated?: boolean, error?: string, loading?: boolean }>} */
		outputs: new Map(),
		/** Its pi session, as last listed: its row may go, and the next chat follows it to its next one. @type {string | undefined} */
		sessionId: undefined,
		/** The pane its session moved to, which the next chat follows. @type {string | undefined} */
		next: undefined,
		/**
		 * Its turn ended, as of a list asked for at this time: the next transcript page drops the
		 * prompts sent before then that it still lacks, which pi did not write as sent.
		 * @type {number | undefined}
		 */
		turnEndedAt: undefined,
		/** Its commands were asked for, with its first report: the cached ones show meanwhile. */
		commandsAsked: false,
		/** Opened from the list, whose history entry "‹ Sessions" goes back to. */
		backToList: previous?.backToList ?? false,
		messagesRequest: 0,
		statusRequest: 0,
	};
}

/** @typedef {ReturnType<typeof openChat>} Chat */

/**
 * Only the pending prompts `keep` holds, in the same list: one a send that failed takes out of the
 * chat it was sent from leaves the chat that followed it too.
 * @param {Chat} chat @param {(p: Pending) => boolean} keep
 */
function keepPending(chat, keep) {
	const kept = chat.pending.filter(keep);
	chat.pending.splice(0, chat.pending.length, ...kept);
}

/** @param {Message[]} messages @param {string} text */
function userCount(messages, text) {
	// Trimmed: a prompt starting with @ reaches pi with a space before it.
	return messages.filter((m) => m.kind === "user" && sentText(m.text ?? "") === text).length;
}

/**
 * The latest page of the transcript. Older messages loaded above stay while it starts among them;
 * after the session moved (a /tree or /fork, here or on the Mac) it does not, and replaces them.
 * @param {Chat} chat @param {{ messages: Message[], more: boolean }} page
 */
export function applyLatest(chat, page) {
	const latest = page.messages;
	const at = latest.length ? chat.messages.findIndex((m) => m.id === latest[0].id) : -1;
	if (at > 0) chat.messages = [...chat.messages.slice(0, at), ...latest];
	else {
		// A pending prompt's count no longer includes the copies of its text that went with them.
		const kept = new Set(latest.map((m) => m.id));
		const gone = chat.messages.filter((m) => !kept.has(m.id));
		for (const p of chat.pending) p.before -= userCount(gone, p.text);
		chat.messages = latest;
		chat.more = page.more;
	}
	chat.messagesLoaded = true;
	chat.live = settle(chat.live, chat.liveEnded, latest);
	// A sent prompt is pending until the transcript has one more copy of its text than when it was sent.
	keepPending(chat, (p) => userCount(chat.messages, p.text) <= p.before);
	const ended = chat.turnEndedAt;
	chat.turnEndedAt = undefined;
	if (ended !== undefined) keepPending(chat, (p) => p.sentAt >= ended);
}

/**
 * The page before `first`, put above it: not after a refresh that replaced the log meanwhile, as
 * it would be another branch's.
 * @param {Chat} chat @param {Message} first @param {{ messages: Message[], more: boolean }} page
 * @returns {boolean} whether it went in
 */
export function applyOlder(chat, first, page) {
	if (chat.messages[0]?.id !== first.id) return false;
	for (const p of chat.pending) p.before += userCount(page.messages, p.text);
	chat.messages = [...page.messages, ...chat.messages];
	chat.more = page.more;
	return true;
}

/**
 * The session's state in a list asked for at `asked`, and in the one before it. Working, it has
 * started the prompts sent before then; done working (not for a dialog), its turn ended.
 * @param {Chat} chat @param {string | undefined} was @param {string | undefined} now @param {number} asked
 * @returns {boolean} whether the transcript is to be fetched again, for the turn's end
 */
export function listed(chat, was, now, asked) {
	if (now === "working") {
		for (const p of chat.pending) if (p.sentAt < asked) p.started = true;
		return false;
	}
	if (was !== "working" || now === undefined || now === "needs") return false;
	chat.turnEndedAt = asked;
	return true;
}

/**
 * A prompt sent at `now`, pending until the transcript has it.
 * @param {Chat} chat @param {string} prompt @param {Attachment[]} images @param {number} now
 * @returns {Pending}
 */
export function addPending(chat, prompt, images, now) {
	const text = promptKey(prompt, images.length);
	const before = userCount(chat.messages, text) + chat.pending.filter((p) => p.text === text).length;
	const last = chat.messages.at(-1)?.id ?? "";
	const entry = { id: ++pendingId, text, prompt, images, before, sentAt: now, last };
	chat.pending.push(entry);
	return entry;
}

/** A sent prompt no longer waited for: those sent after it with the same text no longer count it. @param {Chat} chat @param {Pending} entry */
export function forget(chat, entry) {
	const at = chat.pending.indexOf(entry);
	if (at < 0) return;
	chat.pending.splice(at, 1);
	for (const p of chat.pending.slice(at)) if (p.text === entry.text) p.before--;
}

/**
 * A sent prompt whose time is up (see giveUp), forgotten unless it waits on.
 * @param {Chat} chat @param {Pending} entry @param {string | undefined} sessionState
 * @returns {"wait" | "drop" | "fail"}
 */
export function checkPending(chat, entry, sessionState) {
	const verdict = giveUp(entry, sessionState, chat.messages.at(-1)?.id ?? "");
	if (verdict !== "wait") forget(chat, entry);
	return verdict;
}
