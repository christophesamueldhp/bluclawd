import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	addPending,
	applyLatest,
	applyOlder,
	checkPending,
	forget,
	KEEP_MS,
	listed,
	openChat,
	replyEndedAt,
	restorePending,
	settleOutcomes,
	storedPending,
} from "#remote-web/chat.js";
import { listSummaries } from "../daemon/handler.ts";
import { DELIVERY_KEEP_MS } from "../daemon/remote/delivery.ts";
import { findSession, remoteSessions } from "../daemon/remote/sessions.ts";
import { testRegistry } from "./helpers/registry.ts";

const user = (id: string, text: string) => ({ kind: "user", id, text });
const reply = (id: string, text = "ok") => ({ kind: "assistant", id, text, tools: [] });
const result = (toolCallId: string) => ({ kind: "toolResult", id: `r-${toolCallId}`, toolCallId, ok: true, text: "" });

describe("the open chat's transcript", () => {
	it("keeps the older messages a latest page follows on from", () => {
		const chat = openChat("a");
		chat.messages = [reply("1"), reply("2"), reply("3")];
		chat.more = true;
		applyLatest(chat, { messages: [reply("2"), reply("3"), reply("4")], more: false });
		expect(chat.messages.map((m) => m.id)).toEqual(["1", "2", "3", "4"]);
		expect(chat.more).toBe(true);
		expect(chat.messagesLoaded).toBe(true);
	});

	it("replaces them after the session moved, and a pending prompt no longer counts their copies", () => {
		const chat = openChat("a");
		chat.messages = [user("1", "hi"), reply("2")];
		const entry = addPending(chat, "hi", [], 100);
		expect(entry.before).toBe(1);
		applyLatest(chat, { messages: [reply("9")], more: true });
		expect(chat.messages.map((m) => m.id)).toEqual(["9"]);
		expect(chat.more).toBe(true);
		expect(chat.pending).toEqual([entry]);
		expect(entry.before).toBe(0);
		applyLatest(chat, { messages: [reply("9"), user("10", "hi")], more: true });
		expect(chat.pending).toEqual([]);
	});

	it("puts an older page above, counting its copies of a pending prompt", () => {
		const chat = openChat("a");
		chat.messages = [reply("5")];
		const entry = addPending(chat, "hi", [], 100);
		expect(applyOlder(chat, chat.messages[0], { messages: [user("4", "hi")], more: false })).toBe(true);
		expect(chat.messages.map((m) => m.id)).toEqual(["4", "5"]);
		expect(entry.before).toBe(1);
		expect(chat.pending).toEqual([entry]);
	});

	it("drops an older page that arrives after a refresh replaced the log", () => {
		const chat = openChat("a");
		const first = reply("5");
		chat.messages = [reply("7")];
		chat.more = true;
		expect(applyOlder(chat, first, { messages: [reply("4")], more: false })).toBe(false);
		expect(chat.messages.map((m) => m.id)).toEqual(["7"]);
		expect(chat.more).toBe(true);
	});

	it("settles the reply in progress once the transcript has it", () => {
		const chat = openChat("a");
		chat.live = { text: "done", tools: [] };
		chat.liveEnded = true;
		applyLatest(chat, { messages: [reply("1", "done")], more: false });
		expect(chat.live).toBeUndefined();
	});
});

