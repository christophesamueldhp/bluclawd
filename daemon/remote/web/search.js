// @ts-check
/** @typedef {import("./app.js").Session} Session */
/** @typedef {import("./statusbar.js").Command} Command */

/** Lower case, without accents: "Café" and "cafe" are the same word. @param {string} text */
export function fold(text) {
	return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * The rows a search of the session list keeps: those where every word of the query is in the
 * name or the detail, or starts a part of the directory, whatever the case and accents. The
 * directory is taken without the home folder, and only by its parts' starts: the full path of every
 * session has nearly every letter in it, so a first letter would keep them all. An empty query
 * keeps them all, in their order.
 * @param {Session[]} sessions @param {string} query @returns {Session[]}
 */
export function filterSessions(sessions, query) {
	const words = fold(query).split(/\s+/).filter(Boolean);
	if (!words.length) return sessions;
	return sessions.filter((s) => {
		const text = [fold(s.label ?? ""), fold(s.detail ?? "")];
		const parts = fold((s.cwd ?? "").replace(/^\/(Users|home)\/[^/]+/, "")).split(/[^\p{L}\p{N}]+/u);
		return words.every((word) => text.some((t) => t.includes(word)) || parts.some((p) => p.startsWith(word)));
	});
}

/** Suggested at most at once, above the reply box. */
const COMMANDS_SHOWN = 6;

/**
 * The session's commands a reply box starting with "/" suggests: those whose name starts with
 * what is typed after it, while the command's name is all there is. The phone's own refusals
 * (refused() in live.js) are not offered.
 * @param {Command[] | undefined} commands @param {string} text @returns {Command[]}
 */
export function matchCommands(commands, text) {
	const typed = /^\/(\S*)$/.exec(text);
	if (!typed || !commands) return [];
	const wanted = fold(typed[1]);
	return commands
		.filter((c) => {
			const name = fold(c.name.replace(/^\//, ""));
			return name.startsWith(wanted) && name !== "remote-control" && name !== "agent-view";
		})
		.slice(0, COMMANDS_SHOWN);
}
