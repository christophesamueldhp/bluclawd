import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptOutcome } from "../daemon/ipc/protocol.ts";
import { PromptOutcomes, QUIET_HEARTBEATS_BEFORE_LOST } from "../ext/remote/outcomes.ts";

function tracker() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler) };
	let beat = () => {};
	const state = { idle: true, pending: false, ended: false };
	const live = <T>(value: () => T) => {
		if (state.ended) throw new Error("This extension ctx is stale");
		return value();
	};
	const ctx = { isIdle: () => live(() => state.idle), hasPendingMessages: () => live(() => state.pending) };
	const reports: PromptOutcome[][] = [];
	const delivery = { landed: (): Promise<void> => Promise.resolve() };
	const outcomes: PromptOutcomes = new PromptOutcomes(
		pi as never,
		(look) => {
			beat = look;
		},
		() => {
			reports.push(outcomes.list());
			return delivery.landed();
		},
	);
	const on = (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
	on("session_start");
	return {
		outcomes,
		state,
		delivery,
		on,
		reported: () => reports.at(-1),
		reports,
		heartbeats: (count = 1) => {
			for (let i = 0; i < count; i++) beat();
		},
		input: (text: string, source = "extension", streamingBehavior?: string) =>
			on("input", { type: "input", text, source, ...(streamingBehavior ? { streamingBehavior } : {}) }),
		started: (text: string) => on("message_start", { message: { role: "user", content: [{ type: "text", text }] } }),
	};
}

