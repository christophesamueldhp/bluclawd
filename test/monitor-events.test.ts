import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundJobInfo } from "../ext/_shared/background-bash.ts";
import { splitLines } from "../ext/_shared/lines.ts";
import {
	EventBatcher,
	eventText,
	formatDuration,
	monitorEndMessage,
	monitorEndSummary,
	monitorEventMessage,
	shouldNotifyExit,
	TokenBucket,
	tailOutput,
	taskExitMessage,
	taskExitSummary,
	taskStallMessage,
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

describe("TokenBucket", () => {
	it("lets a burst of `capacity` through, then one per refill interval", () => {
		const bucket = new TokenBucket({ capacity: 3, refillMs: 1000 });
		expect([0, 0, 0, 0].map((t) => bucket.take(t))).toEqual([true, true, true, false]);
		expect(bucket.take(500)).toBe(false);
		expect(bucket.take(1000)).toBe(true);
		expect(bucket.take(1000)).toBe(false);
	});

	it("never refills past its capacity", () => {
		const bucket = new TokenBucket({ capacity: 2, refillMs: 10 });
		bucket.take(0);
		expect([10_000, 10_000, 10_000].map((t) => bucket.take(t))).toEqual([true, true, false]);
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
	id: "b0000003x",
	command: "tail -f x.log",
	description: "errors in deploy.log",
	cwd: "/",
	startedAt: 0,
	killed: false,
	kind: "monitor",
	events: 0,
	outputFile: "/tmp/claude/t/b0000003x.output",
};

describe("message builders", () => {
	it("monitorEventMessage is Claude Code's task-notification with the event", () => {
		const msg = monitorEventMessage(monitorJob, ["E1", "E2"]);
		expect(msg.customType).toBe("bluclawd:monitor");
		expect(msg.content).toBe(
			[
				"<task-notification>",
				"<task-id>b0000003x</task-id>",
				'<summary>Monitor event: "errors in deploy.log"</summary>',
				"<event>E1",
				"E2</event>",
				"</task-notification>",
			].join("\n"),
		);
		expect(msg.details).toEqual({ id: "b0000003x", description: "errors in deploy.log", lines: ["E1", "E2"] });
	});

	it("caps a line at 500 characters and an event at 3000", () => {
		const long = eventText(["x".repeat(600)]);
		expect(long).toBe(`${"x".repeat(500)}...(truncated)`);
		const many = eventText(Array.from({ length: 20 }, () => "y".repeat(400)));
		expect(many.length).toBe(3000 + "...(truncated)".length);
	});

	it("monitorEndMessage says how the stream ended, with leftover lines as its event", () => {
		const ended = { ...monitorJob, events: 2, exit: { code: 0, at: 1 } };
		const msg = monitorEndMessage(ended, ["last"]);
		expect(msg.content).toContain("<status>completed</status>");
		expect(msg.content).toContain("<output-file>/tmp/claude/t/b0000003x.output</output-file>");
		expect(msg.content).toContain(
			'<summary>Monitor "errors in deploy.log" stream ended</summary>\n<event>last</event>\n</task-notification>',
		);
		expect(msg.details).toMatchObject({ end: 'Monitor "errors in deploy.log" stream ended', status: "success" });
	});

	it("names a silent end, a failed script and a stop", () => {
		expect(monitorEndSummary({ ...monitorJob, exit: { code: 0, at: 1 } })).toBe(
			'Monitor "errors in deploy.log" ended without producing output (exit 0)',
		);
		expect(monitorEndSummary({ ...monitorJob, events: 1, exit: { code: 2, at: 1 } })).toBe(
			'Monitor "errors in deploy.log" script failed (exit 2)',
		);
		expect(monitorEndSummary({ ...monitorJob, killed: true, exit: { code: null, at: 1 } })).toBe(
			'Monitor "errors in deploy.log" stopped',
		);
	});

	it("sends a registry stop's notice as the event", () => {
		const stopped = {
			...monitorJob,
			killed: true,
			stopReason: "[Monitor stopped — too much output]",
			exit: { code: null, at: 1 },
		};
		const msg = monitorEndMessage(stopped, []);
		expect(msg.content).toContain("<status>killed</status>");
		expect(msg.content).toContain("<event>[Monitor stopped — too much output]</event>");
	});

	it("taskExitMessage is Claude Code's notification for a finished command", () => {
		const job: BackgroundJobInfo = {
			...monitorJob,
			id: "b0000002x",
			kind: "job",
			description: "build",
			command: "make",
			exit: { code: 1, at: 1 },
		};
		const msg = taskExitMessage(job, "toolu_1");
		expect(msg.customType).toBe("bluclawd:task-exit");
		expect(msg.content).toBe(
			[
				"<task-notification>",
				"<task-id>b0000002x</task-id>",
				"<tool-use-id>toolu_1</tool-use-id>",
				"<output-file>/tmp/claude/t/b0000003x.output</output-file>",
				"<status>failed</status>",
				'<summary>Background command "build" failed with exit code 1</summary>',
				"</task-notification>",
			].join("\n"),
		);
		expect(msg.details).toMatchObject({ status: "error" });
	});

	it("names completion, a stop, and a stop the user made (without the file)", () => {
		const job: BackgroundJobInfo = { ...monitorJob, kind: "job", description: undefined, command: "make" };
		expect(taskExitSummary({ ...job, exit: { code: 0, at: 1 } })).toBe(
			'Background command "make" completed (exit code 0)',
		);
		expect(taskExitSummary({ ...job, killed: true, exit: { code: null, at: 1 } })).toBe(
			'Background command "make" was stopped',
		);
		const byUser = taskExitMessage({ ...job, killed: true, stoppedByUser: true, exit: { code: null, at: 1 } });
		expect(byUser.content).toContain('<summary>Task "make" was stopped by the user</summary>');
		expect(byUser.content).toContain("<status>killed</status>");
		expect(byUser.content).not.toContain("<output-file>");
	});

	it("taskStallMessage is Claude Code's notice with the tail after the envelope and no status", () => {
		const job: BackgroundJobInfo = { ...monitorJob, kind: "job", description: "npm init", command: "npm init" };
		const msg = taskStallMessage(job, "name: (x)\nIs this OK? (yes/no) ", "toolu_2");
		expect(msg.content).toBe(
			[
				"<task-notification>",
				"<task-id>b0000003x</task-id>",
				"<tool-use-id>toolu_2</tool-use-id>",
				"<output-file>/tmp/claude/t/b0000003x.output</output-file>",
				'<summary>Background command "npm init" appears to be waiting for interactive input</summary>',
				"</task-notification>",
				"Last output:",
				"name: (x)",
				"Is this OK? (yes/no)",
				"",
				"The command is likely blocked on an interactive prompt. Stop this task and re-run with piped input (e.g., `echo y | command`) or a non-interactive flag if one exists.",
			].join("\n"),
		);
		expect(msg.details).toMatchObject({ status: "warning" });
	});

	it("formats durations as the expiry notice names them", () => {
		expect(formatDuration(300_000)).toBe("5m");
		expect(formatDuration(90_000)).toBe("1m 30s");
		expect(formatDuration(5_000)).toBe("5s");
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
	it("stays quiet for a kill the model asked for, and for an exit task_output was waiting on", () => {
		expect(shouldNotifyExit({ ...base, killed: true, exit: { code: null, at: 1 } })).toBe(false);
		expect(shouldNotifyExit({ ...base, awaited: true, exit: { code: 0, at: 1 } })).toBe(false);
	});

	it("notifies a stop the user made from /tasks", () => {
		expect(shouldNotifyExit({ ...base, killed: true, stoppedByUser: true, exit: { code: null, at: 1 } })).toBe(true);
	});
	it("still notifies a registry-initiated stop", () => {
		expect(
			shouldNotifyExit({ ...base, killed: true, stopReason: "too many events", exit: { code: null, at: 1 } }),
		).toBe(true);
	});
});
