/** Which session changes are worth a push: one that stops working, by finishing or by needing an answer. */
import type { RowState } from "../../ext/agent-view/rows.ts";
import type { RemoteSession } from "./sessions.ts";

export interface PushNotification {
	title: string;
	body: string;
	sessionId: string;
}

const BODY_MAX = 120;
const WORDS: Partial<Record<RowState, string>> = {
	needs: "Needs input",
	done: "Done",
	idle: "Done",
	failed: "Failed",
};

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
				title: session.label,
				body: body.length > BODY_MAX ? `${body.slice(0, BODY_MAX - 1)}…` : body,
				sessionId: session.id,
			});
		}
		this.last = seen;
		return notifications;
	}
}
