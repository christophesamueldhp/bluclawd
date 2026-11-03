import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteEvents } from "../daemon/remote/events.ts";

/** A stream's response: what was written to it. */
function response() {
	const written: string[] = [];
	const res = {
		writeHead: () => res,
		write: (chunk: string) => written.push(chunk),
		end: () => undefined,
		on: () => res,
	};
	return { res: res as unknown as ServerResponse, events: () => written.filter((w) => w.startsWith("event: ")) };
}

describe("remote event stream", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("looks a session up once a tick, however many clients have it open", () => {
		let leaf = "a";
		const session = vi.fn((_id: string) => ({ leafId: leaf }));
		const sessionsSignature = vi.fn(() => "same");
		const events = new RemoteEvents({
			sessionsSignature,
			session,
			listed: () => new Set(["s1", "s2"]),
			outcomes: () => [],
		});
		const clients = [response(), response(), response(), response()];
		for (const [i, { res }] of clients.entries()) events.add(res, i < 3 ? "s1" : "s2");
		session.mockClear();
		sessionsSignature.mockClear();
		vi.advanceTimersByTime(1000);
		expect(session.mock.calls.map(([id]) => id)).toEqual(["s1", "s2"]);
		expect(sessionsSignature).toHaveBeenCalledTimes(1);
		leaf = "b";
		vi.advanceTimersByTime(1000);
		for (const [i, client] of clients.entries()) {
			const sessionId = i < 3 ? "s1" : "s2";
			expect(client.events(), `client ${i}`).toEqual([
				// Sent as it opened: what the daemon knows of the phone's prompts to it.
				`event: outcomes\ndata: ${JSON.stringify({ sessionId, outcomes: [] })}\n\n`,
				`event: messages\ndata: ${JSON.stringify({ sessionId })}\n\n`,
			]);
		}
		events.close();
	});
});
