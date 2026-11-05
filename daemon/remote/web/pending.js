// @ts-check
/**
 * Each chat's pending prompts, kept in browser storage so that a reload, or a return to the chat,
 * still settles them (see restorePending), and the text in its reply box not sent yet, a prompt put
 * back there too, until its row leaves the session list.
 */
import { storedPending } from "./chat.js";

/** @typedef {import("./chat.js").Chat} Chat @typedef {import("./chat.js").Pending} Pending */

/** Followed by a session's row id: its pending prompts. */
const KEY = "bluclawd-pending:";
/** Followed by a session's row id: its reply box's unsent text. */
const DRAFT_KEY = "bluclawd-draft:";
const SKILLS_KEY = "bluclawd-draft-skills:";

/**
 * `storage`: asked for at each use, as merely reading `localStorage` throws where it is blocked.
 * @param {() => Storage} storage
 */
export function pendingStore(storage) {
	/** What save last wrote, but the images: it writes again only when that changes. */
	let written = "";
	return {
		/** @param {string} id a session's row id @returns {Pending[]} */
		load(id) {
			try {
				const stored = JSON.parse(storage().getItem(KEY + id) ?? "[]");
				return Array.isArray(stored) ? stored : [];
			} catch {
				return [];
			}
		},
		/** @param {Chat} chat */
		save(chat) {
			const pending = storedPending(chat);
			const kept = `${chat.id}\n${JSON.stringify(pending.map(({ images: _, ...entry }) => entry))}`;
			if (kept === written) return;
			written = kept;
			try {
				if (pending.length) storage().setItem(KEY + chat.id, JSON.stringify(pending));
				else storage().removeItem(KEY + chat.id);
			} catch {
				// Full, with images most likely: better none kept than an older list, which would put back
				// prompts again.
				try {
					storage().removeItem(KEY + chat.id);
				} catch {}
			}
		},
		/** @param {string} id a session's row id */
		draft(id) {
			try {
				return storage().getItem(DRAFT_KEY + id) ?? "";
			} catch {
				return "";
			}
		},
		/** @param {string} id @returns {import("./skills.js").Selection[]} */
		draftSkills(id) {
			try {
				const stored = JSON.parse(storage().getItem(SKILLS_KEY + id) ?? "[]");
				return Array.isArray(stored) ? stored : [];
			} catch {
				return [];
			}
		},
		/** None kept once it is empty. @param {string} id a session's row id @param {string} text @param {import("./skills.js").Selection[]} [selections] */
		saveDraft(id, text, selections = []) {
			try {
				if (selections.length) storage().setItem(SKILLS_KEY + id, JSON.stringify(selections));
				else storage().removeItem(SKILLS_KEY + id);
				if (text) storage().setItem(DRAFT_KEY + id, text);
				else storage().removeItem(DRAFT_KEY + id);
			} catch {}
		},
		/** Only those of the rows listed: the others were deleted. @param {string[]} ids */
		prune(ids) {
			try {
				const listed = new Set(ids.flatMap((id) => [KEY + id, DRAFT_KEY + id, SKILLS_KEY + id]));
				const keys = [];
				for (let i = 0; i < storage().length; i++) keys.push(storage().key(i));
				for (const key of keys) {
					if (
						(key?.startsWith(KEY) || key?.startsWith(DRAFT_KEY) || key?.startsWith(SKILLS_KEY)) &&
						!listed.has(key)
					)
						storage().removeItem(key);
				}
			} catch {}
		},
	};
}
