// @ts-check
/**
 * @typedef {import("./app.js").Session} Session
 * @typedef {"message" | "settings" | "rename" | "pin" | "delete" | "tasks"} ChatAction
 */
import { ICONS } from "./icons.js";

/** @param {unknown} text */
function esc(text) {
	return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** @param {Session | undefined} session @param {ChatAction} action */
export function allows(session, action) {
	return session?.actions?.[action]?.act ?? false;
}

/** @param {Session | undefined} session */
export function pinHtml(session) {
	if (!allows(session, "pin")) return "";
	const pinned = session?.band === "pinned";
	return `<button class="icon-btn${pinned ? " on" : ""}" id="pin" aria-label="${pinned ? "Unpin" : "Pin to the top"}" aria-pressed="${pinned}">${pinned ? ICONS.pinned : ICONS.pin}</button>`;
}

/** @param {Session | undefined} session */
export function renameHtml(session) {
	if (!allows(session, "rename")) return "";
	return `<form class="rename" id="rename-form"><label for="rename">Name</label>
<input id="rename" value="${esc(session?.label ?? "")}" maxlength="100" autocomplete="off" enterkeyhint="done">
<button class="save" id="rename-save" aria-label="Save name">${ICONS.check}</button></form>`;
}

/** @param {Session | undefined} session @param {boolean} confirming */
export function deleteHtml(session, confirming) {
	if (!allows(session, "delete")) return "";
	const remove = confirming
		? `<div class="confirm-delete"><span>Delete it from the list? Its session file stays on the Mac.</span>
<button class="unpair cancel" id="delete-cancel">Cancel</button><button class="unpair" id="delete-confirm">Delete</button></div>`
		: `<button class="action danger" id="delete">Delete<small>Off the list; its session file stays on the Mac.</small></button>`;
	return `<div class="actions">${remove}</div>`;
}