describe("a reply its pane says ended at a transcript entry", () => {
	const running = { id: "c1", name: "bash", summary: "ls", running: true };

	it("keeps its text through a tool-only snapshot, until a page has the entry", () => {
		const chat = openChat("a");
		chat.live = { text: "Let me look", tools: [{ ...running, running: false }] };
		replyEndedAt(chat, "x");
		chat.live = { text: "", tools: [running] };
		applyLatest(chat, { messages: [reply("1", "Earlier")], more: false });
		expect(chat.held).toEqual([{ entryId: "x", text: "Let me look" }]);
		expect(chat.live).toEqual({ text: "", tools: [running] });
		applyLatest(chat, { messages: [reply("1", "Earlier"), reply("x", "Let me look")], more: false });
		expect(chat.held).toEqual([]);
		expect(chat.live).toEqual({ text: "", tools: [running] });
	});

	it("drops it by the entry even when the transcript's text differs, as another extension edited it", () => {
		const chat = openChat("a");
		chat.live = { text: "Draft", thinking: "hmm", tools: [] };
		replyEndedAt(chat, "x");
		expect(chat.live).toBeUndefined();
		expect(chat.held).toEqual([{ entryId: "x", text: "Draft", thinking: "hmm" }]);
		applyLatest(chat, { messages: [reply("x", "Edited")], more: false });
		expect(chat.held).toEqual([]);
	});

	it("keeps it after a bare end too, which settles only what is still live", () => {
		const chat = openChat("a");
		chat.live = { text: "Hi", tools: [] };
		replyEndedAt(chat, "x");
		chat.live = { text: "", tools: [running] };
		chat.liveEnded = true;
		applyLatest(chat, { messages: [reply("1", "Hi"), result("c1")], more: false });
		expect(chat.held).toEqual([{ entryId: "x", text: "Hi" }]);
		expect(chat.live).toBeUndefined();
	});

	it("holds its thinking alone, and nothing for a reply of tools only", () => {
		const chat = openChat("a");
		chat.live = { text: "", thinking: "hmm", tools: [] };
		replyEndedAt(chat, "x");
		chat.live = { text: "", tools: [running] };
		replyEndedAt(chat, "y");
		expect(chat.held).toEqual([{ entryId: "x", text: "", thinking: "hmm" }]);
		expect(chat.live).toEqual({ text: "", tools: [running] });
	});

	it("holds each of two replies until a page has its own entry", () => {
		const chat = openChat("a");
		chat.live = { text: "One", tools: [] };
		replyEndedAt(chat, "x");
		chat.live = { text: "Two", tools: [] };
		replyEndedAt(chat, "y");
		expect(chat.held.map((h) => h.text)).toEqual(["One", "Two"]);
		applyLatest(chat, { messages: [reply("x", "One")], more: false });
		expect(chat.held.map((h) => h.text)).toEqual(["Two"]);
	});

	it("drops one whose entry a page never shows once a page has a later reply's", () => {
		const chat = openChat("a");
		chat.live = { text: "Emptied by another extension", tools: [] };
		replyEndedAt(chat, "x");
		chat.live = { text: "Next", tools: [] };
		replyEndedAt(chat, "y");
		applyLatest(chat, { messages: [reply("1", "Earlier"), reply("y", "Next")], more: false });
		expect(chat.held).toEqual([]);
	});
});

