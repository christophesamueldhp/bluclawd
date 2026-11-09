import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listSummaries } from "../daemon/handler.ts";
import { saveInstances } from "../daemon/storage.ts";
import { START_MS } from "../daemon/supervisor.ts";
import { testRegistry } from "./helpers/registry.ts";

const ROW = "row-s";
const createdAt = "2026-11-04T09:00:00.000Z";

/**
 * A registry with one session's row `row-s`, stored, on a clock and a tmux of its own: pane `pi-a`
 * resumes it. Each state below is reached through the supervisor's interface only.
 */
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "bluclawd-row-lifecycle-"));
	const clock = { now: Date.parse("2026-11-04T10:00:00.000Z") };
	const tmux = new Map<string, "up" | "gone" | "unknown">();
	/** The panes the daemon ended, in order. */
	const ended: string[] = [];
	const start = () =>
		testRegistry(dir, () => clock.now, {
			hasSession: (name) => {
				const said = tmux.get(name) ?? "up";
				if (said === "unknown") throw new Error("tmux timed out");
				return said === "up";
			},
			end: (name) => {
				ended.push(name);
				if (tmux.get(name) === "unknown") throw new Error("tmux timed out");
			},
		});
	let supervisor = start();
	const file = join(dir, "s.jsonl");
	const other = join(dir, "other.jsonl");
	writeFileSync(file, "");
	writeFileSync(other, "");
	saveInstances(dir, [{ id: ROW, status: "stopped", cwd: dir, createdAt, sessionFile: file }]);
	const beat = (sessionFile = file) =>
		supervisor.registerExternal(
			{ id: "pi-a", status: "online", cwd: dir, createdAt, sessionFile, pane: "pi-a" },
			"idle",
		);
	/** Time passes, with tmux then saying `said` of pane `pi-a`. */
	const pass = (ms: number, said: "up" | "gone" | "unknown" = "up") => {
		tmux.set("pi-a", said);
		clock.now += ms;
	};
	/** Past the heartbeat's TTL, and a look at the list. */
	const lapse = (said?: "up" | "gone" | "unknown") => {
		pass(20_000, said);
		listSummaries(supervisor);
	};
	/** This session's rows as every reader lists them. */
	const listed = () =>
		listSummaries(supervisor)
			.filter((row) => row.sessionFile === file)
			.map(({ id, status, external, silent, pinned }) => ({
				id,
				status,
				...(external ? { external } : {}),
				...(silent ? { silent } : {}),
				...(pinned ? { pinned } : {}),
			}));
	/** What became of the prompts sent to this session's row. */
	const outcomes = () => supervisor.delivery.outcomes(ROW);
	return {
		dir,
		tmux,
		ended,
		get supervisor() {
			return supervisor;
		},
		/** The daemon restarts on the same storage dir. */
		restart: () => {
			supervisor = start();
		},
		file,
		other,
		pass,
		beat,
		lapse,
		listed,
		outcomes,
	};
}

type Fixture = ReturnType<typeof fixture>;

const states: Record<string, (f: Fixture) => void | Promise<void>> = {
	stored: () => {},
	starting: (f) => {
		f.supervisor.claimStart({ cwd: f.dir, sessionFile: f.file });
	},
	/** `p-given` taken by its pane's heartbeat, and `p-inbox` still in its inbox. */
	live: async (f) => {
		f.beat();
		await f.supervisor.sendExternal(ROW, { type: "prompt", text: "given", id: "p-given" });
		f.supervisor.drainExternal("pi-a");
		await f.supervisor.sendExternal(ROW, { type: "prompt", text: "inbox", id: "p-inbox" });
	},
	silent: async (f) => {
		await states.live(f);
		f.lapse();
	},
};

const stored = { id: ROW, status: "stopped" };
const starting = { id: ROW, status: "starting" };
const live = { id: ROW, status: "online", external: true };
const silent = { ...live, silent: true };

const verdicts = {
	sent: { outcome: "sent" },
	lost: { outcome: "lost", reason: "pane_gone" },
	refused: { outcome: "refused", reason: "session_changed" },
} as const;
/** What became of the live state's `p-given` and `p-inbox`. */
const held = (given: keyof typeof verdicts, inbox: keyof typeof verdicts) => [
	{ id: "p-given", ...verdicts[given] },
	{ id: "p-inbox", ...verdicts[inbox] },
];

