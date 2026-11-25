// @ts-check
import { storedPending } from "./chat.js";

/** @typedef {import("./chat.js").Chat} Chat @typedef {import("./chat.js").Pending} Pending */
/** @typedef {Omit<Pending, "sameTextBefore" | "lastIdWhenSent" | "sawWorking"> & { before: number, last: string, started?: true }} StoredPending */

const PENDING_KEY_PREFIX = "bluclawd-pending:";
const DRAFT_KEY_PREFIX = "bluclawd-draft:";
const SKILLS_KEY_PREFIX = "bluclawd-draft-skills:";

/** @param {Pending} entry @returns {StoredPending} */
function toStored({ sameTextBefore, lastIdWhenSent, sawWorking, ...rest }) {
	return { ...rest, before: sameTextBefore, last: lastIdWhenSent, ...(sawWorking ? { started: true } : {}) };
}

/** @param {StoredPending} entry @returns {Pending} */
function fromStored({ before, last, started, ...rest }) {
	return { ...rest, sameTextBefore: before, lastIdWhenSent: last, ...(started ? { sawWorking: true } : {}) };
}

/**
 * `storage`: asked for at each use, as a read of `localStorage` throws where it is blocked.
 * @param {() => Storage} storage
 */
export function pendingStore(storage) {
	let lastSavedWithoutImages = "";
	/** @param {string} id */
	const forgetPendingWhenFull = (id) => {
		try {
			storage().removeItem(PENDING_KEY_PREFIX + id);
		} catch {}
	};
	return {
		/** @param {string} id @returns {Pending[]} */
		load(id) {
			try {
				const stored = JSON.parse(storage().getItem(PENDING_KEY_PREFIX + id) ?? "[]");
				return Array.isArray(stored) ? stored.map(fromStored) : [];
			} catch {
				return [];
			}
		},
		/** @param {Chat} chat */
		save(chat) {
			const pending = storedPending(chat).map(toStored);
			const kept = `${chat.id}\n${JSON.stringify(pending.map(({ images: _, ...entry }) => entry))}`;
			if (kept === lastSavedWithoutImages) return;
			lastSavedWithoutImages = kept;
			try {
				if (pending.length) storage().setItem(PENDING_KEY_PREFIX + chat.id, JSON.stringify(pending));
				else storage().removeItem(PENDING_KEY_PREFIX + chat.id);
			} catch {
				forgetPendingWhenFull(chat.id);
			}
		},
		/** @param {string} id */
		draft(id) {
			try {
				return storage().getItem(DRAFT_KEY_PREFIX + id) ?? "";
			} catch {
				return "";
			}
		},
		/** @param {string} id @returns {import("./skills.js").Selection[]} */
		draftSkills(id) {
			try {
				const stored = JSON.parse(storage().getItem(SKILLS_KEY_PREFIX + id) ?? "[]");
				return Array.isArray(stored) ? stored : [];
			} catch {
				return [];
			}
		},
		/** @param {string} id @param {string} text @param {import("./skills.js").Selection[]} [selections] */
		saveDraft(id, text, selections = []) {
			try {
				if (selections.length) storage().setItem(SKILLS_KEY_PREFIX + id, JSON.stringify(selections));
				else storage().removeItem(SKILLS_KEY_PREFIX + id);
				if (text) storage().setItem(DRAFT_KEY_PREFIX + id, text);
				else storage().removeItem(DRAFT_KEY_PREFIX + id);
			} catch {}
		},
		/** @param {string[]} ids */
		prune(ids) {
			try {
				const listed = new Set(
					ids.flatMap((id) => [PENDING_KEY_PREFIX + id, DRAFT_KEY_PREFIX + id, SKILLS_KEY_PREFIX + id]),
				);
				const keys = [];
				for (let i = 0; i < storage().length; i++) keys.push(storage().key(i));
				for (const key of keys) {
					if (
						(key?.startsWith(PENDING_KEY_PREFIX) ||
							key?.startsWith(DRAFT_KEY_PREFIX) ||
							key?.startsWith(SKILLS_KEY_PREFIX)) &&
						!listed.has(key)
					)
						storage().removeItem(key);
				}
			} catch {}
		},
	};
}
