// @ts-check

import { giveUp, promptKey, sentText, settle, shellLine } from "./live.js";
import { createSkillDraft } from "./skills.js";

/**
 * @typedef {import("./app.js").Message} Message @typedef {import("./app.js").LiveSnapshot} LiveSnapshot
 * @typedef {import("./app.js").Attachment} Attachment @typedef {import("./app.js").Report} Report
 */
/**
 * @typedef {{ id: string, text: string, prompt: string, images: Attachment[], sameTextBefore: number, sentAt: number, sawWorking?: boolean, lastIdWhenSent: string, lifetime?: string, outcome?: "taken" | "queued", skillDraft?: import("./skills.js").SkillDraft, giveUpAt?: number }} Pending
 */

/** @typedef {{ entryId: string, text: string, thinking?: string }} Held */

/** @typedef {{ entry: Pending, reason?: string }} Failed */

/** @typedef {import("./statusbar.js").PromptOutcome} PromptOutcome */

export const PROMPT_GIVE_UP_MS = 20_000;
const PANE_ROUTED_BUILTINS = ["compact", "new", "reload"];

function promptId() {
	const random = crypto.getRandomValues(new Uint32Array(2));
	return [Date.now(), ...random].map((n) => n.toString(36)).join("-");
}

/** @param {string} id @param {Pending[]} [kept] */
export function openChat(id, kept = []) {
	return {
		id,
		skillDraft: createSkillDraft(),
		/** @type {Message[]} */ messages: [],
		messagesLoaded: false,
		more: false,
		loadingOlder: false,
		/** @type {LiveSnapshot | undefined} */ live: undefined,
		liveRetracted: false,
		/** @type {ReturnType<typeof setTimeout> | undefined} */ liveClear: undefined,
		/** @type {Held[]} */
		held: [],
		/** @type {Pending[]} */ pending: [],
		kept,
		restored: false,
		/** @type {PromptOutcome[] | undefined} */
		replay: undefined,
		/** @type {Attachment[]} */ attachments: [],
		reading: 0,
		saving: false,
		/** @type {Report | null | undefined} */
		report: undefined,
		stopping: false,
		/** @type {number | undefined} */
		sentAt: undefined,
		sheetOpen: false,
		tasksSheet: false,
		/** @type {Map<string, { lines?: string[], size?: number, loading?: boolean, error?: string }>} */
		taskOutputs: new Map(),
		/** @type {string | undefined} */
		confirmStop: undefined,
		/** @type {Set<string>} */
		stoppingTasks: new Set(),
		confirmDelete: false,
		/** @type {Map<string, string>} */
		pictures: new Map(),
		/** @type {Set<string>} */ picturesLoading: new Set(),
		/** @type {Set<string>} */ picturesFailed: new Set(),
		/** @type {Map<string, { text?: string, truncated?: boolean, error?: string, loading?: boolean }>} */
		outputs: new Map(),
		/** @type {number | undefined} */
		dropUnwrittenSentBefore: undefined,
		commandsAsked: false,
		backToList: false,
		messagesRequest: 0,
		statusRequest: 0,
	};
}

/** @typedef {ReturnType<typeof openChat>} Chat */

/** @param {Chat} chat @param {string} entryId */
export function replyEndedAt(chat, entryId) {
	const live = chat.live;
	if (live?.text || live?.thinking) chat.held.push({ entryId, text: live.text, thinking: live.thinking });
	chat.live = live?.tools.length ? { text: "", tools: live.tools } : undefined;
}

/** @param {Chat} chat @param {(p: Pending) => boolean} keep */
function keepPending(chat, keep) {
	chat.pending = chat.pending.filter(keep);
}

/** @param {Chat} chat @param {Set<string>} ids */
function dropHeldPassedBy(chat, ids) {
	const last = chat.held.map((h) => ids.has(h.entryId)).lastIndexOf(true);
	chat.held = chat.held.slice(last + 1);
}

/** @param {Message[]} messages @param {string} text */
function userCount(messages, text) {
	return messages.filter((m) => m.kind === "user" && sentText(m.text ?? "") === text).length;
}

