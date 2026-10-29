/**
 * Fails a test during which a faux provider is asked for a response with an empty queue. The provider would
 * answer with an error message and the test carry on, so an assertion could hold only because a run errored (#92).
 * Watches each provider's stream instead of its queue, so `getPendingResponseCount()` reports what it always did.
 */
import { afterEach, beforeEach, expect, vi } from "vitest";

const dry = vi.hoisted(() => new Set<string>());

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const pi = await importOriginal<typeof import("@earendil-works/pi-ai")>();
	return {
		...pi,
		fauxProvider: (...args: Parameters<typeof pi.fauxProvider>) => {
			const faux = pi.fauxProvider(...args);
			const { stream, streamSimple } = faux.provider;
			// The provider takes the next response in the same tick, so an empty queue now means none for this request.
			const noteIfDry = () => {
				const test = expect.getState().currentTestName;
				if (test && faux.getPendingResponseCount() === 0) dry.add(test);
			};
			faux.provider.stream = (...streamArgs) => {
				noteIfDry();
				return stream(...streamArgs);
			};
			faux.provider.streamSimple = (...streamArgs) => {
				noteIfDry();
				return streamSimple(...streamArgs);
			};
			return faux;
		},
	};
});

beforeEach(() => {
	dry.clear();
});

afterEach(() => {
	const test = expect.getState().currentTestName;
	if (test && dry.has(test)) throw new Error(`faux queue ran dry in "${test}"`);
});
