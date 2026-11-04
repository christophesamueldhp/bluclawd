// test/remote-sessions.test.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIpcRequest, listSummaries } from "../daemon/handler.ts";
import type { InstanceSummary, PaneHeartbeat } from "../daemon/ipc/protocol.ts";
import { findSession, remoteSessions } from "../daemon/remote/sessions.ts";
import { collectRows } from "../daemon/rows.ts";
import { ServerSupervisor } from "../daemon/supervisor.ts";
import { testRegistry } from "./helpers/registry.ts";

const live = (
	id: string,
	activity: InstanceSummary["activity"],
	extra: Partial<InstanceSummary> = {},
): InstanceSummary => ({
	id,
	status: "online",
	cwd: "/p",
	external: true,
	activity,
	createdAt: "2026-10-12T00:00:00Z",
	sessionFile: `/s/${id}.jsonl`,
	...extra,
});

describe("remote sessions", () => {
	it("groups rows into agent view's bands, Needs input first", () => {
		const sessions = remoteSessions([
			live("a", "idle", { label: "idle one" }),
			live("b", "working", { detail: "npm test" }),
			live("c", "awaiting_input"),
		]);
		expect(sessions.map((s) => [s.id, s.band])).toEqual([
			["c", "needs"],
			["b", "working"],
			["a", "idle"],
		]);
		expect(sessions[1]).toMatchObject({ detail: "npm test", alive: true, state: "working" });
		expect(sessions[2].label).toBe("idle one");
	});

	it("carries how many times each session stopped working", () => {
		expect(remoteSessions([live("a", "idle", { settled: 3 })])[0].settled).toBe(3);
	});

	it("lists both panes running one session file, each saying how many share it", () => {
		const sessions = remoteSessions([
			live("a", "idle", { sessionFile: "/s/x.jsonl" }),
			live("b", "idle", { sessionFile: "/s/x.jsonl" }),
			live("c", "idle"),
		]);
		expect(sessions.map((s) => [s.id, s.livePanes]).sort()).toEqual([
			["a", 2],
			["b", 2],
			["c", undefined],
		]);
	});

	it("puts pinned rows in their own band, first", () => {
		const sessions = remoteSessions([live("a", "working"), live("p", "idle", { pinned: true })]);
		expect(sessions.map((s) => [s.id, s.band])).toEqual([
			["p", "pinned"],
			["a", "working"],
		]);
	});

	it("lists a stored row as not alive", () => {
		const stored: InstanceSummary = {
			id: "old",
			status: "stopped",
			cwd: "/p",
			sessionFile: "/s/x.jsonl",
			outcome: "done",
		};
		expect(remoteSessions([stored])[0]).toMatchObject({ id: "old", alive: false, band: "idle" });
		const { sessionFile: _, ...fileless } = stored;
		expect(remoteSessions([fileless])[0]).toMatchObject({ id: "old", alive: false });
	});

	it("says a session is starting until its pane registers", () => {
		const supervisor = testRegistry();
		supervisor.paneStarting({ cwd: "/p", label: "new task", pane: "pi-n" });
		expect(remoteSessions(listSummaries(supervisor))).toEqual([
			expect.objectContaining({ id: "pi-n", starting: true, detail: "starting…" }),
		]);
		supervisor.registerExternal(
			{ id: "pi-n", status: "online", cwd: "/p", createdAt: "2026-10-12T00:00:00Z" },
			"idle",
		);
		expect(remoteSessions(listSummaries(supervisor))[0]).not.toHaveProperty("starting");
	});

	it("finds a session's file, whether a pane runs it and whether it is mid-turn", () => {
		const stored: InstanceSummary = { id: "old", status: "stopped", cwd: "/p", sessionFile: "/s/old.jsonl" };
		const list = [
			stored,
			live("b", "idle", { leafId: "e3", sessionId: "pi-b" }),
			live("c", "working"),
			live("d", "awaiting_input"),
		];
		// Its pane's start and pi's session id: what the pane's pistatusline shows of it.
		expect(findSession(list, "b")).toEqual({
			sessionFile: "/s/b.jsonl",
			cwd: "/p",
			running: true,
			verdict: { act: true },
			busy: false,
			leafId: "e3",
			createdAt: "2026-10-12T00:00:00Z",
			sessionId: "pi-b",
		});
		expect(findSession(list, "c")).toMatchObject({ running: true, busy: true });
		expect(findSession(list, "d")).toMatchObject({ running: true, busy: true });
		expect(findSession(list, "old")).toEqual({
			sessionFile: "/s/old.jsonl",
			cwd: "/p",
			running: false,
			verdict: { act: false, reason: "not_running" },
			busy: false,
		});
		expect(findSession(list, "zzz")).toBeUndefined();
	});
});

