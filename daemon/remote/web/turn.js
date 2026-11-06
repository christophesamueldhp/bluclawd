// @ts-check
/**
 * A turn's time in a Chat, and what the composer's one round button does. Pure, so the tests
 * import it.
 */

/** @typedef {{ kind: string, id: string, at?: string }} Timed */

/** How long after a send the round button stays off before it may become Stop. */
export const STOP_GUARD_MS = 1000;

/** `45s`, `3m 07s`, `1h 05m`. @param {number} ms */
export function duration(ms) {
	const seconds = Math.floor(Math.max(0, ms) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Each ended turn's length, by the id of its last message: from its prompt to the last message
 * before the next one. The last turn has not ended while its session works.
 * @param {Timed[]} messages @param {boolean} working @returns {Map<string, number>}
 */
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

/**
 * When the turn in progress began: the latest prompt that started one, the transcript's or one sent
 * from here that pi took before the transcript has it.
 * @param {Timed[]} messages @param {{ sentAt: number, outcome?: string }[]} [pending]
 */
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

/**
 * What the round button does: send what is typed, queue it mid-turn, or stop the turn when nothing
 * is typed; off while nothing can be sent, and for a moment after a send, so a second tap does not
 * stop the turn just started.
 * @param {{ content: boolean, turn: boolean, open: boolean, sentAt: number | undefined, now: number }} at
 * @returns {"send" | "queue" | "stop" | "off"}
 */
export function composerAction({ content, turn, open, sentAt, now }) {
	if (!open) return "off";
	if (content) return turn ? "queue" : "send";
	if (!turn || (sentAt !== undefined && now - sentAt < STOP_GUARD_MS)) return "off";
	return "stop";
}
