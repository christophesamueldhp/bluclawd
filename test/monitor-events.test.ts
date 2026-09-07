import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splitLines } from "../ext/_shared/lines.ts";
import { EventBatcher } from "../ext/_shared/monitor-events.ts";

describe("splitLines", () => {
	it("returns whole lines and carries the partial tail", () => {
		expect(splitLines("", "a\nb\nc")).toEqual({ lines: ["a", "b"], carry: "c" });
	});

	it("prepends the previous carry to the next chunk", () => {
		expect(splitLines("c", "d\n")).toEqual({ lines: ["cd"], carry: "" });
	});

	it("strips a trailing carriage return", () => {
		expect(splitLines("", "a\r\nb\r\n")).toEqual({ lines: ["a", "b"], carry: "" });
	});

	it("drops empty lines", () => {
		expect(splitLines("", "\n\na\n\n")).toEqual({ lines: ["a"], carry: "" });
	});
});

describe("EventBatcher", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("delivers lines pushed within the window as one batch", () => {
		const flushed: unknown[] = [];
		const batcher = new EventBatcher({ delayMs: 200, onFlush: (b) => flushed.push(b) });
		batcher.push(["a"]);
		vi.advanceTimersByTime(100);
		batcher.push(["b"]);
		vi.advanceTimersByTime(100);
		expect(flushed).toEqual([{ lines: ["a", "b"], more: 0 }]);
	});

	it("caps a batch at maxLines and reports the remainder", () => {
		const flushed: unknown[] = [];
		const batcher = new EventBatcher({ delayMs: 200, maxLines: 2, onFlush: (b) => flushed.push(b) });
		batcher.push(["a", "b", "c", "d"]);
		vi.advanceTimersByTime(200);
		expect(flushed).toEqual([{ lines: ["a", "b"], more: 2 }]);
	});

	it("caps a batch at maxBytes", () => {
		const flushed: unknown[] = [];
		const batcher = new EventBatcher({ delayMs: 200, maxBytes: 5, onFlush: (b) => flushed.push(b) });
		batcher.push(["abc", "def", "g"]);
		vi.advanceTimersByTime(200);
		expect(flushed).toEqual([{ lines: ["abc"], more: 2 }]);
	});

	it("take() returns what is pending, cancels the timer, and does not call onFlush", () => {
		const flushed: unknown[] = [];
		const batcher = new EventBatcher({ delayMs: 200, onFlush: (b) => flushed.push(b) });
		batcher.push(["a"]);
		expect(batcher.take()).toEqual({ lines: ["a"], more: 0 });
		vi.advanceTimersByTime(500);
		expect(flushed).toEqual([]);
		expect(batcher.take()).toEqual({ lines: [], more: 0 });
	});
});