describe("a row's state by event, as every reader lists it", () => {
	it.each<[string, string, (f: Fixture) => void, object[], object[]?]>([
		["stored", "a start claimed", (f) => f.supervisor.claimStart({ cwd: f.dir, sessionFile: f.file }), [starting]],
		["stored", "a pane beats on its file", (f) => f.beat(), [live]],
		["stored", "deleted", (f) => f.supervisor.deleteInstance(ROW), []],

		["starting", "its pane beats", (f) => f.beat(), [live]],
		["starting", "its start failed", (f) => f.supervisor.startFailed(ROW), [stored]],
		["starting", "its start expired", (f) => f.pass(START_MS + 1), [stored]],

		["live", "a beat on the same session", (f) => f.beat(), [live], held("sent", "sent")],
		["live", "TTL lapse, tmux up", (f) => f.lapse(), [silent], held("sent", "lost")],
		["live", "TTL lapse, tmux gone", (f) => f.lapse("gone"), [stored], held("lost", "lost")],
		["live", "TTL lapse, tmux could not answer", (f) => f.lapse("unknown"), [stored], held("lost", "lost")],
		["live", "a quit", (f) => f.supervisor.unregisterExternal("pi-a", "quit"), [stored], held("lost", "lost")],
		["live", "a /new", (f) => f.supervisor.unregisterExternal("pi-a", "new"), [stored], held("refused", "refused")],
		[
			"live",
			"an unregister with no reason (an older pane)",
			(f) => f.supervisor.unregisterExternal("pi-a"),
			[stored],
			held("lost", "lost"),
		],
		["live", "deleted", (f) => f.supervisor.deleteInstance(ROW), [], held("lost", "lost")],

		["silent", "a beat on the same session", (f) => f.beat(), [live], held("sent", "lost")],
		["silent", "a beat on another session", (f) => f.beat(f.other), [stored], held("refused", "lost")],
		["silent", "tmux no longer has it", (f) => f.pass(0, "gone"), [stored], held("lost", "lost")],
		["silent", "tmux could not answer", (f) => f.pass(0, "unknown"), [silent], held("sent", "lost")],
		["silent", "a quit", (f) => f.supervisor.unregisterExternal("pi-a", "quit"), [stored], held("lost", "lost")],
		["silent", "deleted", (f) => f.supervisor.deleteInstance(ROW), [], held("lost", "lost")],
		[
			"silent",
			"pinned",
			(f) => f.supervisor.setInstanceMeta(ROW, { pinned: true }),
			[{ ...silent, pinned: true }],
			held("sent", "lost"),
		],
	])("%s, then %s", async (from, _, event, rows, outcomes = []) => {
		const f = fixture();
		await states[from](f);
		event(f);
		expect(f.listed()).toEqual(rows);
		expect(f.outcomes()).toEqual(outcomes);
	});

	it.each(["live", "silent"])("a %s row takes a message only while live", async (from) => {
		const f = fixture();
		await states[from](f);
		expect(await f.supervisor.sendExternal(ROW, { type: "abort" })).toBe(from === "live");
	});

	it("a live row whose pane died within its TTL does not take a message, and is stopped", async () => {
		const f = fixture();
		await states.live(f);
		f.pass(0, "gone");
		expect(await f.supervisor.sendExternal(ROW, { type: "prompt", text: "new", id: "p-new" })).toBe(false);
		expect(f.listed()).toEqual([stored]);
		expect(f.outcomes()).toEqual(held("lost", "lost"));
	});

	it("a live row takes a message while tmux could not say whether its pane is up", async () => {
		const f = fixture();
		await states.live(f);
		f.pass(0, "unknown");
		expect(await f.supervisor.sendExternal(ROW, { type: "abort" })).toBe(true);
		expect(f.supervisor.drainExternal("pi-a")).toEqual([
			{ type: "prompt", text: "inbox", id: "p-inbox" },
			{ type: "abort" },
		]);
	});

	it.each([
		["starting", "starting"],
		["live", "running"],
		["silent", "running"],
	])("a %s row refuses a start on its file", async (from, refused) => {
		const f = fixture();
		await states[from](f);
		expect(f.supervisor.claimStart({ cwd: f.dir, sessionFile: f.file })).toEqual({ ok: false, refused });
	});

	it("a pin and order go with the row between storage and its pane, through silence and a quit", () => {
		const f = fixture();
		f.supervisor.setInstanceMeta(ROW, { pinned: true, sortOrder: 3 });
		const meta = () => listSummaries(f.supervisor).map(({ id, pinned, sortOrder }) => ({ id, pinned, sortOrder }));
		const kept = [{ id: ROW, pinned: true, sortOrder: 3 }];
		f.beat();
		expect(meta()).toEqual(kept);
		f.lapse();
		f.supervisor.setInstanceMeta(ROW, { sortOrder: 4 });
		f.beat();
		expect(meta()).toEqual([{ ...kept[0], sortOrder: 4 }]);
		f.supervisor.unregisterExternal("pi-a", "quit");
		f.supervisor.saveInstance({ cwd: f.dir, sessionFile: f.file });
		expect(meta()).toEqual([{ ...kept[0], sortOrder: 4 }]);
	});

	it("a pane gone on to a new session (/new) carries on as its row, which lists the old session no more", () => {
		const f = fixture();
		f.supervisor.registerExternal(
			{ id: "pi-a", status: "online", cwd: f.dir, createdAt, sessionFile: f.file, pane: "pi-a", label: "old task" },
			"idle",
		);
		f.supervisor.setInstanceMeta(ROW, { pinned: true, sortOrder: 3 });
		// Its first prompt is not in yet, so pi has not written the new file.
		const fresh = join(f.dir, "new.jsonl");
		const now = "2026-11-04T10:00:00.000Z";
		f.supervisor.registerExternal(
			{ id: "pi-a", status: "online", cwd: f.dir, createdAt: now, sessionFile: fresh, pane: "pi-a" },
			"idle",
		);
		const rows = () =>
			listSummaries(f.supervisor).map(({ id, status, sessionFile, label, pinned, sortOrder, createdAt }) => ({
				id,
				status,
				sessionFile,
				label,
				pinned,
				sortOrder,
				createdAt,
			}));
		expect(rows()).toEqual([
			{
				id: ROW,
				status: "online",
				sessionFile: fresh,
				label: undefined,
				pinned: true,
				sortOrder: 3,
				createdAt: now,
			},
		]);
		// Ending before its first prompt leaves nothing of the old session listed.
		f.supervisor.unregisterExternal("pi-a", "quit");
		expect(rows().filter((r) => r.sessionFile === f.file)).toEqual([]);
	});

	it("a Silent pane another pane went on as its row is listed no more, and ends without stopping that row", async () => {
		const f = fixture();
		await states.silent(f);
		f.supervisor.registerExternal(
			{ id: "pi-b", status: "online", cwd: f.dir, createdAt, sessionFile: f.file, pane: "pi-b" },
			"idle",
		);
		expect(f.listed()).toEqual([live]);
		expect(f.supervisor.rowIdOf("pi-a")).toBe(ROW);
		f.tmux.set("pi-a", "gone");
		expect(f.listed()).toEqual([live]);
		expect(f.outcomes()).toEqual(held("lost", "lost"));
		expect(await f.supervisor.sendExternal(ROW, { type: "abort" })).toBe(true);
		expect(f.supervisor.drainExternal("pi-b")).toEqual([{ type: "abort" }]);
	});

	it("a start claimed past a live pane's TTL, before any list, leaves that pane its row and its inbox", async () => {
		const f = fixture();
		await states.live(f);
		await f.supervisor.sendExternal(ROW, { type: "abort" });
		f.pass(20_000);
		expect(f.supervisor.claimStart({ cwd: f.dir, sessionFile: f.file })).toMatchObject({ ok: true });
		expect(f.supervisor.drainExternal("pi-a")).toEqual([
			{ type: "prompt", text: "inbox", id: "p-inbox" },
			{ type: "abort" },
		]);
		f.pass(START_MS + 1);
		expect(f.listed()).toEqual([silent]);
		expect(f.outcomes()).toEqual(held("sent", "sent"));
	});

	it("a pane a start claimed the row for, past its live pane's TTL, takes that row's inbox", async () => {
		const f = fixture();
		await states.live(f);
		f.pass(20_000);
		f.supervisor.claimStart({ cwd: f.dir, sessionFile: f.file });
		f.supervisor.registerExternal(
			{ id: "pi-b", status: "online", cwd: f.dir, createdAt, sessionFile: f.file, pane: "pi-b" },
			"idle",
		);
		expect(f.supervisor.drainExternal("pi-b")).toEqual([{ type: "prompt", text: "inbox", id: "p-inbox" }]);
		expect(f.outcomes()).toEqual(held("sent", "sent"));
	});

	it("a row deleted while silent stays deleted once its pane ends and its hand-off saves", async () => {
		const f = fixture();
		await states.silent(f);
		f.supervisor.deleteInstance(ROW);
		f.supervisor.unregisterExternal("pi-a", "quit");
		f.tmux.set("pi-a", "gone");
		expect(f.supervisor.saveInstance({ cwd: f.dir, sessionFile: f.file })).toBeUndefined();
		expect(f.listed()).toEqual([]);
	});
});

