import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelledByDelete, type HeldWakeups, markCancelled } from "../daemon/wakeups.ts";
import { holdNotifications } from "../ext/background-bash/notification-hold.ts";
import {
	WAKEUP_END_ENTRY,
	WAKEUP_ENTRY,
	type WakeupDaemon,
	type WakeupSession,
	wakeupLifecycle,
	wakeups,
} from "../ext/background-bash/wakeups.ts";

/** 2026-11-10 13:30:00 local time. */
const NOW = new Date(2026, 10, 10, 13, 30, 0).getTime();
const MINUTE = 60_000;
const BUILD = "build-now";
const FILE = "/sessions/a.jsonl";

afterEach(() => {
	wakeups.release();
	vi.useRealTimers();
});

type Entry = { type: string; customType?: string; data?: unknown };

/** Lets the hand-offs queued so far reach the fake daemon. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A session `s1` in `mode` (tui unless given) whose log holds `entries`, and the lifecycle of its wake-ups. The clock
 * is faked from 13:30. The daemon answers as `daemon` says (running, of this build, unless given); it records each call.
 */
function fixture(
	options: {
		mode?: string;
		entries?: Entry[];
		daemon?: { running: boolean; buildId?: string };
		signalled?: boolean;
	} = {},
) {
	if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: NOW });
	const entries: Entry[] = [...(options.entries ?? [])];
	const daemon = { ...(options.daemon ?? { running: true, buildId: BUILD }) };
	const calls: string[] = [];
	const held: HeldWakeups[] = [];
	const sent: { id: string; text: string }[] = [];
	let idle = true;
	let signalAsked = false;
	const client: WakeupDaemon = {
		getDaemonInfo: async () => {
			calls.push("info");
			return { ...daemon };
		},
		restartDaemon: async () => {
			calls.push("restart");
			Object.assign(daemon, { running: true, buildId: BUILD });
		},
		ensureDaemon: async () => {
			calls.push("ensure");
			Object.assign(daemon, { running: true, buildId: BUILD });
		},
		holdWakeups: async (h) => {
			calls.push(`hold ${h.wakeups.map((w) => w.id).join(",")}`);
			held.push(h);
		},
	};
	let session: WakeupSession | undefined = {
		mode: options.mode ?? "tui",
		isIdle: () => idle,
		sessionManager: {
			getSessionId: () => "s1",
			getSessionFile: () => FILE,
			getCwd: () => "/work",
			getSessionName: () => "Deploys",
			getEntries: () => entries,
		},
	};
	const lifecycle = wakeupLifecycle({
		session: () => session,
		append: (customType, data) => entries.push({ type: "custom", customType, data }),
		send: (message) => sent.push({ id: message.details?.id ?? "", text: String(message.content) }),
		daemon: () => client,
		buildId: () => BUILD,
		holder: () => ({ pid: 4242, startedAt: NOW - MINUTE }),
		now: () => Date.now(),
		killedBySignal: async () => {
			signalAsked = true;
			return options.signalled ?? false;
		},
	});
	return {
		lifecycle,
		entries,
		daemon,
		calls,
		held,
		sent,
		setIdle: (value: boolean) => {
			idle = value;
		},
		close: () => {
			session = undefined;
		},
		signalAsked: () => signalAsked,
		/** The log's entries of `type`, as their data. */
		logged: (type: string) => entries.filter((e) => e.customType === type).map((e) => e.data),
	};
}

describe("scheduling a wake-up", () => {
	it("records it in the session log and hands the session's pending ones to the daemon", async () => {
		const f = fixture();
		const wakeup = f.lifecycle.schedule({ prompt: "  Check CI  ", delay: 600 });
		expect(wakeup).toMatchObject({ owner: "s1", prompt: "Check CI", dueAt: NOW + 10 * MINUTE, scheduledAt: NOW });
		expect(f.logged(WAKEUP_ENTRY)).toEqual([
			{ id: wakeup.id, prompt: "Check CI", dueAt: NOW + 10 * MINUTE, scheduledAt: NOW },
		]);
		await settle();
		expect(f.calls).toEqual(["info", `hold ${wakeup.id}`]);
		expect(f.held[0]).toMatchObject({
			sessionFile: FILE,
			cwd: "/work",
			label: "Deploys",
			holder: { pid: 4242, startedAt: NOW - MINUTE },
			wakeups: [{ id: wakeup.id, prompt: "Check CI", dueAt: NOW + 10 * MINUTE, scheduledAt: NOW }],
		});
		expect(f.held[0]?.launch?.command.length).toBeGreaterThan(0);
	});
});

