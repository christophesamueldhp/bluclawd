// @ts-check
/**
 * The open chat: one session as the phone shows it, from when it opens until another session or the
 * list is shown, and what changes it as the transcript, the list and sent prompts come in. No DOM
 * and no requests: app.js fetches, renders, runs the timers it keeps here, and drops a chat no longer
 * open.
 */

import { giveUp, promptKey, sentText, settle, shellLine } from "./live.js";
import { createSkillDraft } from "./skills.js";

/**
 * @typedef {import("./app.js").Message} Message @typedef {import("./app.js").LiveSnapshot} LiveSnapshot
 * @typedef {import("./app.js").Attachment} Attachment @typedef {import("./app.js").Report} Report
 */
/**
 * A prompt sent and not yet in the transcript. `id`: the one sent with it, which its outcome comes
 * back by. `text`: as the transcript will show it (see promptKey); `prompt`: as typed, `images`:
 * as sent. `before`: the transcript's copies of its text when it was sent. `started`: the session
 * was seen working since. `last`: the transcript's last message when it was sent. `lifetime`: the
 * daemon's, as it answered that it has it, which the daemon is asked about it by. `acceptedAt`: set
 * instead by an older phone (0.0.52), which kept no lifetime, once the daemon had it. `outcome`: what its
 * pane reported of it, a pane that reports outcomes.
 * @typedef {{ id: string, text: string, prompt: string, images: Attachment[], before: number, sentAt: number, started?: boolean, last: string, lifetime?: string, acceptedAt?: number, outcome?: "taken" | "queued", skillDraft?: import("./skills.js").SkillDraft }} Pending
 */

/** A reply's text and thinking, held until a page has its entry. @typedef {{ entryId: string, text: string, thinking?: string }} Held */

/** Why a sent prompt came back: its pane refused it, or it was lost. @typedef {{ entry: Pending, reason: string }} Failed */

/** @typedef {import("./statusbar.js").PromptOutcome} PromptOutcome */

/** Unique across chats and reloads: the daemon keeps outcomes by it. */
function promptId() {
	const random = crypto.getRandomValues(new Uint32Array(2));
	return [Date.now(), ...random].map((n) => n.toString(36)).join("-");
}

/**
 * A chat of the session whose row is `id`: the row keeps its id while the session moves between a
 * pane and storage. `kept`: its pending prompts the phone kept (see storedPending).
 * @param {string} id @param {Pending[]} [kept]
 */
export function openChat(id, kept = []) {
	return {
		id,
		skillDraft: createSkillDraft(),
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
		/** Replies their pane said ended at a transcript entry, shown until a page has it: see replyEndedAt(). @type {Held[]} */
		held: [],
		/** @type {Pending[]} */ pending: [],
		/** Those the phone kept of it, until restorePending puts them back in or discards them. */
		kept,
		/** Those the phone kept of it were put back in or discarded (see restorePending). */
		restored: false,
		/** The outcomes the daemon replayed, every one it knows for the session, until those kept are restored. @type {PromptOutcome[] | undefined} */
		replay: undefined,
		/** Images for the next prompt. @type {Attachment[]} */ attachments: [],
		/** Picked photos still being read into `attachments`. */
		reading: 0,
		/** The new name is on its way. */
		saving: false,
		/** Its pane's report: undefined while loading, null when it has sent none. @type {Report | null | undefined} */
		report: undefined,
		/** Stop was asked for and the session is still mid-turn. */
		stopping: false,
		/** When a prompt was last sent from here (epoch ms). @type {number | undefined} */
		sentAt: undefined,
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
		/**
		 * Its turn ended, as of a list asked for at this time: the next transcript page drops the
		 * prompts sent before then that it still lacks, which pi did not write as sent.
		 * @type {number | undefined}
		 */
		turnEndedAt: undefined,
		/** Its commands were asked for, with its first report: the cached ones show meanwhile. */
		commandsAsked: false,
		/** Opened from the list, whose history entry "‹ Sessions" goes back to. */
		backToList: false,
		messagesRequest: 0,
		statusRequest: 0,
	};
}

