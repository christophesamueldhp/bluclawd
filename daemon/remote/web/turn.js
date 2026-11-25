// @ts-check

/** @typedef {{ kind: string, id: string, at?: string }} Timed */

export const SECOND_TAP_GUARD_MS = 1000;

/** @param {number} ms */
export function duration(ms) {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** @param {Timed[]} messages @param {boolean} working @returns {Map<string, number>} */
export function turnTimes(messages, working) {
	/** @type {Map<string, number>} */
	const times = new Map();
	/** @type {number | undefined} */
	let start;
	/** @type {Timed | undefined} */
	let last;
	const end = () => {
		const until = last?.at ? Date.parse(last.at) : Number.NaN;
		if (last && start !== undefined && Number.isFinite(until)) times.set(last.id, until - start);
		last = undefined;
	};
	for (const m of messages) {
		if (m.kind === "user") {
			end();
			const at = m.at ? Date.parse(m.at) : Number.NaN;
			start = Number.isFinite(at) ? at : undefined;
		} else last = m;
	}
	if (!working) end();
	return times;
}

/** @param {Timed[]} messages @param {{ sentAt: number, outcome?: string }[]} [pending] */
export function turnSince(messages, pending = []) {
	let latest = Number.NEGATIVE_INFINITY;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].kind !== "user") continue;
		const at = messages[i].at;
		if (at) latest = Date.parse(at);
		break;
	}
	for (const p of pending) if (p.outcome === "taken") latest = Math.max(latest, p.sentAt);
	return Number.isFinite(latest) ? new Date(latest).toISOString() : undefined;
}

/** @param {{ content: boolean, turn: boolean, open: boolean, sentAt: number | undefined, now: number }} at @returns {"send" | "queue" | "stop" | "off"} */
export function composerAction({ content, turn, open, sentAt, now }) {
	if (!open) return "off";
	if (content) return turn ? "queue" : "send";
	if (!turn || (sentAt !== undefined && now - sentAt < SECOND_TAP_GUARD_MS)) return "off";
	return "stop";
}