describe("the hand-off", () => {
	it("starts no daemon when none runs and the session holds nothing", async () => {
		const f = fixture({ daemon: { running: false } });
		const wakeup = f.lifecycle.schedule({ prompt: "Check CI", delay: 600 });
		wakeups.take(wakeup.id, "s1");
		await settle();
		// The schedule's hand-off starts it; once it holds the cancel's empty set, there is one to tell.
		expect(f.calls).toEqual(["info", "ensure", `hold ${wakeup.id}`, "info", "hold "]);

		const g = fixture({ daemon: { running: false } });
		g.lifecycle.cancel();
		expect(g.lifecycle.restore("startup")).toBe(0);
		g.close();
		await g.lifecycle.shutdown({ reason: "quit" });
		await settle();
		expect(g.calls).toEqual([]);
	});

	it("starts the daemon when none runs and the session holds one", async () => {
		const f = fixture({ daemon: { running: false } });
		const wakeup = f.lifecycle.schedule({ prompt: "Check CI", delay: 600 });
		await settle();
		expect(f.calls).toEqual(["info", "ensure", `hold ${wakeup.id}`]);
	});

	it("replaces a running daemon of an older build before handing it the set", async () => {
		const f = fixture({ daemon: { running: true, buildId: "build-before" } });
		const wakeup = f.lifecycle.schedule({ prompt: "Check CI", delay: 600 });
		await settle();
		expect(f.calls).toEqual(["info", "restart", `hold ${wakeup.id}`]);
	});

	it("follows a fire, a cancel and a restore, each with the set as it then is", async () => {
		const f = fixture();
		const first = f.lifecycle.schedule({ prompt: "Check CI", delay: 60 });
		const second = f.lifecycle.schedule({ prompt: "Check the deploy", delay: 600 });
		await settle();
		f.calls.length = 0;

		vi.advanceTimersByTime(MINUTE);
		await settle();
		expect(f.sent.map((s) => s.id)).toEqual([first.id]);
		expect(f.calls).toEqual(["info", `hold ${second.id}`]);

		wakeups.take(second.id, "s1");
		await settle();
		expect(f.calls).toEqual(["info", `hold ${second.id}`, "info", "hold "]);

		const g = fixture({ entries: f.entries.filter((e) => e.customType === WAKEUP_ENTRY).slice(1) });
		wakeups.release();
		expect(g.lifecycle.restore("resume")).toBe(1);
		await settle();
		expect(g.calls).toEqual(["info", `hold ${second.id}`]);
	});

	it("is not sent outside pi's TUI", async () => {
		const f = fixture({ mode: "print" });
		f.lifecycle.schedule({ prompt: "Check CI", delay: 600 });
		await settle();
		expect(f.calls).toEqual([]);
	});

	it("sends what was pending when it was asked for, though a shutdown empties the registry first", async () => {
		const f = fixture();
		const first = f.lifecycle.schedule({ prompt: "Check CI", delay: 600 });
		const second = f.lifecycle.schedule({ prompt: "Check the deploy", delay: 1200 });
		await f.lifecycle.shutdown({ reason: "new" });
		await settle();
		expect(f.calls.filter((c) => c.startsWith("hold"))).toEqual([
			`hold ${first.id}`,
			`hold ${first.id},${second.id}`,
			`hold ${second.id}`,
			"hold ",
		]);
	});
});

describe("keep or cancel at shutdown (ADR-0009)", () => {
	const cases: [
		string,
		{ reason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile?: string },
		boolean,
		"keep" | "cancel",
	][] = [
		["a reload", { reason: "reload" }, false, "keep"],
		["a /resume of the session itself", { reason: "resume", targetSessionFile: FILE }, false, "keep"],
		["a /resume of another session", { reason: "resume", targetSessionFile: "/sessions/b.jsonl" }, false, "cancel"],
		["the user's quit", { reason: "quit" }, false, "cancel"],
		["a quit by a signal nobody sent", { reason: "quit" }, true, "keep"],
		["/new", { reason: "new" }, false, "cancel"],
		["a fork", { reason: "fork" }, false, "cancel"],
	];
	for (const [name, event, signalled, outcome] of cases) {
		it(`${outcome}s them on ${name}, and leaves none in the registry`, async () => {
			const f = fixture({ signalled });
			const wakeup = f.lifecycle.schedule({ prompt: "Check CI", delay: 600 });
			expect(await f.lifecycle.shutdown(event)).toBe(outcome);
			expect(wakeups.list()).toEqual([]);
			expect(f.logged(WAKEUP_END_ENTRY)).toEqual(outcome === "cancel" ? [{ id: wakeup.id, end: "cancelled" }] : []);
			vi.advanceTimersByTime(10 * MINUTE);
			expect(f.sent).toEqual([]);
		});
	}

	it("asks about a signal only of a quit", async () => {
		const f = fixture({ signalled: true });
		f.lifecycle.schedule({ prompt: "Check CI", delay: 600 });
		expect(await f.lifecycle.shutdown({ reason: "new" })).toBe("cancel");
		expect(f.signalAsked()).toBe(false);
	});
});