describe("prompts sent from the chat", () => {
	it("are marked started while the session works", () => {
		const chat = openChat("a");
		const entry = addPending(chat, "go", [], 100);
		expect(listed(chat, "idle", "working", 200)).toBe(false);
		expect(entry.started).toBe(true);
	});

	it("are dropped when the turn ends, unless sent after it", () => {
		const chat = openChat("a");
		addPending(chat, "early", [], 100);
		const late = addPending(chat, "late", [], 300);
		expect(listed(chat, "working", "idle", 200)).toBe(true);
		applyLatest(chat, { messages: [], more: false });
		expect(chat.pending).toEqual([late]);
		applyLatest(chat, { messages: [], more: false });
		expect(chat.pending).toEqual([late]);
	});

	it("stay past the turn's end once queued by a pane that reports outcomes, which settles them", () => {
		const chat = openChat("a");
		chat.report = { models: [], outcomes: [] };
		const queued = addPending(chat, "queued", [], 100);
		addPending(chat, "sent", [], 100);
		settleOutcomes(chat, [{ id: queued.id, outcome: "queued" }]);
		expect(listed(chat, "working", "idle", 200)).toBe(true);
		applyLatest(chat, { messages: [], more: false });
		expect(chat.pending).toEqual([queued]);
		// Then pi dropped it from its queue: it comes back.
		expect(settleOutcomes(chat, [{ id: queued.id, outcome: "lost", reason: "dequeued" }])).toEqual([
			{ entry: queued, reason: "dequeued" },
		]);
	});

	it("keep waiting while a dialog is up", () => {
		const chat = openChat("a");
		addPending(chat, "go", [], 100);
		expect(listed(chat, "working", "needs", 200)).toBe(false);
		expect(chat.turnEndedAt).toBeUndefined();
	});

	it("count the same text sent before them, and stop counting one forgotten", () => {
		const chat = openChat("a");
		const first = addPending(chat, "again", [], 100);
		const second = addPending(chat, "again", [], 200);
		expect(second.before).toBe(1);
		forget(chat, first);
		expect(chat.pending).toEqual([second]);
		expect(second.before).toBe(0);
	});

	it("are keyed as the transcript will show them, with their images", () => {
		const chat = openChat("a");
		const image = { mimeType: "image/png", data: "", thumb: "" };
		const entry = addPending(chat, "look", [image], 100);
		expect(entry.text).toBe("look\n[Image]");
		expect(entry.images).toEqual([image]);
	});

	it("go back to the reply box when they never reached the session", () => {
		const chat = openChat("a");
		chat.messages = [reply("1")];
		const entry = addPending(chat, "go", [], 100);
		expect(checkPending(chat, entry, "idle")).toBe("fail");
		expect(chat.pending).toEqual([]);
	});

	it("wait on while the session works", () => {
		const chat = openChat("a");
		const entry = addPending(chat, "go", [], 100);
		expect(checkPending(chat, entry, "working")).toBe("wait");
		expect(chat.pending).toEqual([entry]);
	});
});

