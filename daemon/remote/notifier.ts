/** Which session changes are worth a push: one that stops working, by finishing or by needing an answer. */
import type { RowState } from "../../ext/agent-view/rows.ts";
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
	private last = new Map<string, RowState>();

	/** What changed since the previous call; a session not seen before never notifies. */
	observe(sessions: RemoteSession[]): PushNotification[] {
		const notifications: PushNotification[] = [];
		const seen = new Map<string, RowState>();
		for (const session of sessions) {
			seen.set(session.id, session.state);
			const word = WORDS[session.state];
			if (this.last.get(session.id) !== "working" || !word) continue;
			const body = session.detail ? `${word} — ${session.detail}` : word;
			notifications.push({
				title: capped(session.label, TITLE_MAX),
				body: capped(body, BODY_MAX),
				sessionId: session.id,
			});
		}
		this.last = seen;
		return notifications;
	}
}
