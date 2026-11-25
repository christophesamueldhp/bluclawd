// @ts-check
/** @typedef {import("./app.js").Session} Session */

/** @param {Session | undefined} session */
export function midTurn(session) {
	return session?.state === "working" || session?.state === "needs";
}

/** @param {Session} session */
export function rowTone(session) {
	return session.state === "stopped" || !session.alive || session.silent ? "off" : session.state;
}

/** @param {Session} session @returns {string | undefined} */
export function ageAt(session) {
	return (midTurn(session) ? session.turnStartedAt : session.finishedAt) ?? session.createdAt;
}

/** @param {string | undefined} iso @param {number} now */
export function ageText(iso, now) {
	const ms = iso ? now - Date.parse(iso) : Number.NaN;
	if (!Number.isFinite(ms)) return "";
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** @typedef {{ since: string, at: Record<string, string> }} Seen */

/** @param {Session} session @param {Seen} seen */
export function isUnseen(session, seen) {
	if (midTurn(session) || !session.finishedAt) return false;
	return Date.parse(session.finishedAt) > Date.parse(seen.at[session.id] ?? seen.since);
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

/** @param {Session[]} sessions @param {ViewMode} mode @returns {{ title: string, rows: Session[] }[]} */
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

/** @param {Session} session */
export function statusGlyph(session) {
	return !session.alive ? "∙" : session.state === "working" ? "" : "✻";
}

/** @param {Session} session */
export function sharedWarning(session) {
	return session.livePanes ? `⚠ ${session.livePanes} panes on one session` : "";
}

const CLOSED = { silent: "Not responding", starting: "Starting…", not_running: "Disconnected" };

/** @param {Session} session @param {boolean} terminalOpen @returns {{ open: boolean, placeholder: string }} */
export function replyBox(session, terminalOpen) {
	const { verdict } = session;
	if (verdict.act === false) return { open: false, placeholder: CLOSED[verdict.reason] };
	return terminalOpen ? { open: true, placeholder: "Reply" } : { open: false, placeholder: "Read only" };
}

/** @param {Session[]} sessions @param {string} id */
export function paneUp(sessions, id) {
	return sessions.some((s) => s.id === id && !s.starting);
}