describe("remote sessions through the daemon", () => {
	let supervisor: ServerSupervisor;
	beforeEach(() => {
		supervisor = testRegistry();
	});
	afterEach(() => vi.useRealTimers());

	it("keeps idle panes in the order their last turns ended, whichever heartbeat came last", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const beat = (id: string, finishedAt: string) =>
			handleIpcRequest(supervisor, {
				type: "register",
				instance: { id, cwd: "/p", activity: "idle", turns: 1, sessionFile: `/s/${id}.jsonl`, finishedAt },
			});
		const order = () => remoteSessions(listSummaries(supervisor)).map((s) => [s.id, s.finishedAt]);
		vi.setSystemTime(Date.parse("2026-10-15T10:00:00Z"));
		await beat("pi-older", "2026-10-15T09:00:00.000Z");
		vi.setSystemTime(Date.parse("2026-10-15T10:00:01Z"));
		await beat("pi-newer", "2026-10-15T09:30:00.000Z");
		const expected = [
			["pi-newer", "2026-10-15T09:30:00.000Z"],
			["pi-older", "2026-10-15T09:00:00.000Z"],
		];
		expect(order()).toEqual(expected);
		// The older one's heartbeat is now the latest: its row stays where its last turn put it.
		vi.setSystemTime(Date.parse("2026-10-15T10:00:03Z"));
		await beat("pi-older", "2026-10-15T09:00:00.000Z");
		expect(order()).toEqual(expected);
	});

	it("says which dialog a session waits on, only while it needs input", async () => {
		const dialog = { kind: "confirm", title: "Allow bash?" };
		const beat = (activity: "awaiting_input" | "working") =>
			handleIpcRequest(supervisor, {
				type: "register",
				instance: { id: "pi-d", cwd: "/p", activity, dialog, detail: "Waiting: Allow bash?" },
			});
		await beat("awaiting_input");
		expect(remoteSessions(listSummaries(supervisor))[0]).toMatchObject({
			state: "needs",
			detail: "Waiting: Allow bash?",
			dialog,
		});
		await beat("working");
		expect(remoteSessions(listSummaries(supervisor))[0]).not.toHaveProperty("dialog");
	});
});

