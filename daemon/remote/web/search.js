// @ts-check
/** @typedef {import("./app.js").Session} Session */

/**
 * The rows a search of the session list keeps: those whose name, directory or detail has the
 * query in it, whatever the case. An empty query keeps them all.
 * @param {Session[]} sessions @param {string} query @returns {Session[]}
 */
export function filterSessions(sessions, query) {
	const wanted = query.trim().toLowerCase();
	if (!wanted) return sessions;
	return sessions.filter((s) => [s.label, s.cwd, s.detail].some((field) => field?.toLowerCase().includes(wanted)));
}