/** @typedef {ReturnType<typeof openChat>} Chat */

/**
 * The reply on screen ended at transcript entry `entryId`: its text and thinking are held until a
 * page has that entry, whatever text later snapshots show (none while its tools run). Its tools
 * stay live, and go as their results land.
 * @param {Chat} chat @param {string} entryId
 */
export function replyEndedAt(chat, entryId) {
	const live = chat.live;
	if (live?.text || live?.thinking) chat.held.push({ entryId, text: live.text, thinking: live.thinking });
	chat.live = live?.tools.length ? { text: "", tools: live.tools } : undefined;
}

/** Only the pending prompts `keep` holds. @param {Chat} chat @param {(p: Pending) => boolean} keep */
function keepPending(chat, keep) {
	chat.pending = chat.pending.filter(keep);
}

/** @param {Message[]} messages @param {string} text */
function userCount(messages, text) {
	// Trimmed: a prompt starting with @ reaches pi with a space before it.
	return messages.filter((m) => m.kind === "user" && sentText(m.text ?? "") === text).length;
}

/**
 * The latest page of the transcript. Older messages loaded above stay while it starts among them;
 * after the session moved (a /tree, here or on the Mac) it does not, and replaces them.
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
	// pi writes the replies in the order they ended: one whose entry is not there by a later reply's
	// never will be (another extension emptied it, or the session moved to another branch).
	const ids = new Set(latest.map((m) => m.id));
	const last = chat.held.map((h) => ids.has(h.entryId)).lastIndexOf(true);
	chat.held = chat.held.slice(last + 1);
	// A pane from an older build reports no outcomes: a prompt sent to it is pending until the
	// transcript has one more copy of its text than when it was sent.
	const guess = !reportsOutcomes(chat);
	keepPending(chat, (p) => (guess && !p.outcome ? userCount(chat.messages, p.text) <= p.before : !written(chat, p)));
	const ended = chat.turnEndedAt;
	chat.turnEndedAt = undefined;
	// One its pane reported queued waits on: the pane reports it taken, or lost once pi drops it.
	if (ended !== undefined) keepPending(chat, (p) => p.sentAt >= ended || (!guess && p.outcome === "queued"));
}

/** Its pane reports what became of each prompt, as a pane from an older build does not. @param {Chat} chat */
function reportsOutcomes(chat) {
	return Array.isArray(chat.report?.outcomes);
}

/**
 * Its pane's report shows an older build's, without outcomes. No report says nothing of the build:
 * a pane yet to send its first, one gone silent, or any after its daemon restarted.
 * @param {Chat} chat
 */
function olderBuild(chat) {
	return chat.report != null && !Array.isArray(chat.report.outcomes);
}

/**
 * A prompt pi took is in the transcript once it moved past where it was when the prompt was sent:
 * pi writes a prompt as it starts its turn. A slash command or a `!` line, which may write nothing,
 * is done once taken. Not before the transcript has loaded, for one restored as the chat opens.
 * @param {Chat} chat @param {Pending} entry
 */
function written(chat, entry) {
	if (entry.outcome !== "taken") return false;
	const name = /^\/(?!skill:)([\w.:-]+)(?:\s|$)/.exec(entry.prompt.trimStart())?.[1];
	// Built-ins still use the pane's command route even when the draft contains selected skills.
	const builtin = name !== undefined && ["compact", "new", "reload"].includes(name);
	const command =
		!entry.images.length &&
		(shellLine(entry.prompt) || (name !== undefined && (builtin || !entry.skillDraft?.selections.length)));
	return command || (chat.messagesLoaded && (chat.messages.at(-1)?.id ?? "") !== entry.last);
}

/**
 * What became of the prompts sent to the session: from its status, the event stream's, or the
 * daemon's answer about those it still waits on (see waitingOn). The refused and lost ones are
 * taken out, and returned to go back into the reply box.
 * @param {Chat} chat @param {PromptOutcome[] | undefined} outcomes
 * @returns {Failed[]}
 */