describe("a deleted row does not come back by itself", () => {
	it("a pane dropped while tmux could not answer, then deleted, is ended at its next heartbeat and not listed", async () => {
		const f = fixture();
		await states.live(f);
		f.lapse("unknown");
		f.supervisor.deleteInstance(ROW);
		f.beat();
		expect(f.listed()).toEqual([]);
		expect(f.ended).toEqual(["pi-a"]);
		// tmux still cannot answer: each heartbeat tries again, and the row stays gone.
		f.pass(5_000, "unknown");
		f.beat();
		expect(f.listed()).toEqual([]);
		expect(f.ended).toEqual(["pi-a", "pi-a"]);
	});

	it("a pane dropped while tmux could not answer, gone on to a new session, is not ended when its old row is deleted", async () => {
		const f = fixture();
		await states.live(f);
		f.lapse("unknown");
		f.beat(f.other);
		f.supervisor.deleteInstance(ROW);
		f.beat(f.other);
		expect(f.ended).toEqual([]);
		expect(f.supervisor.listExternalInstances().map(({ record }) => record.sessionFile)).toEqual([f.other]);
	});

	it("a deleted pane gone on to a new session before it heard is ended, and its hand-off save lists nothing", async () => {
		const f = fixture();
		await states.live(f);
		f.supervisor.deleteInstance(ROW);
		f.beat(f.other);
		expect(f.ended).toEqual(["pi-a"]);
		expect(f.supervisor.saveInstance({ cwd: f.dir, sessionFile: f.other })).toBeUndefined();
		expect(listSummaries(f.supervisor)).toEqual([]);
	});

	it("a row deleted before its quit's hand-off saves stays deleted across a daemon restart", async () => {
		const f = fixture();
		await states.live(f);
		f.supervisor.unregisterExternal("pi-a", "quit");
		f.supervisor.deleteInstance(ROW);
		f.restart();
		expect(f.supervisor.saveInstance({ cwd: f.dir, sessionFile: f.file })).toBeUndefined();
		expect(f.listed()).toEqual([]);
	});

	it("another pane resuming a deleted row's file lists it again as a new row, unpinned, which its quit saves", () => {
		const f = fixture();
		f.supervisor.setInstanceMeta(ROW, { pinned: true, sortOrder: 3 });
		f.supervisor.deleteInstance(ROW);
		f.supervisor.registerExternal(
			{ id: "pi-b", status: "online", cwd: f.dir, createdAt, sessionFile: f.file, pane: "pi-b" },
			"idle",
		);
		expect(f.listed()).toEqual([{ id: "pi-b", status: "online", external: true }]);
		f.supervisor.unregisterExternal("pi-b", "quit");
		expect(f.supervisor.saveInstance({ cwd: f.dir, sessionFile: f.file })).toMatchObject({ sessionFile: f.file });
		expect(f.listed()).toEqual([{ id: "pi-b", status: "stopped" }]);
		expect(f.ended).toEqual([]);
	});

	it("a deleted pane beating after a daemon restart is still ended, not listed", async () => {
		const f = fixture();
		await states.live(f);
		f.supervisor.deleteInstance(ROW);
		f.restart();
		f.beat();
		expect(f.listed()).toEqual([]);
		expect(f.ended).toEqual(["pi-a"]);
	});

	it("a deleted row is kept so while tmux may have its pane, then for a late hand-off save", async () => {
		/** Deleted, its pane then gone from tmux, `ms` later its hand-off saves. */
		const saveAfter = async (ms: number) => {
			const f = fixture();
			await states.live(f);
			f.supervisor.deleteInstance(ROW);
			f.lapse("unknown");
			f.pass(3_600_000, "up");
			f.beat();
			expect(f.ended).toEqual(["pi-a"]);
			f.lapse("gone");
			f.pass(ms, "gone");
			listSummaries(f.supervisor);
			return f.supervisor.saveInstance({ cwd: f.dir, sessionFile: f.file });
		};
		expect(await saveAfter(START_MS - 25_000)).toBeUndefined();
		// Its record has gone by then: a save so late is a new session's.
		expect(await saveAfter(START_MS + 1)).toMatchObject({ status: "stopped" });
	});
});