describe("prompts sent to a pane that reports their outcomes", () => {
	/** A pane from this build: its report carries outcomes, none yet. */
	const reporting = () => {
		const chat = openChat("a");
		chat.report = { models: [], outcomes: [] };
		chat.messages = [reply("1")];
		return chat;
	};

	it("each get an id of their own, the same text too", () => {
		const chat = reporting();
		const first = addPending(chat, "again", [], 100);
		const second = addPending(chat, "again", [], 200);
		expect(first.id).toMatch(/^[\w-]{1,64}$/);
		expect(second.id).not.toBe(first.id);
	});

	it("are settled by their own id, not by the transcript's text", () => {
		const chat = reporting();
		const first = addPending(chat, "again", [], 100);
		const second = addPending(chat, "again", [], 200);
		// The transcript has the text, with a note pi added to it: still waiting on the pane's word.
		applyLatest(chat, { messages: [reply("1"), user("2", "again")], more: false });
		expect(chat.pending).toEqual([first, second]);
		settleOutcomes(chat, [{ id: second.id, outcome: "queued" }]);
		expect(second.outcome).toBe("queued");
		// Taken, and the transcript moved past it: it is there, not pending.
		settleOutcomes(chat, [
			{ id: first.id, outcome: "taken" },
			{ id: second.id, outcome: "queued" },
		]);
		expect(chat.pending).toEqual([second]);
		// A queued one waits for pi to start it, never failing meanwhile.
		expect(checkPending(chat, second, "idle")).toBe("wait");
		applyLatest(chat, { messages: [reply("1"), user("2", "again"), reply("3")], more: false });
		expect(chat.pending).toEqual([second]);
		settleOutcomes(chat, [{ id: second.id, outcome: "taken" }]);
		expect(chat.pending).toEqual([]);
	});

	it("show taken until the transcript has them", () => {
		const chat = reporting();
		const entry = addPending(chat, "go", [], 100);
		settleOutcomes(chat, [{ id: entry.id, outcome: "taken" }]);
		expect(chat.pending).toEqual([entry]);
		expect(entry.outcome).toBe("taken");
		applyLatest(chat, { messages: [reply("1"), user("2", "go")], more: false });
		expect(chat.pending).toEqual([]);
	});

	it("still fail at the give-up when no outcome came", () => {
		const chat = reporting();
		const entry = addPending(chat, "go", [], 100);
		// The daemon has it, and the pane has said nothing of it.
		expect(settleOutcomes(chat, [{ id: entry.id, outcome: "sent" }])).toEqual([]);
		expect(checkPending(chat, entry, "idle")).toBe("fail");
	});

	it("come back, saying why, when their pane refused them or they were lost", () => {
		const chat = reporting();
		const refused = addPending(chat, "go", [], 100);
		const lost = addPending(chat, "go", [], 200);
		const kept = addPending(chat, "go", [], 300);
		expect(
			settleOutcomes(chat, [
				{ id: refused.id, outcome: "refused", reason: "compacting" },
				{ id: lost.id, outcome: "lost", reason: "pane_gone" },
			]),
		).toEqual([
			{ entry: refused, reason: "compacting" },
			{ entry: lost, reason: "pane_gone" },
		]);
		expect(chat.pending).toEqual([kept]);
		// No longer counted: the one left is the transcript's next "go".
		expect(kept.before).toBe(0);
		// Each comes back once.
		expect(settleOutcomes(chat, [{ id: refused.id, outcome: "refused", reason: "compacting" }])).toEqual([]);
	});

	it("come back once queued when pi dropped them from its queue", () => {
		const chat = reporting();
		const entry = addPending(chat, "go", [], 100);
		expect(settleOutcomes(chat, [{ id: entry.id, outcome: "queued" }])).toEqual([]);
		expect(settleOutcomes(chat, [{ id: entry.id, outcome: "lost", reason: "dequeued" }])).toEqual([
			{ entry, reason: "dequeued" },
		]);
		expect(chat.pending).toEqual([]);
	});

	it("are done once taken when they are a slash command or a ! line, which the transcript may never show", () => {
		const chat = reporting();
		const command = addPending(chat, "/compact", [], 100);
		const shell = addPending(chat, "!ls", [], 200);
		const prompt = addPending(chat, "/tmp/a is gone", [], 300);
		settleOutcomes(
			chat,
			[command, shell, prompt].map(({ id }) => ({ id, outcome: "taken" as const })),
		);
		expect(chat.pending).toEqual([prompt]);
	});

	it("are lost when the daemon replays what it knows after a reconnect and lacks them: it restarted", () => {
		const chat = reporting();
		const known = addPending(chat, "a", [], 100);
		const forgotten = addPending(chat, "b", [], 110);
		const later = addPending(chat, "c", [], 120);
		const unanswered = addPending(chat, "d", [], 130);
		known.acceptedAt = 150;
		forgotten.acceptedAt = 160;
		// Accepted after the stream it replays on was asked for: that daemon may not have had it yet.
		later.acceptedAt = 250;
		expect(settleOutcomes(chat, [{ id: known.id, outcome: "sent" }], 200)).toEqual([
			{ entry: forgotten, reason: "daemon_restarted" },
		]);
		expect(chat.pending).toEqual([known, later, unanswered]);
		// Not on a status, which carries only what changed since the stream opened.
		expect(settleOutcomes(chat, [], undefined)).toEqual([]);
	});

	it("are not put back by a restarted daemon's replay once pi has them, taken or queued", () => {
		const chat = reporting();
		const taken = addPending(chat, "a", [], 100);
		const queued = addPending(chat, "b", [], 110);
		settleOutcomes(chat, [
			{ id: taken.id, outcome: "taken" },
			{ id: queued.id, outcome: "queued" },
		]);
		taken.acceptedAt = queued.acceptedAt = 150;
		expect(settleOutcomes(chat, [], 200)).toEqual([]);
		expect(chat.pending).toEqual([taken, queued]);
	});

	it("are not judged lost by a replay for a pane from an older build", () => {
		const chat = openChat("a");
		chat.report = { models: [] };
		const entry = addPending(chat, "a", [], 100);
		entry.acceptedAt = 150;
		expect(settleOutcomes(chat, [], 200)).toEqual([]);
		expect(chat.pending).toEqual([entry]);
	});
});

