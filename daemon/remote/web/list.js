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

/** @typedef {"state" | "directory"} ViewMode */

/** @param {string | null} value @returns {ViewMode} */
export function viewMode(value) {
	return value === "directory" ? "directory" : "state";
}

/**
 * Pinned sessions stay first in either view, as in terminal agent view.
 * @param {Session[]} sessions @param {ViewMode} mode
 * @returns {{ title: string, rows: Session[] }[]}
 */
export function sessionGroups(sessions, mode) {
	const pinned = sessions.filter((s) => s.band === "pinned");
	const rest = sessions.filter((s) => s.band !== "pinned");
	const groups = pinned.length ? [{ title: "Pinned", rows: pinned }] : [];
	if (mode === "state") {
		for (const key of ["needs", "working", "idle"]) {
			const rows = rest.filter((s) => s.band === key);
			if (rows.length) groups.push({ title: STATE_WORDS[key], rows });
		}
	} else {
		const paths = [...new Set(rest.map((s) => s.cwd))].sort((a, b) => a.localeCompare(b));
		for (const path of paths) groups.push({ title: path, rows: rest.filter((s) => s.cwd === path) });
	}
	return groups;
}

/** The same live, working and disconnected glyphs as terminal agent view. @param {Session} session */
export function statusGlyph(session) {
	return !session.alive ? "∙" : session.state === "working" ? "" : "✻";
}

/** Terminal agent view's warning for a session file several live panes write. @param {Session} session */
export function sharedWarning(session) {
	return session.livePanes ? `⚠ ${session.livePanes} panes on one session` : "";
}

/**
 * A session the phone can prompt or change: running and answering (the Mac refuses what is sent to
 * a silent one), with a terminal on the Mac showing pi (`terminalOpen`).
 * @param {Session | undefined} session @param {boolean} terminalOpen
 */
export function actable(session, terminalOpen) {
	return session?.alive === true && !session.silent && terminalOpen;
}

/** A session started from here is up: its row is listed, no longer starting. @param {Session[]} sessions @param {string} id */
export function paneUp(sessions, id) {
	return sessions.some((s) => s.id === id && !s.starting);
}
