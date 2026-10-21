// @ts-check
/** @typedef {import("./app.js").Session} Session */

/**
 * When a row's age counts from. A live row's `finishedAt` is its last entry's time, which says
 * when it went quiet only once it has: a row that is working or waits on an answer counts from
 * when it started. Pure, so the tests import it.
 * @param {Session} session @returns {string | undefined}
 */
export function ageAt(session) {
	const quiet = session.state !== "working" && session.state !== "needs";
	return (quiet ? session.finishedAt : undefined) ?? session.createdAt;
}

export const STATE_WORDS = {
	working: "Working",
	needs: "Needs input",
	idle: "Idle",
	done: "Done",
	failed: "Failed",
	stopped: "Stopped",
};

/** The same live, working and disconnected glyphs as terminal agent view. @param {Session} session */
export function statusGlyph(session) {
	return !session.alive ? "∙" : session.state === "working" ? "" : "✻";
}

/**
 * The row an open chat moves to once its own is gone from the list: the same pi session under
 * another row id (it quit on the Mac and is stored now, or it resumed in a new pane).
 * @param {Session[]} sessions @param {string} open its row id @param {string | undefined} sessionId pi's id, as last listed
 * @returns {string | undefined}
 */
export function successor(sessions, open, sessionId) {
	if (!sessionId || sessions.some((s) => s.id === open)) return undefined;
	return sessions.find((s) => s.sessionId === sessionId)?.id;
}
