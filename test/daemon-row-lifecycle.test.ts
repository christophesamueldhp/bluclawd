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
	const supervisor = testRegistry(dir, () => clock.now, {
		hasSession: (name) => {
			const said = tmux.get(name) ?? "up";
			if (said === "unknown") throw new Error("tmux timed out");
			return said === "up";
		},
		end: () => {},
	});
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
	return { dir, tmux, supervisor, file, other, pass, beat, lapse, listed, outcomes };
}

type Fixture = ReturnType<typeof fixture>;

const states: Record<string, (f: Fixture) => void> = {
	stored: () => {},
	starting: (f) => {
		f.supervisor.claimStart({ cwd: f.dir, sessionFile: f.file });
	},
	/** `p-given` taken by its pane's heartbeat, and `p-inbox` still in its inbox. */
	live: (f) => {
		f.beat();
		f.supervisor.sendExternal(ROW, { type: "prompt", text: "given", id: "p-given" });
		f.supervisor.drainExternal("pi-a");
		f.supervisor.sendExternal(ROW, { type: "prompt", text: "inbox", id: "p-inbox" });
	},
	silent: (f) => {
		states.live(f);
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
	])("%s, then %s", (from, _, event, rows, outcomes = []) => {
		const f = fixture();
		states[from](f);
		event(f);
		expect(f.listed()).toEqual(rows);
		expect(f.outcomes()).toEqual(outcomes);
	});

	it.each(["live", "silent"])("a %s row takes a message only while live", (from) => {
		const f = fixture();
		states[from](f);
		expect(f.supervisor.sendExternal(ROW, { type: "abort" })).toBe(from === "live");
	});

	it.each([
		["starting", "starting"],
		["live", "running"],
		["silent", "running"],
	])("a %s row refuses a start on its file", (from, refused) => {
		const f = fixture();
		states[from](f);
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

	it("a Silent pane another pane went on as its row is listed no more, and ends without stopping that row", () => {
		const f = fixture();
		states.silent(f);
		f.supervisor.registerExternal(
			{ id: "pi-b", status: "online", cwd: f.dir, createdAt, sessionFile: f.file, pane: "pi-b" },
			"idle",
		);
		expect(f.listed()).toEqual([live]);
		expect(f.supervisor.rowIdOf("pi-a")).toBe(ROW);
		f.tmux.set("pi-a", "gone");
		expect(f.listed()).toEqual([live]);
		expect(f.outcomes()).toEqual(held("lost", "lost"));
		expect(f.supervisor.sendExternal(ROW, { type: "abort" })).toBe(true);
		expect(f.supervisor.drainExternal("pi-b")).toEqual([{ type: "abort" }]);
	});

	it("a start claimed past a live pane's TTL, before any list, leaves that pane its row and its inbox", () => {
		const f = fixture();
		states.live(f);
		f.supervisor.sendExternal(ROW, { type: "abort" });
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

	it("a pane a start claimed the row for, past its live pane's TTL, takes that row's inbox", () => {
		const f = fixture();
		states.live(f);
		f.pass(20_000);
		f.supervisor.claimStart({ cwd: f.dir, sessionFile: f.file });
		f.supervisor.registerExternal(
			{ id: "pi-b", status: "online", cwd: f.dir, createdAt, sessionFile: f.file, pane: "pi-b" },
			"idle",
		);
		expect(f.supervisor.drainExternal("pi-b")).toEqual([{ type: "prompt", text: "inbox", id: "p-inbox" }]);
		expect(f.outcomes()).toEqual(held("sent", "sent"));
	});

	it("a row deleted while silent stays deleted once its pane ends and its hand-off saves", () => {
		const f = fixture();
		states.silent(f);
		f.supervisor.deleteInstance(ROW);
		f.supervisor.unregisterExternal("pi-a", "quit");
		f.tmux.set("pi-a", "gone");
		expect(f.supervisor.saveInstance({ cwd: f.dir, sessionFile: f.file })).toBeUndefined();
		expect(f.listed()).toEqual([]);
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
	])("%s, then %s", (from, _, event) => {
		const [storedFirst, panesFirst] = [fixture(), fixture()];
		for (const f of [storedFirst, panesFirst]) {
			states[from](f);
			event(f);
		}
		expect(both(storedFirst, false)).toEqual(both(panesFirst, true));
	});
});