/** @param {Chat} chat @param {{ messages: Message[], more: boolean }} page */
export function applyLatest(chat, page) {
	const latest = page.messages;
	const at = latest.length ? chat.messages.findIndex((m) => m.id === latest[0].id) : -1;
	if (at > 0) chat.messages = [...chat.messages.slice(0, at), ...latest];
	else {
		const kept = new Set(latest.map((m) => m.id));
		const gone = chat.messages.filter((m) => !kept.has(m.id));
		for (const p of chat.pending) p.sameTextBefore -= userCount(gone, p.text);
		chat.messages = latest;
		chat.more = page.more;
	}
	chat.messagesLoaded = true;
	chat.live = settle(chat.live, chat.liveRetracted, latest);
	dropHeldPassedBy(chat, new Set(latest.map((m) => m.id)));
	const countTextCopies = !reportsOutcomes(chat);
	keepPending(chat, (p) =>
		countTextCopies && !p.outcome ? userCount(chat.messages, p.text) <= p.sameTextBefore : !written(chat, p),
	);
	const ended = chat.dropUnwrittenSentBefore;
	chat.dropUnwrittenSentBefore = undefined;
	if (ended !== undefined) keepPending(chat, (p) => p.sentAt >= ended || (!countTextCopies && p.outcome === "queued"));
}

/** @param {Chat} chat */
function reportsOutcomes(chat) {
	return Array.isArray(chat.report?.outcomes);
}

/** @param {Chat} chat */
function reportShowsOlderBuild(chat) {
	return chat.report != null && !Array.isArray(chat.report.outcomes);
}

/** @param {Chat} chat @param {Pending} entry */
function written(chat, entry) {
	if (entry.outcome !== "taken") return false;
	const name = /^\/(?!skill:)([\w.:-]+)(?:\s|$)/.exec(entry.prompt.trimStart())?.[1];
	const builtin = name !== undefined && PANE_ROUTED_BUILTINS.includes(name);
	const command =
		!entry.images.length &&
		(shellLine(entry.prompt) || (name !== undefined && (builtin || !entry.skillDraft?.selections.length)));
	return command || (chat.messagesLoaded && (chat.messages.at(-1)?.id ?? "") !== entry.lastIdWhenSent);
}