describe("restoring from the session log", () => {
	const scheduled = (id: string, dueAt: number): Entry => ({
		type: "custom",
		customType: WAKEUP_ENTRY,
		data: { id, prompt: `Do ${id}.`, dueAt, scheduledAt: NOW - 60 * MINUTE },
	});
	const ended = (id: string): Entry => ({ type: "custom", customType: WAKEUP_END_ENTRY, data: { id, end: "fired" } });

	it("holds those pending again, with their ids, and fires them when due", async () => {
		const f = fixture({
			entries: [scheduled("wdone0001", NOW - MINUTE), ended("wdone0001"), scheduled("wlater001", NOW + 5 * MINUTE)],
		});
		expect(f.lifecycle.restore("resume")).toBe(1);
		expect(wakeups.list("s1")).toMatchObject([
			{ id: "wlater001", dueAt: NOW + 5 * MINUTE, scheduledAt: NOW - 60 * MINUTE },
		]);
		vi.advanceTimersByTime(5 * MINUTE);
		expect(f.sent.map((s) => s.id)).toEqual(["wlater001"]);
		expect(f.logged(WAKEUP_END_ENTRY)).toEqual([
			{ id: "wdone0001", end: "fired" },
			{ id: "wlater001", end: "fired" },
		]);
	});

	it("fires an overdue one at once, as late", async () => {
		const f = fixture({ entries: [scheduled("wlate0001", NOW - 30 * MINUTE)] });
		f.lifecycle.restore("startup");
		vi.advanceTimersByTime(0);
		expect(f.sent).toEqual([{ id: "wlate0001", text: expect.stringContaining("is late") }]);
	});

	it("records a fork's copies cancelled and holds none of them", async () => {
		const f = fixture({
			entries: [scheduled("wfork0001", NOW + 5 * MINUTE), scheduled("wfork0002", NOW + 9 * MINUTE)],
		});
		expect(f.lifecycle.restore("fork")).toBe(0);
		expect(wakeups.list()).toEqual([]);
		expect(f.logged(WAKEUP_END_ENTRY)).toEqual([
			{ id: "wfork0001", end: "cancelled" },
			{ id: "wfork0002", end: "cancelled" },
		]);
		await settle();
		expect(f.calls).toEqual(["info", "hold ", "info", "hold "]);
	});

	it("records cancelled those a Delete cancelled, and forgets the Delete's word once it has", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bluclawd-wakeups-"));
		vi.stubEnv("PI_SERVER_DIR", dir);
		markCancelled(dir, ["wgone0001"]);
		const f = fixture({
			entries: [scheduled("wgone0001", NOW + 5 * MINUTE), scheduled("wkept0001", NOW + 9 * MINUTE)],
		});
		expect(f.lifecycle.restore("resume")).toBe(1);
		expect(wakeups.list().map((w) => w.id)).toEqual(["wkept0001"]);
		expect(f.logged(WAKEUP_END_ENTRY)).toEqual([{ id: "wgone0001", end: "cancelled" }]);
		expect(cancelledByDelete("wgone0001", dir)).toBe(false);
		rmSync(dir, { recursive: true, force: true });
	});

	it("leaves the Delete's word in place when a fork records the cancel in its own log", () => {
		const dir = mkdtempSync(join(tmpdir(), "bluclawd-wakeups-"));
		vi.stubEnv("PI_SERVER_DIR", dir);
		markCancelled(dir, ["wgone0001"]);
		const f = fixture({ entries: [scheduled("wgone0001", NOW + 5 * MINUTE)] });
		f.lifecycle.restore("fork");
		expect(f.logged(WAKEUP_END_ENTRY)).toEqual([{ id: "wgone0001", end: "cancelled" }]);
		expect(cancelledByDelete("wgone0001", dir)).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("a due wake-up", () => {
	it("waits for the session to be idle, then starts the turn when the running one settles", () => {
		const f = fixture();
		const wakeup = f.lifecycle.schedule({ prompt: "Check CI", delay: 60 });
		f.setIdle(false);
		vi.advanceTimersByTime(MINUTE);
		expect(f.sent).toEqual([]);
		expect(wakeups.list().map((w) => w.id)).toEqual([wakeup.id]);
		f.setIdle(true);
		f.lifecycle.settled();
		expect(f.sent).toEqual([{ id: wakeup.id, text: expect.stringContaining("<prompt>Check CI</prompt>") }]);
		expect(f.logged(WAKEUP_END_ENTRY)).toEqual([{ id: wakeup.id, end: "fired" }]);
	});

	it("is held while /tasks is open, and checks again when it goes out", () => {
		const f = fixture();
		const wakeup = f.lifecycle.schedule({ prompt: "Check CI", delay: 60 });
		const release = holdNotifications();
		vi.advanceTimersByTime(MINUTE);
		expect(f.sent).toEqual([]);
		// Cancelled while held: nothing goes out, and no fire is recorded.
		wakeups.take(wakeup.id, "s1");
		release();
		expect(f.sent).toEqual([]);
		expect(f.logged(WAKEUP_END_ENTRY)).toEqual([{ id: wakeup.id, end: "cancelled" }]);
	});

	it("does nothing when the turn settles with none due", () => {
		const f = fixture();
		f.lifecycle.schedule({ prompt: "Check CI", delay: 600 });
		f.lifecycle.settled();
		expect(f.sent).toEqual([]);
	});
});
