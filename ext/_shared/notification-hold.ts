/**
 * Background-task updates are held while the tasks panel is open and delivered
 * when it closes, so a notification cannot start a turn under the user's hands.
 * The panel and the senders live in separate module graphs, so the hold is a sharedRef.
 */

import { notifyListeners, sharedRef } from "./global-state.ts";

const state = sharedRef("notificationHold", {
	holds: 0,
	queue: [] as (() => void)[],
	listeners: new Set<() => void>(),
}).get();

function changed(): void {
	notifyListeners(state.listeners);
}

/** Holds updates until the returned release is called (once per hold). */
export function holdNotifications(): () => void {
	state.holds++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		state.holds--;
		if (state.holds > 0) return;
		for (const send of state.queue.splice(0)) {
			try {
				send();
			} catch {}
		}
		changed();
	};
}

/** Sends now, or once the hold is released. */
export function deliverOrHold(send: () => void): void {
	if (state.holds === 0) {
		send();
		return;
	}
	state.queue.push(send);
	changed();
}

export function heldNotifications(): number {
	return state.queue.length;
}

/** Called when an update is held or the held ones go out. Returns the unsubscribe. */
export function subscribeNotificationHold(listener: () => void): () => void {
	state.listeners.add(listener);
	return () => state.listeners.delete(listener);
}

export function heldNotificationsLine(count: number): string | undefined {
	if (count === 0) return undefined;
	return count === 1
		? "Background task update waiting while this panel is open"
		: `${count} background task updates waiting while this panel is open`;
}