describe("a pane's heartbeat, from its register request to agent view's row and the phone's session", () => {
	// Every field the type has: a field added to it without a value here fails the typecheck.
	const heartbeat = {
		cwd: "/p",
		sessionId: "pi-h",
		sessionFile: "/s/h.jsonl",
		label: "deploy",
		pane: "bluclawd-h",
		detail: "Waiting: Allow bash?",
		turns: 2,
		createdAt: "2026-10-12T00:00:00.000Z",
		finishedAt: "2026-10-12T00:05:00.000Z",
		leafId: "e7",
		dialog: { kind: "confirm", title: "Allow bash?" },
		draft: true,
	} satisfies Required<PaneHeartbeat>;

	it("carries every field to the listed summary, and each the row and the phone show", async () => {
		const supervisor = testRegistry();
		await handleIpcRequest(supervisor, {
			type: "register",
			instance: { ...heartbeat, id: "pi-h", activity: "awaiting_input", launch: { command: ["pi"] } },
		});
		const summaries = listSummaries(supervisor);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			...heartbeat,
			id: "pi-h",
			status: "online",
			activity: "awaiting_input",
			external: true,
		});
		expect(summaries[0]).not.toHaveProperty("launch");
		expect(collectRows(summaries, undefined)[0]).toMatchObject({
			id: "pi-h",
			label: "deploy",
			cwd: "/p",
			sessionFile: "/s/h.jsonl",
			state: "needs",
			alive: true,
			detail: "Waiting: Allow bash?",
			createdAt: "2026-10-12T00:00:00.000Z",
			finishedAt: "2026-10-12T00:05:00.000Z",
			pane: "bluclawd-h",
			dialog: heartbeat.dialog,
		});
		expect(remoteSessions(summaries)).toEqual([
			{
				id: "pi-h",
				label: "deploy",
				cwd: "/p",
				band: "needs",
				state: "needs",
				alive: true,
				detail: "Waiting: Allow bash?",
				createdAt: "2026-10-12T00:00:00.000Z",
				finishedAt: "2026-10-12T00:05:00.000Z",
				dialog: heartbeat.dialog,
				settled: 0,
				verdict: { act: true },
			},
		]);
		expect(findSession(summaries, "pi-h")).toEqual({
			sessionFile: "/s/h.jsonl",
			cwd: "/p",
			running: true,
			verdict: { act: true },
			busy: true,
			leafId: "e7",
			pane: "bluclawd-h",
			draft: true,
			createdAt: "2026-10-12T00:00:00.000Z",
			sessionId: "pi-h",
		});
	});

	it("takes an older pane's flat request, which has none of the fields added since", async () => {
		const supervisor = testRegistry();
		// The register request's shape before a pane said its leaf, dialog, draft or launch command.
		await handleIpcRequest(supervisor, {
			type: "register",
			instance: {
				id: "pi-old",
				cwd: "/p",
				sessionId: "pi-o",
				sessionFile: "/s/old.jsonl",
				label: "older",
				activity: "working",
				pane: "bluclawd-old",
				detail: "running tests",
				turns: 1,
				createdAt: "2026-10-12T00:00:00.000Z",
			},
		});
		expect(remoteSessions(listSummaries(supervisor))).toEqual([
			{
				id: "pi-old",
				label: "older",
				cwd: "/p",
				band: "working",
				state: "working",
				alive: true,
				detail: "running tests",
				createdAt: "2026-10-12T00:00:00.000Z",
				finishedAt: undefined,
				settled: 0,
				verdict: { act: true },
			},
		]);
		expect(findSession(listSummaries(supervisor), "pi-old")).toEqual({
			sessionFile: "/s/old.jsonl",
			cwd: "/p",
			running: true,
			verdict: { act: true },
			busy: true,
			pane: "bluclawd-old",
			createdAt: "2026-10-12T00:00:00.000Z",
			sessionId: "pi-o",
		});
	});
});

/** A registry on its own dir and clock, whose tmux has every pane but those in `gone`. */
function silentRegistry() {
	const dir = mkdtempSync(join(tmpdir(), "bluclawd-silent-"));
	const clock = { now: 1_000_000 };
	const gone = new Set<string>();
	const supervisor = new ServerSupervisor({
		now: () => clock.now,
		tmux: { hasSession: (name) => !gone.has(name) },
		dir,
	});
	const beat = (id: string, sessionFile: string) =>
		supervisor.registerExternal(
			{ id, status: "online", cwd: dir, createdAt: "2026-10-12T00:00:00Z", sessionFile, pane: id, label: "task" },
			"working",
		);
	/** No heartbeat for longer than the registry waits, and a look at the list reaps it. */
	const reap = () => {
		clock.now += 20_000;
		listSummaries(supervisor);
	};
	return { dir, supervisor, gone, beat, reap, list: () => remoteSessions(listSummaries(supervisor)) };
}