describe("listing in either order gives the same rows", () => {
	/** Stored rows and panes' rows, each list read in the order given. */
	const both = (f: Fixture, panesFirst: boolean) => {
		const readPanes = () =>
			f.supervisor
				.listExternalInstances()
				.map(({ record, silent }) => ({ id: record.id, status: record.status, silent }));
		const readStored = () => f.supervisor.listInstances().map(({ id, status }) => ({ id, status }));
		const panes = panesFirst ? readPanes() : undefined;
		const stored = readStored();
		return { stored, panes: panes ?? readPanes() };
	};

	it.each<[string, string, (f: Fixture) => void]>([
		["live", "TTL lapse, tmux up", (f) => f.pass(20_000)],
		["live", "TTL lapse, tmux gone", (f) => f.pass(20_000, "gone")],
		["live", "TTL lapse, tmux could not answer", (f) => f.pass(20_000, "unknown")],
		["silent", "tmux no longer has it", (f) => f.pass(0, "gone")],
		["starting", "its start expired", (f) => f.pass(START_MS + 1)],
	])("%s, then %s", async (from, _, event) => {
		const [storedFirst, panesFirst] = [fixture(), fixture()];
		for (const f of [storedFirst, panesFirst]) {
			await states[from](f);
			event(f);
		}
		expect(both(storedFirst, false)).toEqual(both(panesFirst, true));
	});
});