export function settleOutcomes(chat, outcomes) {
	/** @type {Failed[]} */
	const failed = [];
	for (const outcome of outcomes ?? []) {
		const entry = chat.pending.find((p) => p.id === outcome.id);
		if (!entry) continue;
		if (outcome.outcome === "refused" || outcome.outcome === "lost") failed.push({ entry, reason: outcome.reason });
		else if (outcome.outcome !== "sent") entry.outcome = outcome.outcome;
	}
	for (const { entry } of failed) forget(chat, entry);
	keepPending(chat, (p) => !written(chat, p));
	return failed;
}

/**
 * The prompts the daemon is asked about: those it accepted that their pane has said nothing of.
 * It answers each with its outcome, or lost when a daemon before a restart accepted it, as only it
 * can tell; one pi took or queued is not sent again. One an older phone kept with no lifetime is
 * asked about with none, which the daemon answers only while it knows the id.
 * @param {Chat} chat
 * @returns {{ id: string, lifetime?: string }[]}
 */
export function waitingOn(chat) {
	return chat.pending.flatMap(({ id, lifetime, acceptedAt, outcome }) => {
		if (outcome) return [];
		if (lifetime) return [{ id, lifetime }];
		return acceptedAt === undefined ? [] : [{ id }];
	});
}

/**
 * The prompts the phone kept of the chat (see storedPending), back in as it opens again once both
 * the daemon's `replay` and its pane's report (or its answer that there is none) are in, in either
 * order, and settled by the replay as settleOutcomes does. For a pane whose report shows an older
 * build, which reports no outcomes to settle them by, only those the replay says refused or lost
 * come back (the daemon's word on each, whatever the pane's build), and the others are discarded.
 * @param {Chat} chat @param {PromptOutcome[]} [replay]
 * @returns {Failed[]}
 */
export function restorePending(chat, replay) {
	if (chat.restored) return [];
	chat.replay = replay ?? chat.replay;
	if (!chat.replay || chat.report === undefined) return [];
	const outcomes = chat.replay;
	const kept = chat.kept;
	chat.restored = true;
	chat.replay = undefined;
	chat.kept = [];
	if (olderBuild(chat)) {
		/** @type {Failed[]} */
		const failed = [];
		for (const outcome of outcomes) {
			const entry = kept.find((k) => k.id === outcome.id);
			if (entry && (outcome.outcome === "refused" || outcome.outcome === "lost"))
				failed.push({ entry, reason: outcome.reason });
		}
		return failed;
	}
	const restored = kept.filter((s) => !chat.pending.some((p) => p.id === s.id));
	chat.pending = [...restored, ...chat.pending];
	return settleOutcomes(chat, outcomes);
}

/**
 * The pending prompts to keep on the phone, for restorePending: from the moment they are sent,
 * with those kept before that are not back in yet; none sent to a pane whose report shows an older
 * build, which reports no outcomes to settle them by.
 * @param {Chat} chat
 * @returns {Pending[]}
 */
export function storedPending(chat) {
	if (olderBuild(chat)) return chat.kept;
	return [...chat.kept, ...chat.pending];
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
	/** @type {Pending} */
	const entry = { id: promptId(), text, prompt, images, before, sentAt: now, last };
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
 * A sent prompt whose time is up (see giveUp), forgotten unless it waits on. One its pane reported
 * taken or queued reached pi: it waits on. So does one whose row is `silent` (its pane stopped
 * answering, and may come back), unless its pane is an older build's: the daemon reports it once
 * the pane is back, or lost once the pane is gone.
 * @param {Chat} chat @param {Pending} entry @param {string | undefined} sessionState @param {boolean} [silent]
 * @returns {"wait" | "drop" | "fail"}
 */
export function checkPending(chat, entry, sessionState, silent) {
	if (entry.outcome || (silent && !olderBuild(chat))) return "wait";
	const verdict = giveUp(entry, sessionState, chat.messages.at(-1)?.id ?? "");
	if (verdict !== "wait") forget(chat, entry);
	return verdict;
}