/** @param {Chat} chat @param {PromptOutcome[] | undefined} outcomes @returns {Failed[]} */
function settleOutcomes(chat, outcomes) {
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
 * @param {Chat} chat
 * @returns {{ id: string, lifetime: string }[]}
 */
function waitingOn(chat) {
	return chat.pending.flatMap(({ id, lifetime, outcome }) => (lifetime && !outcome ? [{ id, lifetime }] : []));
}

/** @param {Chat} chat @param {PromptOutcome[]} [replay] @returns {Failed[]} */
function restorePending(chat, replay) {
	if (chat.restored) return [];
	chat.replay = replay ?? chat.replay;
	if (!chat.replay || chat.report === undefined) return [];
	const outcomes = chat.replay;
	const kept = chat.kept;
	chat.restored = true;
	chat.replay = undefined;
	chat.kept = [];
	if (reportShowsOlderBuild(chat)) {
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

/** @param {Chat} chat @returns {Pending[]} */
export function storedPending(chat) {
	if (reportShowsOlderBuild(chat)) return chat.kept;
	return [...chat.kept, ...chat.pending];
}

/** @param {Chat} chat @param {Message} first @param {{ messages: Message[], more: boolean }} page @returns {boolean} */
export function applyOlder(chat, first, page) {
	if (chat.messages[0]?.id !== first.id) return false;
	for (const p of chat.pending) p.sameTextBefore += userCount(page.messages, p.text);
	chat.messages = [...page.messages, ...chat.messages];
	chat.more = page.more;
	return true;
}

/** @param {Chat} chat @param {string | undefined} was @param {string | undefined} now @param {number} asked @returns {boolean} */
export function listed(chat, was, now, asked) {
	if (now === "working") {
		for (const p of chat.pending) if (p.sentAt < asked) p.sawWorking = true;
		return false;
	}
	if (was !== "working" || now === undefined || now === "needs") return false;
	chat.dropUnwrittenSentBefore = asked;
	return true;
}

/** @param {Chat} chat @param {string} prompt @param {Attachment[]} images @param {number} now @returns {Pending} */
function addPending(chat, prompt, images, now) {
	const text = promptKey(prompt, images.length);
	const sameTextBefore = userCount(chat.messages, text) + chat.pending.filter((p) => p.text === text).length;
	const lastIdWhenSent = chat.messages.at(-1)?.id ?? "";
	/** @type {Pending} */
	const entry = { id: promptId(), text, prompt, images, sameTextBefore, sentAt: now, lastIdWhenSent };
	chat.pending.push(entry);
	return entry;
}

/** @param {Chat} chat @param {Pending} entry */
function forget(chat, entry) {
	const at = chat.pending.indexOf(entry);
	if (at < 0) return;
	chat.pending.splice(at, 1);
	for (const p of chat.pending.slice(at)) if (p.text === entry.text) p.sameTextBefore--;
}

/** @param {Chat} chat @param {Pending} entry @param {string | undefined} sessionState @param {boolean} [silent] @returns {"wait" | "drop" | "fail"} */
function checkPending(chat, entry, sessionState, silent) {
	if (entry.outcome || (silent && !reportShowsOlderBuild(chat))) return "wait";
	const verdict = giveUp(entry, sessionState, chat.messages.at(-1)?.id ?? "");
	if (verdict !== "wait") forget(chat, entry);
	return verdict;
}

/** @param {Chat} chat @param {string} prompt @param {Attachment[]} images @param {import("./skills.js").SkillDraft} skillDraft @param {number} now @returns {Pending} */
export function promptSent(chat, prompt, images, skillDraft, now) {
	const entry = addPending(chat, prompt, images, now);
	entry.skillDraft = skillDraft;
	entry.giveUpAt = now + PROMPT_GIVE_UP_MS;
	chat.sentAt = now;
	return entry;
}

/** @typedef {{ status: Report | null } | { outcomes: PromptOutcome[] | undefined } | { replay: PromptOutcome[] } | { answer: PromptOutcome[] } | { accepted: Pending, lifetime: string | undefined } | { notSent: Pending } | { startTimedOut: true } | { time: { state: string | undefined, silent?: boolean, starting?: boolean } }} Arrival */

/** @typedef {{ returned: Failed[], ask: { id: string, lifetime: string }[], dropped: boolean }} Next */

/** @param {Chat} chat @param {Arrival} arrival @param {number} now @returns {Next} */
export function arrive(chat, arrival, now) {
	/** @type {Next} */
	const next = { returned: [], ask: [], dropped: false };
	if ("accepted" in arrival) arrival.accepted.lifetime = arrival.lifetime;
	else if ("notSent" in arrival) {
		forget(chat, arrival.notSent);
		next.returned.push({ entry: arrival.notSent });
	} else if ("startTimedOut" in arrival) chat.pending = [];
	else if ("time" in arrival) checkDue(chat, arrival.time, now, next);
	else {
		if ("status" in arrival) chat.report = arrival.status;
		const replay = "replay" in arrival ? arrival.replay : undefined;
		const outcomes =
			"status" in arrival
				? arrival.status?.outcomes
				: "answer" in arrival
					? arrival.answer
					: "replay" in arrival
						? arrival.replay
						: arrival.outcomes;
		const kept = chat.kept;
		next.returned.push(...restorePending(chat, replay));
		if (chat.restored) for (const entry of kept) entry.giveUpAt = now + PROMPT_GIVE_UP_MS;
		next.returned.push(...settleOutcomes(chat, outcomes));
		if ("status" in arrival || "replay" in arrival) next.ask = waitingOn(chat);
	}
	return next;
}

/** @param {Chat} chat @param {{ state: string | undefined, silent?: boolean, starting?: boolean }} row @param {number} now @param {Next} next */
function checkDue(chat, { state, silent, starting }, now, next) {
	for (const entry of chat.pending.filter((p) => p.giveUpAt !== undefined && p.giveUpAt <= now)) {
		entry.giveUpAt = undefined;
		if (starting) continue;
		const verdict = checkPending(chat, entry, state, silent);
		if (verdict === "wait" && silent) entry.giveUpAt = now + PROMPT_GIVE_UP_MS;
		else if (verdict === "drop") next.dropped = true;
		else if (verdict === "fail") next.returned.push({ entry, reason: "not_delivered" });
	}
}

/** @param {Chat} chat @returns {number | undefined} */
export function nextGiveUp(chat) {
	const times = chat.pending.flatMap((p) => (p.giveUpAt === undefined ? [] : [p.giveUpAt]));
	return times.length ? Math.min(...times) : undefined;
}
