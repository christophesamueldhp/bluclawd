import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundJobInfo } from "../ext/_shared/background-bash.ts";
import { splitLines } from "../ext/_shared/lines.ts";
import {
	EventBatcher,
	monitorEndMessage,
	monitorEventMessage,
	RateLimiter,
	shouldNotifyExit,
	tailOutput,
	taskExitMessage,
} from "../ext/_shared/monitor-events.ts";

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

	it("keeps only the text after the last bare \\r in a completed line", () => {
		expect(splitLines("", "p 1%\rp 2%\n")).toEqual({ lines: ["p 2%"], carry: "" });
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
		batcher.push(["c"]);
		vi.advanceTimersByTime(200);
		expect(flushed).toEqual([
			{ lines: ["a", "b"], more: 0 },
			{ lines: ["c"], more: 0 },
		]);
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

	it("keeps content when the first pending line alone exceeds maxBytes", () => {
		const flushed: unknown[] = [];
		const batcher = new EventBatcher({ delayMs: 200, maxBytes: 10, onFlush: (b) => flushed.push(b) });
		batcher.push(["y".repeat(50), "short"]);
		vi.advanceTimersByTime(200);
		expect(flushed).toEqual([{ lines: ["yyyyyyyyyy"], more: 1 }]);
	});

	it("take() returns what is pending, cancels the timer, and does not call onFlush", () => {
		const flushed: unknown[] = [];
		const batcher = new EventBatcher({ delayMs: 200, onFlush: (b) => flushed.push(b) });
		batcher.push(["a"]);
		expect(batcher.take()).toEqual({ lines: ["a"], more: 0 });
		vi.advanceTimersByTime(500);
		expect(flushed).toEqual([]);
		expect(batcher.take()).toEqual({ lines: [], more: 0 });
		batcher.push(["b"]);
		vi.advanceTimersByTime(200);
		expect(flushed).toEqual([{ lines: ["b"], more: 0 }]);
	});
});

describe("RateLimiter", () => {
	it("trips on the event past the limit within the window", () => {
		const limiter = new RateLimiter({ max: 3, windowMs: 1000 });
		expect(limiter.record(0)).toBe(false);
		expect(limiter.record(100)).toBe(false);
		expect(limiter.record(200)).toBe(false);
		expect(limiter.record(300)).toBe(true);
	});

	it("forgets events that left the window", () => {
		const limiter = new RateLimiter({ max: 3, windowMs: 1000 });
		limiter.record(0);
		limiter.record(100);
		limiter.record(200);
		expect(limiter.record(1150)).toBe(false);
	});
});

describe("tailOutput", () => {
	it("keeps the last maxLines lines", () => {
		expect(tailOutput("a\nb\nc\nd\n", 2, 1000)).toBe("c\nd");
	});

	it("keeps the last maxBytes bytes on a line boundary", () => {
		expect(tailOutput("aaaa\nbbbb\ncc", 10, 8)).toBe("bbbb\ncc");
	});

	it("keeps the end of a single line that alone exceeds maxBytes", () => {
		expect(tailOutput("x".repeat(100), 10, 20)).toBe("x".repeat(20));
	});

	it("keeps interior blank lines", () => {
		expect(tailOutput("FAIL\n\n  at foo\n", 10, 100)).toBe("FAIL\n\n  at foo");
	});

	it("strips CRLF line endings", () => {
		expect(tailOutput("a\r\n\r\n\r\n", 10, 100)).toBe("a");
	});

	it("returns an empty string for no output", () => {
		expect(tailOutput("", 20, 2048)).toBe("");
	});
});

const monitorJob: BackgroundJobInfo = {
	id: "bash_3",
	command: "tail -f x.log",
	description: "errors in deploy.log",
	cwd: "/",
	startedAt: 0,
	killed: false,
	kind: "monitor",
	events: 0,
};

