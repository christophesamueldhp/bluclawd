import { sharedRef } from "../_shared/global-state.ts";
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

export function setMainSession(sink: MainSessionSink): void {
	state.current = sink;
	for (const use of state.pending.splice(0)) {
		try {
			use(sink);
		} catch {}
	}
}

export function clearMainSession(): void {
	state.current = undefined;
}

export const mainSession: MainSessionSink = {
	sendMessage: (message, delivery) => withSink((sink) => sink.sendMessage(message, delivery)),
	appendEntry: (customType, data) => withSink((sink) => sink.appendEntry(customType, data)),
};