describe("the pane's Prompt outcome tracker", () => {
	it("reports a phone prompt taken or queued from pi's input event, by its text, and taken once pi starts a queued one", () => {
		const t = tracker();
		t.outcomes.sent("p-1", "same");
		t.outcomes.sent("p-2", "same");
		t.input("same", "interactive");
		expect(t.reports).toEqual([]);
		t.input("same");
		expect(t.reported()).toEqual([{ id: "p-1", outcome: "taken" }]);
		t.input("same", "extension", "followUp");
		expect(t.reported()).toEqual([
			{ id: "p-1", outcome: "taken" },
			{ id: "p-2", outcome: "queued" },
		]);
		t.started("same");
		expect(t.reported()).toEqual([
			{ id: "p-1", outcome: "taken" },
			{ id: "p-2", outcome: "taken" },
		]);
	});

	it("knows a phone prompt with an image or several text parts by its text joined as pi joins it", () => {
		const t = tracker();
		const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgo=" };
		t.outcomes.sent("p-1", [{ type: "text", text: "hi\n\n[Image #1]" }, image]);
		t.outcomes.sent("p-2", [
			{ type: "text", text: "one" },
			{ type: "text", text: "two" },
		]);
		t.input("hi\n\n[Image #1]");
		t.input("one\ntwo", "extension", "followUp");
		expect(t.reported()).toEqual([
			{ id: "p-1", outcome: "taken" },
			{ id: "p-2", outcome: "queued" },
		]);
		t.on("message_start", {
			message: {
				role: "user",
				content: [
					{ type: "text", text: "one" },
					{ type: "text", text: "two" },
				],
			},
		});
		expect(t.reported()).toEqual([
			{ id: "p-1", outcome: "taken" },
			{ id: "p-2", outcome: "taken" },
		]);
	});

	it("reports lost a phone prompt seen in pi's queue that pi drops from it unstarted, while idle too", () => {
		const t = tracker();
		const queue = (id: string, text: string) => {
			t.outcomes.sent(id, text);
			t.input(text, "extension", "followUp");
		};
		queue("p-1", "first");
		queue("p-2", "second");
		t.started("first");
		t.state.pending = true;
		t.on("agent_settled");
		expect(t.reported()).toEqual([
			{ id: "p-1", outcome: "taken" },
			{ id: "p-2", outcome: "queued" },
		]);
		t.state.pending = false;
		t.heartbeats();
		expect(t.reported()).toEqual([
			{ id: "p-1", outcome: "taken" },
			{ id: "p-2", outcome: "lost", reason: "dequeued" },
		]);
	});

	it("does not report lost a phone prompt the run ended before pi queued it, which pi runs as a turn of its own", () => {
		const t = tracker();
		t.outcomes.sent("p-1", "late");
		t.input("late", "extension", "followUp");
		t.on("agent_settled");
		t.heartbeats();
		expect(t.reported()).toEqual([{ id: "p-1", outcome: "queued" }]);
		t.state.idle = false;
		t.started("late");
		expect(t.reported()).toEqual([{ id: "p-1", outcome: "taken" }]);
	});

	it("reports dequeued a phone prompt never seen in pi's queue once pi has been idle with it empty for QUIET_HEARTBEATS_BEFORE_LOST heartbeats, not before", () => {
		let now = 1_000_000;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		const t = tracker();
		t.delivery.landed = () => new Promise(() => {});
		const queue = (id: string, text: string) => {
			t.outcomes.sent(id, text);
			t.input(text, "extension", "followUp");
		};
		queue("p-1", "first");
		t.on("agent_settled");
		now += 3_600_000;
		t.heartbeats(1);
		expect(t.reported()).toEqual([{ id: "p-1", outcome: "queued" }]);
		t.heartbeats(QUIET_HEARTBEATS_BEFORE_LOST - 2);
		t.on("agent_settled");
		t.heartbeats(QUIET_HEARTBEATS_BEFORE_LOST - 1);
		t.state.idle = false;
		t.heartbeats(1);
		t.state.idle = true;
		t.heartbeats(QUIET_HEARTBEATS_BEFORE_LOST - 1);
		expect(t.reported()).toEqual([{ id: "p-1", outcome: "queued" }]);
		t.heartbeats(1);
		expect(t.reported()).toEqual([{ id: "p-1", outcome: "lost", reason: "dequeued" }]);

		queue("p-2", "second");
		t.on("agent_settled");
		t.heartbeats(QUIET_HEARTBEATS_BEFORE_LOST - 1);
		t.state.idle = false;
		t.started("second");
		t.state.idle = true;
		t.on("agent_settled");
		t.heartbeats(QUIET_HEARTBEATS_BEFORE_LOST);
		expect(t.reported()).toEqual([
			{ id: "p-1", outcome: "lost", reason: "dequeued" },
			{ id: "p-2", outcome: "taken" },
		]);
		clock.mockRestore();
	});

	it("sees neither of two queued phone prompts in pi's queue, as either may be all it holds, until pi takes one", () => {
		const t = tracker();
		for (const [id, text] of [
			["p-1", "first"],
			["p-2", "second"],
		] as const) {
			t.outcomes.sent(id, text);
			t.input(text, "extension", "followUp");
		}
		t.state.pending = true;
		t.heartbeats();
		t.state.pending = false;
		t.on("agent_settled");
		expect(t.reported()).toEqual([
			{ id: "p-1", outcome: "queued" },
			{ id: "p-2", outcome: "queued" },
		]);
		t.state.idle = false;
		t.started("second");
		expect(t.reported()).toEqual([
			{ id: "p-1", outcome: "queued" },
			{ id: "p-2", outcome: "taken" },
		]);
	});

	it("sees no phone prompt in pi's queue that a Mac follow-up may be all it holds, until pi starts that or is idle with it empty", () => {
		const t = tracker();
		const heartbeat = (state: { idle: boolean; pending: boolean }) => {
			Object.assign(t.state, state);
			t.heartbeats();
		};
		const queue = (id: string, text: string) => {
			t.outcomes.sent(id, text);
			t.input(text, "extension", "followUp");
		};
		t.state.idle = false;
		t.input("mac", "interactive", "followUp");
		heartbeat({ idle: false, pending: false });
		queue("p-1", "first");
		heartbeat({ idle: false, pending: true });
		t.state.pending = false;
		t.state.idle = true;
		t.on("agent_settled");
		expect(t.reported()).toEqual([{ id: "p-1", outcome: "queued" }]);
		t.started("first");
		queue("p-2", "second");
		heartbeat({ idle: false, pending: true });
		heartbeat({ idle: true, pending: false });
		expect(t.reported()).toEqual([
			{ id: "p-1", outcome: "taken" },
			{ id: "p-2", outcome: "lost", reason: "dequeued" },
		]);
		t.state.idle = false;
		t.input("mac", "interactive", "steer");
		queue("p-3", "third");
		t.started("mac");
		heartbeat({ idle: false, pending: true });
		heartbeat({ idle: true, pending: false });
		expect(t.reported()).toContainEqual({ id: "p-3", outcome: "lost", reason: "dequeued" });
	});

	it("reports a phone prompt still queued at session end lost, and holds the session's end until the daemon has it", async () => {
		const t = tracker();
		t.outcomes.sent("p-1", "later");
		t.input("later", "extension", "followUp");
		let received = () => {};
		t.delivery.landed = () =>
			new Promise<void>((resolve) => {
				received = resolve;
			});
		t.state.pending = true;
		t.on("agent_settled");
		let ended = false;
		const shutdown = Promise.resolve(t.on("session_shutdown", { reason: "resume" })).then(() => {
			ended = true;
		});
		expect(t.reported()).toEqual([{ id: "p-1", outcome: "lost", reason: "dequeued" }]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(ended).toBe(false);
		received();
		await shutdown;
	});

	it("reports lost at session end a queued phone prompt never seen in pi's queue, which no transcript will show", async () => {
		const t = tracker();
		t.outcomes.sent("p-1", "late");
		t.input("late", "extension", "followUp");
		await t.on("session_shutdown", { reason: "resume" });
		expect(t.reported()).toEqual([{ id: "p-1", outcome: "lost", reason: "dequeued" }]);
	});

	it("leaves a phone prompt still queued at quit to the daemon, and holds no quit for a report", async () => {
		const t = tracker();
		t.outcomes.sent("p-1", "later");
		t.input("later", "extension", "followUp");
		t.delivery.landed = () => new Promise(() => {});
		await t.on("session_shutdown", { reason: "quit" });
		expect(t.reports).toEqual([[{ id: "p-1", outcome: "queued" }]]);
	});

	it("refuses a phone's prompt or command while pi compacts at the user's request, and not once it is done", () => {
		const t = tracker();
		const refusal = () => t.outcomes.refusal({ sessionFile: "/s/a.jsonl" }, "/s/a.jsonl");
		expect(t.on("session_before_compact", { reason: "threshold" })).toBeUndefined();
		expect(refusal()).toBeUndefined();
		t.on("session_compact", { reason: "threshold" });
		expect(t.on("session_before_compact", { reason: "manual" })).toBeUndefined();
		expect(refusal()).toBe("compacting");
		t.on("session_compact_failed", { reason: "manual" });
		expect(refusal()).toBeUndefined();
		t.on("session_before_compact", { reason: "manual" });
		t.on("session_compact", { reason: "manual" });
		expect(refusal()).toBeUndefined();
	});

	it("refuses a phone's prompt or command sent to another session than the pane's, before saying it compacts", () => {
		const t = tracker();
		t.on("session_before_compact", { reason: "manual" });
		expect(t.outcomes.refusal({ sessionFile: "/s/other.jsonl" }, "/s/a.jsonl")).toBe("session_changed");
		expect(t.outcomes.refusal({}, "/s/a.jsonl")).toBe("compacting");
	});
});

describe("the pane's Prompt outcome tracker, a tick after an input", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("looks at pi's queue once pi has queued a phone prompt after every input handler, so one emptied out of it before any heartbeat is lost", () => {
		const t = tracker();
		t.outcomes.sent("p-1", "later");
		t.input("later", "extension", "followUp");
		t.state.pending = true;
		vi.runAllTimers();
		t.state.pending = false;
		t.on("agent_settled");
		expect(t.reported()).toEqual([{ id: "p-1", outcome: "lost", reason: "dequeued" }]);
	});

	it("looks no more once the session has ended, its context stale", async () => {
		const t = tracker();
		t.outcomes.sent("p-1", "later");
		t.input("later", "extension", "followUp");
		await t.on("session_shutdown", { reason: "quit" });
		t.state.ended = true;
		vi.runAllTimers();
		t.heartbeats();
		expect(t.reported()).toEqual([{ id: "p-1", outcome: "queued" }]);
	});
});