describe("a pane reaped while tmux still has it (a silent pane)", () => {
	it("stays listed as its row, alive and said to be silent, and its file is not started again", () => {
		const { dir, supervisor, beat, reap, list } = silentRegistry();
		const file = join(dir, "s.jsonl");
		writeFileSync(file, "");
		beat("pi-s", file);
		expect(list()).toEqual([expect.objectContaining({ id: "pi-s", alive: true })]);
		expect(list()[0]).not.toHaveProperty("silent");
		reap();
		expect(list()).toEqual([expect.objectContaining({ id: "pi-s", alive: true, silent: true, state: "working" })]);
		expect(supervisor.claimStart({ cwd: dir, sessionFile: file })).toEqual({ ok: false, refused: "running" });
	});

	it("stays deleted once its row is deleted, past its tmux session's end and its pi's hand-off save", () => {
		const { dir, supervisor, gone, beat, reap, list } = silentRegistry();
		const file = join(dir, "s.jsonl");
		writeFileSync(file, "");
		beat("pi-s", file);
		reap();
		expect(supervisor.deleteInstance("pi-s")).toBe(true);
		expect(list()).toEqual([]);
		gone.add("pi-s");
		expect(list()).toEqual([]);
		expect(supervisor.saveInstance({ cwd: dir, label: "task", sessionFile: file })).toBeUndefined();
		expect(list()).toEqual([]);
	});

	it("is stopped, with its finish time, once tmux no longer has it", () => {
		const { dir, gone, beat, reap, list } = silentRegistry();
		const file = join(dir, "s.jsonl");
		writeFileSync(file, "");
		beat("pi-s", file);
		reap();
		expect(list()[0]).toMatchObject({ silent: true });
		gone.add("pi-s");
		expect(list()).toEqual([expect.objectContaining({ id: "pi-s", alive: false, state: "stopped" })]);
		expect(list()[0].finishedAt).toBeDefined();
		expect(list()[0]).not.toHaveProperty("silent");
	});

	it.each([
		["a stored row", true],
		["a row a start claimed, its file not written yet", false],
	])("shows a pin and order given while silent at once, and keeps them as it beats again: %s", (_, written) => {
		const { dir, supervisor, beat, reap } = silentRegistry();
		const file = join(dir, "s.jsonl");
		let row = "pi-s";
		if (written) writeFileSync(file, "");
		else {
			const claim = supervisor.claimStart({ cwd: dir, sessionFile: file });
			if (!claim.ok) throw new Error("not claimed");
			row = claim.id;
		}
		beat("pi-s", file);
		reap();
		expect(supervisor.setInstanceMeta(row, { pinned: true, sortOrder: 2 })).toMatchObject({ id: row, pinned: true });
		const listed = () => listSummaries(supervisor).find((i) => i.id === row);
		expect(listed()).toMatchObject({ silent: true, pinned: true, sortOrder: 2 });
		beat("pi-s", file);
		expect(listed()).toMatchObject({ pinned: true, sortOrder: 2 });
		expect(listed()).not.toHaveProperty("silent");
	});

	it("refreshes its row as a pane's does when it unregisters for another session", () => {
		const { dir, supervisor, beat, reap } = silentRegistry();
		const file = join(dir, "s.jsonl");
		writeFileSync(file, "");
		beat("pi-s", file);
		reap();
		const last = { role: "assistant", content: [{ type: "text", text: "last words" }], stopReason: "stop" };
		writeFileSync(file, `${JSON.stringify({ type: "message", message: last })}\n`);
		supervisor.unregisterExternal("pi-s", "new");
		const row = listSummaries(supervisor).find((i) => i.id === "pi-s");
		expect(row).toMatchObject({ status: "stopped", detail: "last words" });
		expect(row?.finishedAt).toBeDefined();
	});

	it("stays listed when a start claimed its row and pi has not written its file yet", () => {
		const { dir, supervisor, beat, reap, list } = silentRegistry();
		const file = join(dir, "new.jsonl");
		const claim = supervisor.claimStart({ cwd: dir, sessionFile: file });
		if (!claim.ok) throw new Error("not claimed");
		beat("pi-c", file);
		reap();
		expect(list()).toEqual([expect.objectContaining({ id: claim.id, alive: true, silent: true })]);
		expect(supervisor.claimStart({ cwd: dir, sessionFile: file })).toEqual({ ok: false, refused: "running" });
	});
});

describe("each listed row's verdict on whether a Chat may act on it", () => {
	it("lets a Chat act on a live pane's row only: not a silent one's, a starting one's or a stored one's", () => {
		const { dir, supervisor, beat, reap, list } = silentRegistry();
		const [live, silent, stored, starting] = ["live", "silent", "stored", "starting"].map((name) => {
			const file = join(dir, `${name}.jsonl`);
			writeFileSync(file, "");
			return file;
		});
		beat("pi-silent", silent);
		beat("pi-stored", stored);
		supervisor.unregisterExternal("pi-stored", "quit");
		reap();
		beat("pi-live", live);
		const claim = supervisor.claimStart({ cwd: dir, sessionFile: starting });
		if (!claim.ok) throw new Error("not claimed");
		expect(Object.fromEntries(list().map((s) => [s.id, s.verdict]))).toEqual({
			"pi-live": { act: true },
			"pi-silent": { act: false, reason: "silent" },
			"pi-stored": { act: false, reason: "not_running" },
			[claim.id]: { act: false, reason: "starting" },
		});
		// Still its pane's row, alive.
		expect(list().find((s) => s.id === "pi-silent")).toMatchObject({ alive: true, silent: true });
	});
});
