// @ts-check
/**
 * What a Chat's status sheet builds to change its session: each control only when the daemon's Chat
 * verdict on its row allows that kind of action. Pure, so the tests import it.
 * @typedef {import("./app.js").Session} Session
 * @typedef {"message" | "settings" | "rename" | "pin" | "delete" | "tasks"} ChatAction
 */
import { ICONS } from "./icons.js";

/** @param {unknown} text */
function esc(text) {
	return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * What the phone built before the daemon listed its answers, for a daemon that lists none (an
 * older build serving this app): rename, pin and the settings always, delete once no pane runs it.
 * @type {Record<ChatAction, (session: Session, terminalOpen: boolean) => boolean>}
 */
const BEFORE = {
	message: (s, terminalOpen) => s.verdict.act && terminalOpen,
	settings: () => true,
	rename: () => true,
	pin: () => true,
	delete: (s) => !s.alive,
	tasks: (s, terminalOpen) => s.verdict.act && terminalOpen,
};

/**
 * Whether the daemon's Chat verdict on the row allows this kind of action. `terminalOpen` only
 * counts for a daemon that lists no verdicts (BEFORE): one that does says it in each.
 * @param {Session | undefined} session @param {boolean} terminalOpen @param {ChatAction} action
 */
export function allows(session, terminalOpen, action) {
	if (!session) return false;
	const verdict = session.actions?.[action];
	return verdict ? verdict.act : BEFORE[action](session, terminalOpen);
}

/** The sheet's pin button. @param {Session | undefined} session @param {boolean} terminalOpen */
export function pinHtml(session, terminalOpen) {
	if (!allows(session, terminalOpen, "pin")) return "";
	const pinned = session?.band === "pinned";
	return `<button class="icon-btn${pinned ? " on" : ""}" id="pin" aria-label="${pinned ? "Unpin" : "Pin to the top"}" aria-pressed="${pinned}">${pinned ? ICONS.pinned : ICONS.pin}</button>`;
}

/** The session's name, to edit. @param {Session | undefined} session @param {boolean} terminalOpen */
export function renameHtml(session, terminalOpen) {
	if (!allows(session, terminalOpen, "rename")) return "";
	return `<form class="rename" id="rename-form"><label for="rename">Name</label>
<input id="rename" value="${esc(session?.label ?? "")}" maxlength="100" autocomplete="off" enterkeyhint="done">
<button class="save" id="rename-save" aria-label="Save name">${ICONS.check}</button></form>`;
}

/**
 * Delete, which asks first (`confirming`).
 * @param {Session | undefined} session @param {boolean} terminalOpen @param {boolean} confirming
 */
export function deleteHtml(session, terminalOpen, confirming) {
	if (!allows(session, terminalOpen, "delete")) return "";
	const remove = confirming
		? `<div class="confirm-delete"><span>Delete it from the list? Its session file stays on the Mac.</span>
<button class="unpair cancel" id="delete-cancel">Cancel</button><button class="unpair" id="delete-confirm">Delete</button></div>`
		: `<button class="action danger" id="delete">Delete<small>Off the list; its session file stays on the Mac.</small></button>`;
	return `<div class="actions">${remove}</div>`;
}
