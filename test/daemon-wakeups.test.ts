import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveInstances } from "../daemon/storage.ts";
import { ServerSupervisor } from "../daemon/supervisor.ts";
import { type HeldWakeups, processAlive, processStart, WakeupKeeper, type WakeupRecord } from "../daemon/wakeups.ts";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 10, 12, 0);

let keepers: WakeupKeeper[] = [];
afterEach(() => {
	for (const keeper of keepers) keeper.stop();
	keepers = [];
});

/** A keeper over a fresh dir (or `dir`), whose pis are alive while their pid is in `alive`, and whose session logs
 *  record `logs[sessionFile]` pending. Its reopens are listed. */
function fixture(dir = mkdtempSync(join(tmpdir(), "bluclawd-wakeups-"))) {
	let now = NOW;
	const alive = new Set<number>();
	const logs = new Map<string, WakeupRecord[]>();
	const reopened: string[] = [];
	const keeper = new WakeupKeeper({
		dir,
		now: () => now,
		alive: ({ pid }) => alive.has(pid),
		pending: (file) => logs.get(file) ?? [],
		reopen: (held) => {
			reopened.push(held.sessionFile);
		},
	});
	keepers.push(keeper);
	return {
		dir,
		keeper,
		alive,
		logs,
		reopened,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const wakeup = (id: string, dueAt: number): WakeupRecord => ({ id, prompt: `Do ${id}.`, dueAt, scheduledAt: NOW });

/** Session `file`'s wake-ups, held by pid `pid`; its log records them too. */
function hold(f: ReturnType<typeof fixture>, file: string, pid: number, wakeups: WakeupRecord[]): HeldWakeups {
	const held = { sessionFile: file, cwd: "/work", holder: { pid, startedAt: NOW }, wakeups };
	f.logs.set(file, wakeups);
	f.keeper.hold(held);
	return held;
}

describe("the daemon's copy of a session's wake-ups", () => {
	it("reopens the session once one falls due and its pi is gone", () => {
		const f = fixture();
		hold(f, "/s/a.jsonl", 41, [wakeup("w1", NOW + 10 * MINUTE)]);

		f.keeper.check();
		expect(f.reopened).toEqual([]);
		f.advance(10 * MINUTE);
		f.keeper.check();
		expect(f.reopened).toEqual(["/s/a.jsonl"]);
		// Not again while the reopened pi starts.
		f.keeper.check();
		expect(f.reopened).toEqual(["/s/a.jsonl"]);
	});

	it("leaves a due one to its pi while that pi runs: held up, Silent, or outside tmux", () => {
		const f = fixture();
		f.alive.add(41);
		hold(f, "/s/a.jsonl", 41, [wakeup("w1", NOW + MINUTE)]);

		f.advance(5 * MINUTE);
		f.keeper.check();
		expect(f.reopened).toEqual([]);
		// It is gone later: the wake-up still fires.
		f.alive.delete(41);
		f.keeper.check();
		expect(f.reopened).toEqual(["/s/a.jsonl"]);
	});

	it("takes the session log's word: one cancelled or fired there reopens nothing, and is forgotten", () => {
		const f = fixture();
		hold(f, "/s/a.jsonl", 41, [wakeup("w1", NOW + MINUTE)]);
		// The quit's hand-off never came; its log has the cancel.
		f.logs.set("/s/a.jsonl", []);

		f.advance(MINUTE);
		f.keeper.check();
		expect(f.reopened).toEqual([]);
		expect(f.keeper.list()).toEqual([]);
	});

	it("forgets a session handed over with none pending, or whose row was deleted", () => {
		const f = fixture();
		hold(f, "/s/a.jsonl", 41, [wakeup("w1", NOW + MINUTE)]);
		hold(f, "/s/b.jsonl", 42, [wakeup("w2", NOW + MINUTE)]);

		hold(f, "/s/a.jsonl", 41, []);
		f.keeper.drop("/s/b.jsonl");
		f.advance(MINUTE);
		f.keeper.check();
		expect(f.keeper.list()).toEqual([]);
		expect(f.reopened).toEqual([]);
	});

	it("forgets a session whose row is deleted, stored or live", () => {
		const f = fixture();
		const supervisor = new ServerSupervisor({
			now: () => NOW,
			tmux: { hasSession: () => true, end: () => {} },
			dir: f.dir,
			wakeups: f.keeper,
		});
		saveInstances(f.dir, [
			{ id: "row-a", status: "stopped", cwd: "/work", createdAt: "2026-11-10T00:00:00Z", sessionFile: "/s/a.jsonl" },
		]);
		hold(f, "/s/a.jsonl", 41, [wakeup("w1", NOW + MINUTE)]);
		supervisor.registerExternal(
			{
				id: "pi-b",
				pane: "pi-b",
				cwd: "/work",
				sessionFile: "/s/b.jsonl",
				status: "online",
				createdAt: "2026-11-10T00:00:00Z",
				lastSeenAt: new Date(NOW).toISOString(),
			},
			"idle",
		);
		hold(f, "/s/b.jsonl", 42, [wakeup("w2", NOW + MINUTE)]);

		expect(supervisor.deleteInstance("row-a")).toBe(true);
		expect(supervisor.deleteInstance("pi-b")).toBe(true);
		expect(f.keeper.list()).toEqual([]);
	});

	it("goes with the pi that took the session last: one back on it is left to fire its own", () => {
		const f = fixture();
		hold(f, "/s/a.jsonl", 41, [wakeup("w1", NOW + MINUTE)]);
		f.alive.add(57);
		hold(f, "/s/a.jsonl", 57, [wakeup("w1", NOW + MINUTE)]);

		f.advance(MINUTE);
		f.keeper.check();
		expect(f.reopened).toEqual([]);
	});

	it("gives up on a session after three reopens that never took it, and stops looking at it", () => {
		const f = fixture();
		hold(f, "/s/a.jsonl", 41, [wakeup("w1", NOW + MINUTE)]);

		for (let i = 0; i < 5; i++) {
			f.advance(2 * MINUTE);
			f.keeper.check();
		}
		expect(f.reopened).toHaveLength(3);
		// Left to the session log, which fires it when the session is next opened.
		expect(f.keeper.list()).toEqual([]);
	});

	it("survives a restart of the daemon, and one due while it was down fires once, late", () => {
		const first = fixture();
		hold(first, "/s/a.jsonl", 41, [wakeup("w1", NOW + MINUTE)]);
		first.keeper.stop();

		const second = fixture(first.dir);
		second.logs.set("/s/a.jsonl", [wakeup("w1", NOW + MINUTE)]);
		second.advance(60 * MINUTE);
		second.keeper.check();
		second.keeper.check();
		expect(second.reopened).toEqual(["/s/a.jsonl"]);
	});
});

describe("telling a pi's process from a later one with its pid", () => {
	it("knows this process by its pid and start, and not by its pid with another start", () => {
		const startedAt = processStart(process.pid);
		if (startedAt === undefined) throw new Error("ps gave no start time.");
		expect(processAlive({ pid: process.pid, startedAt })).toBe(true);
		expect(processAlive({ pid: process.pid, startedAt: startedAt - 60_000 })).toBe(false);
		expect(processAlive({ pid: 2 ** 22 + 7, startedAt })).toBe(false);
	});
});