describe("message builders", () => {
	it("monitorEventMessage is self-describing and lists the lines", () => {
		const msg = monitorEventMessage(monitorJob, { lines: ["E1", "E2"], more: 0 });
		expect(msg.customType).toBe("bluclawd:monitor");
		expect(msg.content).toBe("[monitor bash_3 · errors in deploy.log]\nE1\nE2");
		expect(msg.details).toEqual({ id: "bash_3", description: "errors in deploy.log", lines: ["E1", "E2"], more: 0 });
	});

	it("monitorEventMessage notes overflow", () => {
		const msg = monitorEventMessage(monitorJob, { lines: ["E1"], more: 7 });
		expect(msg.content).toContain("…and 7 more lines (read them with bash_output)");
	});

	it("monitorEndMessage carries leftover lines and the terminal status", () => {
		const ended = { ...monitorJob, exit: { code: 0, at: 1 } };
		const msg = monitorEndMessage(ended, { lines: ["last"], more: 0 });
		expect(msg.content).toBe("[monitor bash_3 · errors in deploy.log]\nlast\nexited with code 0");
		expect(msg.details).toMatchObject({ end: "exited with code 0", status: "success" });
	});

	it("monitorEndMessage colours a rate-limit stop as warning and an error as error", () => {
		const stopped = { ...monitorJob, killed: true, stopReason: "too many events", exit: { code: null, at: 1 } };
		expect(monitorEndMessage(stopped, { lines: [], more: 0 }).details).toMatchObject({ status: "warning" });
		const failed = { ...monitorJob, exit: { code: 2, at: 1 } };
		expect(monitorEndMessage(failed, { lines: [], more: 0 }).details).toMatchObject({ status: "error" });
	});

	it("taskExitMessage names the job, status, command and tail", () => {
		const job: BackgroundJobInfo = {
			...monitorJob,
			id: "bash_2",
			kind: "job",
			description: "build",
			command: "make",
			exit: { code: 1, at: 1 },
		};
		const msg = taskExitMessage(job, "err: boom");
		expect(msg.customType).toBe("bluclawd:task-exit");
		expect(msg.content).toBe("[task bash_2 · build] exited with code 1 — make\nerr: boom");
		expect(msg.details).toMatchObject({ status: "error" });
	});

	it("does not repeat the command in a task-exit head that has no description", () => {
		const job = { ...monitorJob, id: "bash_2", command: "make", description: undefined, exit: { code: 1, at: 1 } };
		expect(taskExitMessage(job, "").content).toBe("[task bash_2 · make] exited with code 1");
	});

	it("falls back to the command when there is no description", () => {
		const job = { ...monitorJob, description: undefined };
		expect(monitorEventMessage(job, { lines: ["x"], more: 0 }).content).toBe("[monitor bash_3 · tail -f x.log]\nx");
	});
});

describe("shouldNotifyExit", () => {
	const base: BackgroundJobInfo = {
		id: "bash_1",
		command: "x",
		cwd: "/",
		startedAt: 0,
		killed: false,
		kind: "job",
		events: 0,
	};
	it("notifies a normal exit, a failure and a timeout", () => {
		expect(shouldNotifyExit({ ...base, exit: { code: 0, at: 1 } })).toBe(true);
		expect(shouldNotifyExit({ ...base, exit: { code: null, error: "spawn ENOENT", at: 1 } })).toBe(true);
		expect(shouldNotifyExit({ ...base, exit: { code: null, error: "timeout:300", at: 1 } })).toBe(true);
	});
	it("stays quiet for a kill the model asked for", () => {
		expect(shouldNotifyExit({ ...base, killed: true, exit: { code: null, at: 1 } })).toBe(false);
	});
	it("still notifies a registry-initiated stop", () => {
		expect(
			shouldNotifyExit({ ...base, killed: true, stopReason: "too many events", exit: { code: null, at: 1 } }),
		).toBe(true);
	});
});
