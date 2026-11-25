import { describe, expect, it } from "vitest";
import { exitAction } from "../ext/agent-view/index.ts";

const normal = { normal: true, idle: true, empty: true, sincePrevious: Number.POSITIVE_INFINITY };
const background = { ...normal, normal: false };

describe("exit keys, as bluclawd", () => {
	it("ctrl+c while a turn runs stops the turn, in any session", () => {
		expect(exitAction("ctrl+c", { ...normal, idle: false })).toBe("stopTurn");
		expect(exitAction("ctrl+c", { ...background, idle: false, sincePrevious: 100 })).toBe("stopTurn");
	});

	it("ctrl+c twice when idle ends a normal session and detaches from a background one", () => {
		expect(exitAction("ctrl+c", normal)).toBe("armSecondPress");
		expect(exitAction("ctrl+c", { ...normal, sincePrevious: 100 })).toBe("endSession");
		expect(exitAction("ctrl+c", { ...background, sincePrevious: 100 })).toBe("detach");
		expect(exitAction("ctrl+c", { ...background, sincePrevious: 900 })).toBe("armSecondPress");
	});

	it("ctrl+d twice on an empty prompt ends a normal session; one press detaches from a background one", () => {
		expect(exitAction("ctrl+d", normal)).toBe("armSecondPress");
		expect(exitAction("ctrl+d", { ...normal, sincePrevious: 100 })).toBe("endSession");
		expect(exitAction("ctrl+d", background)).toBe("detach");
		expect(exitAction("ctrl+d", { ...normal, empty: false })).toBe("passToPi");
		expect(exitAction("ctrl+d", { ...background, empty: false })).toBe("passToPi");
	});

	it("exit words and /exit end a normal session and detach from a background one", () => {
		expect(exitAction("exit", normal)).toBe("endSession");
		expect(exitAction("exit", background)).toBe("detach");
	});
});
