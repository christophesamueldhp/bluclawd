import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyLatest, applyOlder, openChat, promptSent, replyEndedAt } from "#remote-web/chat.js";
import { listSummaries } from "../daemon/handler.ts";
import { findSession, remoteSessions } from "../daemon/remote/sessions.ts";
import { testRegistry } from "./helpers/registry.ts";

const user = (id: string, text: string) => ({ kind: "user", id, text });
const reply = (id: string, text = "ok") => ({ kind: "assistant", id, text, tools: [] });
const result = (toolCallId: string) => ({ kind: "toolResult", id: `r-${toolCallId}`, toolCallId, ok: true, text: "" });
const send = (chat: ReturnType<typeof openChat>, text: string) =>
	promptSent(chat, text, [], { text, selections: [] }, 100);

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
		const entry = send(chat, "hi");
		expect(entry.sameTextBefore).toBe(1);
		applyLatest(chat, { messages: [reply("9")], more: true });
		expect(chat.messages.map((m) => m.id)).toEqual(["9"]);
		expect(chat.more).toBe(true);
		expect(chat.pending).toEqual([entry]);
		expect(entry.sameTextBefore).toBe(0);
		applyLatest(chat, { messages: [reply("9"), user("10", "hi")], more: true });
		expect(chat.pending).toEqual([]);
	});

	it("puts an older page above, counting its copies of a pending prompt", () => {
		const chat = openChat("a");
		chat.messages = [reply("5")];
		const entry = send(chat, "hi");
		expect(applyOlder(chat, chat.messages[0], { messages: [user("4", "hi")], more: false })).toBe(true);
		expect(chat.messages.map((m) => m.id)).toEqual(["4", "5"]);
		expect(entry.sameTextBefore).toBe(1);
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
		chat.liveRetracted = true;
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
		chat.liveRetracted = true;
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
			read: expect.objectContaining({ sessionFile: file, verdict: { act: true } }),
		});

		registry.unregisterExternal("pi-a", "quit");
		registry.saveInstance({ cwd: "/p", sessionFile: file });
		expect(shown()).toEqual({
			rows: [["pi-a", false, undefined]],
			read: expect.objectContaining({ sessionFile: file, verdict: { act: false, reason: "not_running" } }),
		});

		expect(registry.claimStart({ cwd: "/p", sessionFile: file })).toEqual({ ok: true, id: chat.id });
		expect(shown().rows).toEqual([["pi-a", true, true]]);

		registry.registerExternal(pane("pi-b"), "working");
		expect(shown()).toEqual({
			rows: [["pi-a", true, undefined]],
			read: expect.objectContaining({ sessionFile: file, verdict: { act: true }, pane: "pi-b" }),
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
			verdict: { act: true },
		});
		expect(findSession(listSummaries(registry), chat.id)).toMatchObject({
			sessionFile: old,
			verdict: { act: false, reason: "not_running" },
		});
	});
});
