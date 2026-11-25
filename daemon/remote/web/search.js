// @ts-check
/** @typedef {import("./app.js").Session} Session */
/** @typedef {import("./statusbar.js").Command} Command */

/** @param {string} text */
export function fold(text) {
	return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** @param {string} text */
const wordsOf = (text) =>
	fold(text)
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);

/** @param {Session[]} sessions @param {string} query @returns {Session[]} */
export function filterSessions(sessions, query) {
	const words = wordsOf(query);
	if (!words.length) return sessions;
	return sessions.filter((s) => {
		const cwd = (s.cwd ?? "").replace(/^\/(Users|home)\/[^/]+/, "");
		const starts = [...wordsOf(s.label ?? ""), ...wordsOf(s.detail ?? ""), ...wordsOf(cwd)];
		return words.every((word) => starts.some((p) => p.startsWith(word)));
	});
}

const COMMANDS_SHOWN = 6;
const MAC_ONLY_COMMANDS = ["remote-control", "agent-view", "exit"];

/** @param {Command[] | undefined} commands @param {string} text @returns {Command[]} */
export function matchCommands(commands, text) {
	const typed = /^\/(\S*)$/.exec(text);
	if (!typed || !commands) return [];
	const wanted = fold(typed[1]);
	return commands
		.filter((c) => {
			const name = fold(c.name.replace(/^\//, ""));
			return name.startsWith(wanted) && !MAC_ONLY_COMMANDS.includes(name);
		})
		.slice(0, COMMANDS_SHOWN);
}