describe("prompts pending when the app reloads or the chat is left, kept on the phone", () => {
	const reporting = () => {
		const chat = openChat("a");
		chat.report = { models: [], outcomes: [] };
		chat.messages = [reply("1")];
		return chat;
	};
	/** What the phone kept of the chat, as browser storage gives it back. */
	const kept = (chat: ReturnType<typeof openChat>) => JSON.parse(JSON.stringify(storedPending(chat) ?? []));

	it("are settled by id from the daemon's replay when the chat opens again, and put back when refused or lost", () => {
		const before = reporting();
		restorePending(before, [], [], 0);
		const refused = addPending(before, "refused", [], 100);
		const lost = addPending(before, "lost", [], 110);
		const queued = addPending(before, "queued", [], 120);
		const sent = addPending(before, "sent", [], 130);
		for (const entry of before.pending) entry.acceptedAt = 150;
		const stored = kept(before);

		const chat = openChat("a");
		const failed = restorePending(
			chat,
			stored,
			[
				{ id: refused.id, outcome: "refused", reason: "session_changed" },
				{ id: lost.id, outcome: "lost", reason: "pane_gone" },
				{ id: queued.id, outcome: "queued" },
				{ id: sent.id, outcome: "sent" },
			],
			200,
		);
		expect(failed.map(({ entry, reason }) => [entry.prompt, reason])).toEqual([
			["refused", "session_changed"],
			["lost", "pane_gone"],
		]);
		expect(chat.pending.map((p) => [p.prompt, p.outcome])).toEqual([
			["queued", "queued"],
			["sent", undefined],
		]);
	});

	it("are put back when a restarted daemon's replay lacks them, unless pi has them, before the pane's report is in", () => {
		const before = reporting();
		restorePending(before, [], [], 0);
		addPending(before, "forgotten", [], 100);
		const taken = addPending(before, "taken", [], 110);
		settleOutcomes(before, [{ id: taken.id, outcome: "taken" }]);
		for (const entry of before.pending) entry.acceptedAt = 150;
		const stored = kept(before);

		const chat = openChat("a");
		expect(restorePending(chat, stored, [], 200).map(({ entry, reason }) => [entry.prompt, reason])).toEqual([
			["forgotten", "daemon_restarted"],
		]);
		// The transcript has yet to load: the one taken waits for it to move past where it was.
		expect(chat.pending.map((p) => p.prompt)).toEqual(["taken"]);
		applyLatest(chat, { messages: [reply("1"), user("2", "taken")], more: false });
		expect(chat.pending).toEqual([]);
	});

	it("are judged by how long the daemon keeps them", () => {
		expect(KEEP_MS).toBe(DELIVERY_KEEP_MS);
	});

	it("wait for their give-up when the daemon has let them go, past how long it keeps them", () => {
		const before = reporting();
		restorePending(before, [], [], 0);
		const entry = addPending(before, "old", [], 100);
		entry.acceptedAt = 150;

		const chat = openChat("a");
		expect(restorePending(chat, kept(before), [], 150 + DELIVERY_KEEP_MS + 1)).toEqual([]);
		expect(chat.pending.map((p) => p.prompt)).toEqual(["old"]);
		applyLatest(chat, { messages: [reply("1")], more: false });
		expect(checkPending(chat, chat.pending[0], "idle")).toBe("fail");
	});

	it("are kept only once those kept before are back in, and only for a pane that reports outcomes", () => {
		const chat = openChat("a");
		addPending(chat, "early", [], 100);
		// Nothing written over what an earlier chat kept, before it is back in, or before its pane's
		// report says what kind of pane it is.
		expect(storedPending(chat)).toBeUndefined();
		restorePending(chat, [], [], 200);
		expect(storedPending(chat)).toBeUndefined();
		chat.report = { models: [], outcomes: [] };
		expect(storedPending(chat)?.map((p) => p.prompt)).toEqual(["early"]);
		// A pane that sends no report, or one without outcomes, is from an older build: its prompts
		// are matched by the transcript's text, which a reload can't pick up from.
		for (const report of [null, { models: [] }]) {
			chat.report = report;
			expect(storedPending(chat)).toEqual([]);
		}
	});
});

