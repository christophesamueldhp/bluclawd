import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { OrchestratorClient } from "../daemon/orchestrator-client.ts";
import { saveInstances } from "../daemon/storage.ts";
import { ServerSupervisor } from "../daemon/supervisor.ts";
import {
	cancelledByDelete,
	type HeldWakeups,
	processAlive,
	processStart,
	readPendingWakeups,
	WAKEUP_END_ENTRY,
	WAKEUP_ENTRY,
	WakeupKeeper,
	type WakeupKeeperDeps,
	type WakeupRecord,
} from "../daemon/wakeups.ts";
import { waitFor } from "./helpers/wait-for.ts";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 10, 12, 0);

let keepers: WakeupKeeper[] = [];
afterEach(() => {
	for (const keeper of keepers) keeper.stop();
	keepers = [];
});

function fixture(dir = mkdtempSync(join(tmpdir(), "bluclawd-wakeups-")), pending?: WakeupKeeperDeps["pending"]) {
	let now = NOW;
	const alive = new Set<number>();
	const logs = new Map<string, WakeupRecord[]>();
	const reopened: string[] = [];
	const logged: string[] = [];
	const keeper = new WakeupKeeper({
		dir,
		now: () => now,
		alive: ({ pid }) => alive.has(pid),
		pending: pending ?? ((file) => logs.get(file) ?? []),
		reopen: (held) => {
			reopened.push(held.sessionFile);
		},
		log: (line) => logged.push(line),
	});
	keepers.push(keeper);
	return {
		dir,
		keeper,
		alive,
		logs,
		reopened,
		logged,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

const wakeup = (id: string, dueAt: number): WakeupRecord => ({ id, prompt: `Do ${id}.`, dueAt, scheduledAt: NOW });

function hold(f: ReturnType<typeof fixture>, file: string, pid: number, wakeups: WakeupRecord[]): HeldWakeups {
	const held = { sessionFile: file, cwd: "/work", holder: { pid, startedAt: NOW }, wakeups };
	f.logs.set(file, wakeups);
	f.keeper.hold(held);
	return held;
}

describe("the daemon's copy of a session's wake-ups", () => {
	it("leaves a log line for a rejected wake-up ID when pi starts the daemon in the background", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bc-wakeups-"));
		vi.stubEnv("PI_SERVER_DIR", dir);
		const client = new OrchestratorClient();
		onTestFinished(async () => {
			try {
				if (await client.isRunning()) expect(await client.shutdownDaemon()).toEqual({ ok: true });
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
		const sessionFile = join(dir, "session.jsonl");
		const dueAt = Date.now() - MINUTE;
		writeFileSync(
			sessionFile,
			JSON.stringify({ type: "custom", customType: WAKEUP_ENTRY, data: wakeup("invalid-id", dueAt) }),
		);

		if (!(await client.ensureDaemon())) await waitFor(async () => expect(await client.isRunning()).toBe(true));
		await client.holdWakeups({
			sessionFile,
			cwd: dir,
			holder: { pid: process.pid, startedAt: 0 },
			wakeups: [wakeup("wkept0001", dueAt)],
		});

		expect(readFileSync(join(dir, "wakeups.log"), "utf8")).toContain(
			'Skipped a wake-up whose id bluclawd did not generate: "invalid-id"',
		);
	});

	it("skips malformed records in the session log and still cancels the valid wake-up", () => {
		const dir = mkdtempSync(join(tmpdir(), "bluclawd-wakeups-"));
		const f = fixture(dir, readPendingWakeups);
		const file = join(dir, "session.jsonl");
		writeFileSync(
			file,
			[
				{ type: "custom", customType: WAKEUP_ENTRY, data: null },
				{ type: "custom", customType: WAKEUP_END_ENTRY, data: null },
				{ type: "custom", customType: WAKEUP_ENTRY, data: { id: "wbad00001" } },
				{ type: "custom", customType: WAKEUP_ENTRY, data: wakeup("wkept0001", NOW + MINUTE) },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);

		f.keeper.drop(file);

		expect(f.logged).toHaveLength(3);
		expect(f.logged.every((line) => line.startsWith("Skipped a wake-up"))).toBe(true);
		expect(cancelledByDelete("wbad00001", dir)).toBe(false);
		expect(cancelledByDelete("wkept0001", dir)).toBe(true);
	});

	it("reopens the session once one falls due and its pi is gone", () => {
		const f = fixture();
		hold(f, "/s/a.jsonl", 41, [wakeup("wfirst001", NOW + 10 * MINUTE)]);

		f.keeper.check();
		expect(f.reopened).toEqual([]);
		f.advance(10 * MINUTE);
		f.keeper.check();
		expect(f.reopened).toEqual(["/s/a.jsonl"]);
		f.keeper.check();
		expect(f.reopened).toEqual(["/s/a.jsonl"]);
	});

	it("leaves a due one to its pi while that pi runs: held up, Silent, or outside tmux", () => {
		const f = fixture();
		f.alive.add(41);
		hold(f, "/s/a.jsonl", 41, [wakeup("wfirst001", NOW + MINUTE)]);

		f.advance(5 * MINUTE);
		f.keeper.check();
		expect(f.reopened).toEqual([]);
		f.alive.delete(41);
		f.keeper.check();
		expect(f.reopened).toEqual(["/s/a.jsonl"]);
	});

	it("takes the session log's word: one cancelled or fired there reopens nothing, and is forgotten", () => {
		const f = fixture();
		hold(f, "/s/a.jsonl", 41, [wakeup("wfirst001", NOW + MINUTE)]);
		f.logs.set("/s/a.jsonl", []);

		f.advance(MINUTE);
		f.keeper.check();
		expect(f.reopened).toEqual([]);
		expect(f.keeper.list()).toEqual([]);
	});

	it("forgets a session handed over with none pending, or whose row was deleted", () => {
		const f = fixture();
		hold(f, "/s/a.jsonl", 41, [wakeup("wfirst001", NOW + MINUTE)]);
		hold(f, "/s/b.jsonl", 42, [wakeup("wsecond01", NOW + MINUTE)]);

		hold(f, "/s/a.jsonl", 41, []);
		f.keeper.drop("/s/b.jsonl");
		f.advance(MINUTE);
		f.keeper.check();
		expect(f.keeper.list()).toEqual([]);
		expect(f.reopened).toEqual([]);
	});

	it("never reopens a deleted session for the wake-ups it had, though a late hand-off brings them back", () => {
		const f = fixture();
		const stale = hold(f, "/s/a.jsonl", 41, [
			wakeup("wfirst001", NOW + MINUTE),
			wakeup("wsecond01", NOW + 2 * MINUTE),
		]);

		f.keeper.drop("/s/a.jsonl");
		f.keeper.hold(stale);
		f.advance(2 * MINUTE);
		f.keeper.check();
		expect(f.reopened).toEqual([]);
		expect(f.keeper.list()).toEqual([]);
	});

	it("forgets a session whose row is deleted, stored or live", () => {
		const f = fixture();
		const supervisor = new ServerSupervisor({
			now: () => NOW,
			tmux: { hasSession: () => true, hangUpAsQuit: () => {} },
			dir: f.dir,
			wakeups: f.keeper,
		});
		saveInstances(f.dir, [
			{ id: "row-a", status: "stopped", cwd: "/work", createdAt: "2026-11-10T00:00:00Z", sessionFile: "/s/a.jsonl" },
		]);
		hold(f, "/s/a.jsonl", 41, [wakeup("wfirst001", NOW + MINUTE)]);
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
		hold(f, "/s/b.jsonl", 42, [wakeup("wsecond01", NOW + MINUTE)]);

		expect(supervisor.deleteInstance("row-a")).toBe(true);
		expect(supervisor.deleteInstance("pi-b")).toBe(true);
		expect(f.keeper.list()).toEqual([]);
	});

	it("cancels them when agent view deletes its own row, which it unlists first", () => {
		const f = fixture();
		const file = join(f.dir, "a.jsonl");
		writeFileSync(file, "");
		const supervisor = new ServerSupervisor({
			now: () => NOW,
			tmux: { hasSession: () => true, hangUpAsQuit: () => {} },
			dir: f.dir,
			wakeups: f.keeper,
		});
		supervisor.registerExternal(
			{
				id: "pi-a",
				pane: "pi-a",
				cwd: "/work",
				sessionFile: file,
				status: "online",
				createdAt: "2026-11-10T00:00:00Z",
				lastSeenAt: new Date(NOW).toISOString(),
			},
			"idle",
		);
		const stale = hold(f, file, 41, [wakeup("wfirst001", NOW + MINUTE)]);

		supervisor.unregisterExternal("pi-a");
		expect(supervisor.deleteInstance("pi-a")).toBe(true);
		f.keeper.hold(stale);
		f.advance(MINUTE);
		f.keeper.check();
		expect(f.reopened).toEqual([]);
	});

	it("goes with the pi that took the session last: one back on it is left to fire its own", () => {
		const f = fixture();
		hold(f, "/s/a.jsonl", 41, [wakeup("wfirst001", NOW + MINUTE)]);
		f.alive.add(57);
		hold(f, "/s/a.jsonl", 57, [wakeup("wfirst001", NOW + MINUTE)]);

		f.advance(MINUTE);
		f.keeper.check();
		expect(f.reopened).toEqual([]);
	});

	it("gives up on a session after three reopens that never took it, and stops looking at it", () => {
		const f = fixture();
		hold(f, "/s/a.jsonl", 41, [wakeup("wfirst001", NOW + MINUTE)]);

		for (let i = 0; i < 5; i++) {
			f.advance(2 * MINUTE);
			f.keeper.check();
		}
		expect(f.reopened).toHaveLength(3);
		expect(f.keeper.list()).toEqual([]);
	});

	it("survives a restart of the daemon, and one due while it was down fires once, late", () => {
		const first = fixture();
		hold(first, "/s/a.jsonl", 41, [wakeup("wfirst001", NOW + MINUTE)]);
		first.keeper.stop();

		const second = fixture(first.dir);
		second.logs.set("/s/a.jsonl", [wakeup("wfirst001", NOW + MINUTE)]);
		second.advance(60 * MINUTE);
		second.keeper.check();
		second.keeper.check();
		expect(second.reopened).toEqual(["/s/a.jsonl"]);
	});
});

describe("a wake-up id bluclawd did not generate", () => {
	it("is skipped and logged, and never names a file outside the wake-up folder", () => {
		const root = mkdtempSync(join(tmpdir(), "bluclawd-wakeups-"));
		const victim = join(root, "victim");
		writeFileSync(victim, "keep me");
		const f = fixture(join(root, "server"));
		const crafted = [wakeup("../../victim", NOW + MINUTE), wakeup("../../created", NOW + MINUTE)];
		f.logs.set("/s/a.jsonl", crafted);

		f.keeper.drop("/s/a.jsonl");

		expect(readFileSync(victim, "utf8")).toBe("keep me");
		expect(existsSync(join(root, "created"))).toBe(false);
		expect(f.logged).toEqual([
			'Skipped a wake-up whose id bluclawd did not generate: "../../victim"',
			'Skipped a wake-up whose id bluclawd did not generate: "../../created"',
		]);
	});

	it("is never held or reopened for, whether handed over or read back after a restart", () => {
		const root = mkdtempSync(join(tmpdir(), "bluclawd-wakeups-"));
		const first = fixture(join(root, "server"));
		hold(first, "/s/a.jsonl", 41, [wakeup("../../x", NOW + MINUTE), wakeup("wfirst001", NOW + MINUTE)]);
		expect(first.keeper.list()[0]?.wakeups.map((w) => w.id)).toEqual(["wfirst001"]);
		first.keeper.stop();
		writeFileSync(
			join(root, "server", "wakeups.json"),
			JSON.stringify([
				{
					sessionFile: "/s/b.jsonl",
					cwd: "/work",
					holder: { pid: 42, startedAt: NOW },
					wakeups: [wakeup("../../y", NOW + MINUTE)],
				},
			]),
		);

		const second = fixture(join(root, "server"));
		second.logs.set("/s/b.jsonl", [wakeup("../../y", NOW + MINUTE)]);
		second.advance(MINUTE);
		second.keeper.check();
		expect(second.reopened).toEqual([]);
		expect(second.keeper.list()).toEqual([]);
		expect(first.logged).toHaveLength(1);
		expect(second.logged.length).toBeGreaterThan(0);
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
