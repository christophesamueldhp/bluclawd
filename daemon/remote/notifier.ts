/** Which session changes are worth a push: one that stops working, by finishing or by needing an
 *  answer, and one that comes to need an answer from idle too. "Stops working" is seen working at
 *  the last look, or counted by the daemon as stopped since, as a turn too quick for a look is. */
import type { RowState } from "../rows.ts";
import type { RemoteSession } from "./sessions.ts";

export interface PushNotification {
	title: string;
	body: string;
	sessionId: string;
}

const TITLE_MAX = 60;
const BODY_MAX = 120;
const WORDS: Partial<Record<RowState, string>> = {
	needs: "Needs input",
	done: "Done",
	idle: "Done",
	failed: "Failed",
};

const capped = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export class Notifier {
	private last = new Map<string, { state: RowState; settled?: number }>();
	private looked = false;

	/** What changed since the previous call. A session not seen before notifies only once it has
	 *  stopped working (a first turn ended before any look), and never on the first call. */
	observe(sessions: RemoteSession[]): PushNotification[] {
		const notifications: PushNotification[] = [];
		const seen = new Map<string, { state: RowState; settled?: number }>();
		for (const session of sessions) {
			seen.set(session.id, { state: session.state, settled: session.settled });
			const word = WORDS[session.state];
			const was = this.last.get(session.id);
			const asks = session.state === "needs" && was !== undefined && was.state !== "needs";
			// Stopped working since the last look: a turn too quick for any look to see working.
			const stopped = was
				? (session.settled ?? 0) > (was.settled ?? Number.POSITIVE_INFINITY)
				: this.looked && (session.settled ?? 0) > 0;
			if (!word || (was?.state !== "working" && !asks && !stopped)) continue;
			const body = session.detail ? `${word} — ${session.detail}` : word;
			notifications.push({
				title: capped(session.label, TITLE_MAX),
				body: capped(body, BODY_MAX),
				sessionId: session.id,
			});
		}
		this.last = seen;
		this.looked = true;
		return notifications;
	}
}
