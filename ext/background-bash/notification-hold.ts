import { notifyListeners, sharedRef } from "../_shared/global-state.ts";

const state = sharedRef("notificationHold", {
	holds: 0,
	queue: [] as (() => void)[],
	listeners: new Set<() => void>(),
}).get();

function changed(): void {
	notifyListeners(state.listeners);
}

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

export function deliverOrHold(sendIfStillValid: () => void): void {
	if (state.holds === 0) {
		sendIfStillValid();
		return;
	}
	state.queue.push(sendIfStillValid);
	changed();
}

export function heldNotifications(): number {
	return state.queue.length;
}

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
