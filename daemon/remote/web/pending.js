// @ts-check
/**
 * Each chat's pending prompts, kept in browser storage so that a reload, or a return to the chat,
 * still settles them (see restorePending), until its row leaves the session list.
 */
import { storedPending } from "./chat.js";

/** @typedef {import("./chat.js").Chat} Chat @typedef {import("./chat.js").Pending} Pending */

/** Followed by a session's row id: its pending prompts. */
const KEY = "bluclawd-pending:";

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
		/** Only those of the rows listed: the others were deleted. @param {string[]} ids */
		prune(ids) {
			try {
				const listed = new Set(ids.map((id) => KEY + id));
				const keys = [];
				for (let i = 0; i < storage().length; i++) keys.push(storage().key(i));
				for (const key of keys) if (key?.startsWith(KEY) && !listed.has(key)) storage().removeItem(key);
			} catch {}
		},
	};
}
