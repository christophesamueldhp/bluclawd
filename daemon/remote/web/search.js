// @ts-check
/** @typedef {import("./app.js").Session} Session */
/** @typedef {import("./statusbar.js").Command} Command */

/** Lower case, without accents: "Café" and "cafe" are the same word. @param {string} text */
export function fold(text) {
	return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** A text's words, folded: what a search matches the start of. @param {string} text */
const wordsOf = (text) =>
	fold(text)
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);

/**
 * The rows a search of the session list keeps: those where every word of the query starts a word
 * of the name, the detail or the directory, whatever the case and accents, as iOS's own searches
 * match. Not anywhere in a word: a first letter would keep nearly every row, its last message
 * having that letter somewhere. The directory is taken without the home folder. An empty query
 * keeps them all, in their order.
 * @param {Session[]} sessions @param {string} query @returns {Session[]}
 */
export function filterSessions(sessions, query) {
	const words = wordsOf(query);
	if (!words.length) return sessions;
	return sessions.filter((s) => {
		const cwd = (s.cwd ?? "").replace(/^\/(Users|home)\/[^/]+/, "");
		const starts = [...wordsOf(s.label ?? ""), ...wordsOf(s.detail ?? ""), ...wordsOf(cwd)];
		return words.every((word) => starts.some((p) => p.startsWith(word)));
	});
}

/** Suggested at most at once, above the reply box. */
const COMMANDS_SHOWN = 6;

/**
 * The session's commands a reply box starting with "/" suggests: those whose name starts with
 * what is typed after it, while the command's name is all there is. Those the phone does not send
 * (refused() in live.js), and /exit, which the Mac refuses from it, are not offered.
 * @param {Command[] | undefined} commands @param {string} text @returns {Command[]}
 */
export function matchCommands(commands, text) {
	const typed = /^\/(\S*)$/.exec(text);
	if (!typed || !commands) return [];
	const wanted = fold(typed[1]);
	return commands
		.filter((c) => {
			const name = fold(c.name.replace(/^\//, ""));
			return name.startsWith(wanted) && !["remote-control", "agent-view", "exit"].includes(name);
		})
		.slice(0, COMMANDS_SHOWN);
}