describe("prompts sent to a pane from an older build, which reports no outcomes", () => {
	it("are matched by the transcript's text, as before", () => {
		const chat = openChat("a");
		// It sent no report, or one without outcomes.
		for (const report of [null, { models: [] }]) {
			chat.report = report;
			chat.messages = [reply("1")];
			const entry = addPending(chat, "hi", [], 100);
			settleOutcomes(chat, report && "outcomes" in report ? [] : undefined);
			applyLatest(chat, { messages: [reply("1")], more: false });
			expect(chat.pending).toEqual([entry]);
			applyLatest(chat, { messages: [reply("1"), user("2", "hi")], more: false });
			expect(chat.pending).toEqual([]);
		}
	});
});

describe("a chat open on a session that quits on the Mac and resumes", () => {
	it("stays on its row id, whose transcript is the session's file throughout", () => {
		const file = join(mkdtempSync(join(tmpdir(), "bluclawd-chat-resume-")), "s.jsonl");
		const message = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
		writeFileSync(file, `${JSON.stringify({ type: "message", message })}\n`);
		const pane = (id: string) => ({
			id,
			status: "online" as const,
			cwd: "/p",
			createdAt: new Date().toISOString(),
			sessionFile: file,
			pane: id,
		});
		const registry = testRegistry();
		registry.registerExternal(pane("pi-a"), "idle");
		const chat = openChat("pi-a");
		const shown = () => ({
			rows: remoteSessions(listSummaries(registry)).map((s) => [s.id, s.alive, s.starting]),
			read: findSession(listSummaries(registry), chat.id),
		});
		expect(shown()).toEqual({
			rows: [["pi-a", true, undefined]],
			read: expect.objectContaining({ sessionFile: file, running: true }),
		});

		registry.unregisterExternal("pi-a", "quit");
		registry.saveInstance({ cwd: "/p", sessionFile: file });
		expect(shown()).toEqual({
			rows: [["pi-a", false, undefined]],
			read: expect.objectContaining({ sessionFile: file, running: false }),
		});

		expect(registry.claimStart({ cwd: "/p", sessionFile: file })).toEqual({ ok: true, id: chat.id });
		expect(shown().rows).toEqual([["pi-a", true, true]]);

		registry.registerExternal(pane("pi-b"), "working");
		expect(shown()).toEqual({
			rows: [["pi-a", true, undefined]],
			read: expect.objectContaining({ sessionFile: file, running: true, pane: "pi-b" }),
		});
	});
});

describe("a chat open on a pane whose user types /new", () => {
	it("stays on the session it was showing, now stopped, and moves to no other row", () => {
		const sessions = mkdtempSync(join(tmpdir(), "bluclawd-chat-new-"));
		const fileOf = (name: string) => {
			const file = join(sessions, `${name}.jsonl`);
			const message = { role: "assistant", content: [{ type: "text", text: name }], stopReason: "stop" };
			writeFileSync(file, `${JSON.stringify({ type: "message", message })}\n`);
			return file;
		};
		const pane = (sessionFile: string) => ({
			id: "pi-a",
			status: "online" as const,
			cwd: "/p",
			createdAt: new Date().toISOString(),
			sessionFile,
			pane: "pi-a",
		});
		const registry = testRegistry();
		const old = fileOf("old");
		registry.registerExternal(pane(old), "idle");
		const chat = openChat("pi-a");

		registry.unregisterExternal("pi-a", "new");
		const fresh = fileOf("new");
		registry.registerExternal(pane(fresh), "working");

		const listed = remoteSessions(listSummaries(registry));
		expect(listed.find((s) => s.id === chat.id)).toMatchObject({ alive: false });
		const other = listed.find((s) => s.id !== chat.id);
		expect(findSession(listSummaries(registry), other?.id ?? "")).toMatchObject({
			sessionFile: fresh,
			running: true,
		});
		// What its transcript is read from.
		expect(findSession(listSummaries(registry), chat.id)).toMatchObject({ sessionFile: old, running: false });
	});
});
