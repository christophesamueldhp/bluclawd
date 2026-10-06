import { describe, expect, it } from "vitest";
import { exitAction } from "../ext/agent-view/index.ts";

/** A normal session is the one `pi` started in this terminal, until ← moves it to the background. */
const normal = { normal: true, idle: true, empty: true, sincePrevious: Number.POSITIVE_INFINITY };
const background = { ...normal, normal: false };

describe("exit keys, as Claude Code", () => {
	it("ctrl+c while a turn runs stops the turn, in any session", () => {
		expect(exitAction("ctrl+c", { ...normal, idle: false })).toBe("abort");
		expect(exitAction("ctrl+c", { ...background, idle: false, sincePrevious: 100 })).toBe("abort");
	});

	it("ctrl+c twice when idle ends a normal session and detaches from a background one", () => {
		expect(exitAction("ctrl+c", normal)).toBe("first");
		expect(exitAction("ctrl+c", { ...normal, sincePrevious: 100 })).toBe("quit");
		expect(exitAction("ctrl+c", { ...background, sincePrevious: 100 })).toBe("detach");
		expect(exitAction("ctrl+c", { ...background, sincePrevious: 900 })).toBe("first");
	});

	it("ctrl+d twice on an empty prompt ends a normal session; a background session ignores it", () => {
		expect(exitAction("ctrl+d", normal)).toBe("first");
		expect(exitAction("ctrl+d", { ...normal, sincePrevious: 100 })).toBe("quit");
		expect(exitAction("ctrl+d", background)).toBe("ignore");
		// With text it is pi's delete-forward.
		expect(exitAction("ctrl+d", { ...normal, empty: false })).toBe("pass");
		expect(exitAction("ctrl+d", { ...background, empty: false })).toBe("pass");
	});

	it("exit words and /exit end a normal session and detach from a background one", () => {
		expect(exitAction("exit", normal)).toBe("quit");
		expect(exitAction("exit", background)).toBe("detach");
	});
});
