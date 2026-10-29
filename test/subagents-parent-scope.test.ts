import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdNotifications } from "../ext/background-bash/notification-hold.ts";
import { PARENT_MESSAGE_ADDRESS, SubagentMessageBus } from "../ext/subagents/messages.ts";
import {
	createParentScope,
	type ParentInboxItem,
	type ParentScope,
	type ScopedRun,
} from "../ext/subagents/parent-scope.ts";

function fakeSession(sessionId: string, branch: string[] = ["e1", "e2"]) {
	const state = { branch, disposed: false };
	const check = () => {
		if (state.disposed) throw new Error("context disposed");
	};
	const ctx = {
		sessionManager: {
			getSessionId: () => {
				check();
				return sessionId;
			},
			getBranch: () => {
				check();
				return state.branch.map((id) => ({ id }));
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, state };
}

function setup(batchWindowMs = 0) {
	const bus = new SubagentMessageBus();
	const sent: ParentInboxItem<string>[][] = [];
	const live: ScopedRun[] = [];
	const cancelled: Array<{ run: ScopedRun; reason: string }> = [];
	const scope = createParentScope<string>({
		bus,
		cancelRuns: (where, reason) => {
			for (const run of live.splice(0)) {
				if (where(run)) cancelled.push({ run, reason });
				else live.push(run);
			}
		},
		send: (items) => sent.push([...items]),
		onChange: () => {},
		batchWindowMs,
	});
	const runIn = (at: ParentScope, originEntryId?: string): ScopedRun => {
		const run = { ...at, originEntryId };
		live.push(run);
		return run;
	};
	const childSends = (from: ParentScope, content = "hi") =>
		bus.send({ address: "sub_child", scope: from }, PARENT_MESSAGE_ADDRESS, content);
	return { bus, scope, sent, cancelled, runIn, childSends };
}

describe("parent scope", () => {
	it("starts with no scope and enters the session's first epoch", () => {
		const { scope } = setup();
		expect(scope.current()).toBeUndefined();

		scope.enter(fakeSession("sess_1").ctx, "replaced");

		const first = scope.current();
		expect(first).toMatchObject({ parentSessionId: "sess_1" });
		expect(scope.inScope(first!)).toBe(true);
		expect(scope.inScope({ parentSessionId: "sess_2", sessionEpoch: first!.sessionEpoch })).toBe(false);
	});

	it("makes the earlier epoch stale and cancels its runs when the session is switched or forked", () => {
		const { scope, cancelled, runIn } = setup();
		scope.enter(fakeSession("sess_1").ctx, "replaced");
		const before = scope.current()!;
		const run = runIn(before, "e1");

		scope.invalidate("Parent session switching");

		expect(scope.inScope(before)).toBe(false);
		expect(scope.current()).toMatchObject({ parentSessionId: "sess_1" });
		expect(scope.inScope(scope.current()!)).toBe(true);
		expect(cancelled).toEqual([{ run, reason: "Parent session switching" }]);
	});

	it("invalidates the session it replaces when another one starts", () => {
		const { scope, cancelled, runIn } = setup();
		scope.enter(fakeSession("sess_1").ctx, "replaced");
		const before = scope.current()!;
		runIn(before);

		scope.enter(fakeSession("sess_2").ctx, "Session replaced (new)");

		expect(scope.inScope(before)).toBe(false);
		expect(scope.current()).toMatchObject({ parentSessionId: "sess_2" });
		expect(cancelled.map((c) => c.reason)).toEqual(["Session replaced (new)"]);
	});

	it("makes the session stale on shutdown, closes the orchestrator's endpoint, and leaves nothing in scope once detached", async () => {
		const { scope, cancelled, runIn, childSends } = setup();
		scope.enter(fakeSession("sess_1").ctx, "replaced");
		const before = scope.current()!;
		runIn(before);

		scope.shutdown();

		expect(scope.inScope(before)).toBe(false);
		expect(cancelled.map((c) => c.reason)).toEqual(["Parent session shutting down"]);
		expect(await childSends(before)).toMatchObject({ status: "unavailable", reason: /has shut down/ });

		const last = scope.current()!;
		scope.detach();

		expect(scope.context()).toBeUndefined();
		expect(scope.inScope(last)).toBe(false);
	});

	it("keeps the epoch on tree navigation and cancels only runs whose originating entry left the branch", () => {
		const { scope, cancelled, runIn } = setup();
		const session = fakeSession("sess_1", ["e1", "e2"]);
		scope.enter(session.ctx, "replaced");
		const before = scope.current()!;
		const onBranch = runIn(before, "e1");
		const offBranch = runIn(before, "e2");
		const noOrigin = runIn(before);

		session.state.branch = ["e1", "e3"];
		scope.navigate(session.ctx);

		expect(scope.current()).toEqual(before);
		expect(scope.inScope(before)).toBe(true);
		expect(scope.onBranch("e2")).toBe(false);
		expect(scope.onBranch(undefined)).toBe(true);
		expect(cancelled).toEqual([
			{ run: offBranch, reason: "Originating branch is no longer active after tree navigation" },
		]);
		expect(cancelled.map((c) => c.run)).not.toContain(onBranch);
		expect(cancelled.map((c) => c.run)).not.toContain(noOrigin);
	});

	it("treats a disposed context as out of scope", () => {
		const { scope } = setup();
		const session = fakeSession("sess_1");
		scope.enter(session.ctx, "replaced");
		const current = scope.current()!;

		session.state.disposed = true;

		expect(scope.inScope(current)).toBe(false);
		expect(scope.onBranch("e1")).toBe(false);
	});

	it("tells a child of an earlier epoch that the session was reloaded, and a child of another session that it is foreign", async () => {
		const { scope, childSends } = setup();
		scope.enter(fakeSession("sess_1").ctx, "replaced");
		const before = scope.current()!;

		scope.invalidate("Parent session forking");

		expect(await childSends(before)).toMatchObject({ status: "invalidated" });
		expect(
			await childSends({ parentSessionId: "sess_2", sessionEpoch: scope.current()!.sessionEpoch }),
		).toMatchObject({ status: "unavailable", reason: /different parent session/ });
	});
});

describe("parent inbox", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("delivers notices and child messages together, in arrival order, once the batch window ends", async () => {
		const { scope, sent, childSends } = setup(100);
		scope.enter(fakeSession("sess_1").ctx, "replaced");
		const current = scope.current()!;

		scope.notify({ ...current, originEntryId: "e1" }, "first notice");
		expect(await childSends(current, "a message")).toMatchObject({ status: "accepted" });
		scope.notify({ ...current }, "second notice");
		expect(sent).toEqual([]);

		vi.advanceTimersByTime(100);

		expect(sent).toHaveLength(1);
		expect(sent[0].map((item) => (item.kind === "notice" ? item.notice : item.message.content))).toEqual([
			"first notice",
			"a message",
			"second notice",
		]);
	});

	it("delivers at once without a batch window", () => {
		const { scope, sent } = setup(0);
		scope.enter(fakeSession("sess_1").ctx, "replaced");

		scope.notify(scope.current()!, "done");

		expect(sent).toHaveLength(1);
	});

	it("does not queue a notice for a run that is out of scope", () => {
		const { scope, sent } = setup(0);
		scope.enter(fakeSession("sess_1", ["e1"]).ctx, "replaced");
		const current = scope.current()!;

		scope.notify({ ...current, sessionEpoch: current.sessionEpoch - 1 }, "stale");
		scope.notify({ ...current, originEntryId: "gone" }, "off branch");

		expect(sent).toEqual([]);
	});

	it("discards the inbox when the scope is invalidated during the batch window", () => {
		const { scope, sent } = setup(100);
		scope.enter(fakeSession("sess_1").ctx, "replaced");
		scope.notify(scope.current()!, "done");

		scope.invalidate("Parent session switching");
		vi.advanceTimersByTime(100);

		expect(sent).toEqual([]);
	});

	it("checks again when a held batch goes out and drops what left the scope meanwhile", () => {
		const { scope, sent } = setup(0);
		const session = fakeSession("sess_1", ["e1", "e2"]);
		scope.enter(session.ctx, "replaced");
		const current = scope.current()!;
		const release = holdNotifications();
		try {
			scope.notify({ ...current, originEntryId: "e1" }, "kept");
			scope.notify({ ...current, originEntryId: "e2" }, "branch left");
			session.state.branch = ["e1"];
			scope.navigate(session.ctx);
		} finally {
			release();
		}

		expect(sent).toHaveLength(1);
		expect(sent[0].map((item) => item.kind === "notice" && item.notice)).toEqual(["kept"]);
	});

	it("sends nothing when the session was invalidated while the batch was held", () => {
		const { scope, sent } = setup(0);
		scope.enter(fakeSession("sess_1").ctx, "replaced");
		const release = holdNotifications();
		try {
			scope.notify(scope.current()!, "done");
			scope.invalidate("Parent session switching");
		} finally {
			release();
		}

		expect(sent).toEqual([]);
	});
});
