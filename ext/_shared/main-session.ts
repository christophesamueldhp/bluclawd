/**
 * Where the main session's background jobs report to. pi rebuilds the session
 * runtime, extension instances included, on /clear (`/new`), /resume and fork,
 * and an instance's `pi` goes stale with the session it was made for. A job
 * outlives that switch (Claude Code keeps background shells across /clear), so
 * its notifications and session-log records go to whichever main session is
 * current, never to the `pi` that started it. Between the old session's end and
 * the new one's start they wait here.
 */

import { sharedRef } from "./global-state.ts";
import type { EventDelivery, OutgoingMessage } from "./monitor-events.ts";

export interface MainSessionSink {
	sendMessage(message: OutgoingMessage<unknown>, delivery: EventDelivery): void;
	appendEntry(customType: string, data: unknown): void;
}

const state = sharedRef("mainSession", {
	current: undefined as MainSessionSink | undefined,
	pending: [] as ((sink: MainSessionSink) => void)[],
}).get();

function withSink(use: (sink: MainSessionSink) => void): void {
	if (state.current) use(state.current);
	else state.pending.push(use);
}

/** The main session that is now current; what waited for it goes out. */
export function setMainSession(sink: MainSessionSink): void {
	state.current = sink;
	for (const use of state.pending.splice(0)) {
		try {
			use(sink);
		} catch {}
	}
}

/** The main session is ending: hold what arrives until the next one starts. */
export function clearMainSession(): void {
	state.current = undefined;
}

export const mainSession: MainSessionSink = {
	sendMessage: (message, delivery) => withSink((sink) => sink.sendMessage(message, delivery)),
	appendEntry: (customType, data) => withSink((sink) => sink.appendEntry(customType, data)),
};
