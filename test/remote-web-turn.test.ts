import { describe, expect, it } from "vitest";
import { composerAction, duration, STOP_GUARD_MS, turnSince, turnTimes } from "#remote-web/turn.js";

const at = (minute: number, second = 0) =>
	`2026-11-06T10:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
const user = (id: string, minute: number) => ({ kind: "user", id, text: "hi", at: at(minute) });
const reply = (id: string, minute: number, second = 0) => ({
	kind: "assistant",
	id,
	text: "ok",
	tools: [],
	at: at(minute, second),
});

describe("a turn's time on the phone", () => {
	it("reads as T3 Code's timers do", () => {
		expect(duration(0)).toBe("0s");
		expect(duration(45_400)).toBe("45s");
		expect(duration(187_000)).toBe("3m 07s");
		expect(duration(3_900_000)).toBe("1h 05m");
	});

	it("is from each prompt to the last message before the next, once that turn has ended", () => {
		const messages = [user("u1", 0), reply("a1", 1), reply("a2", 3, 12), user("u2", 5), reply("a3", 6)];
		expect(turnTimes(messages, false)).toEqual(
			new Map([
				["a2", 192_000],
				["a3", 60_000],
			]),
		);
		// The last turn is still going while its session works.
		expect(turnTimes(messages, true)).toEqual(new Map([["a2", 192_000]]));
	});

	it("leaves out a turn whose times are unknown, or that said nothing after its prompt", () => {
		const old = [{ kind: "user", id: "u1", text: "hi" }, reply("a1", 1)];
		expect(turnTimes(old, false)).toEqual(new Map());
		expect(turnTimes([user("u1", 0), user("u2", 1)], false)).toEqual(new Map());
	});

	it("runs from the last prompt while the session works", () => {
		expect(turnSince([user("u1", 0), reply("a1", 1), user("u2", 5), reply("a2", 6)])).toBe(at(5));
		expect(turnSince([reply("a1", 1)])).toBeUndefined();
	});
});

describe("the composer's round button", () => {
	const base = { content: false, turn: false, open: true, sentAt: undefined, now: 10_000 };

	it("sends what is typed, and stays off with nothing to send", () => {
		expect(composerAction({ ...base, content: true })).toBe("send");
		expect(composerAction(base)).toBe("off");
	});

	it("queues what is typed mid-turn, and stops the turn when nothing is", () => {
		expect(composerAction({ ...base, turn: true, content: true })).toBe("queue");
		expect(composerAction({ ...base, turn: true })).toBe("stop");
	});

	it("does not turn into Stop under the thumb right after a send", () => {
		const sent = { ...base, turn: true, sentAt: 10_000 };
		expect(composerAction({ ...sent, now: 10_000 + STOP_GUARD_MS - 1 })).toBe("off");
		expect(composerAction({ ...sent, now: 10_000 + STOP_GUARD_MS })).toBe("stop");
	});

	it("is off while the Chat may not act", () => {
		expect(composerAction({ ...base, open: false, content: true })).toBe("off");
		expect(composerAction({ ...base, open: false, turn: true })).toBe("off");
	});
});
