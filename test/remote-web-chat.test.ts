import { describe, expect, it } from "vitest";
import {
	addPending,
	applyLatest,
	applyOlder,
	checkPending,
	forget,
	listed,
	openChat,
	replyEndedAt,
} from "#remote-web/chat.js";

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

describe("following a session to its next pane", () => {
	it("starts a chat that carries only the pending prompts and the way back to the list", () => {
		const chat = openChat("a");
		chat.backToList = true;
		chat.messages = [reply("1")];
		chat.attachments = [{ mimeType: "image/png", data: "", thumb: "" }];
		chat.report = null;
		const entry = addPending(chat, "go", [], 100);
		const next = openChat("b", chat);
		expect(next.id).toBe("b");
		expect(next.pending).toEqual([entry]);
		// The same list: a prompt that fails to send after the move is taken out of the one on screen.
		expect(next.pending).toBe(chat.pending);
		expect(next.backToList).toBe(true);
		expect(next.messages).toEqual([]);
		expect(next.attachments).toEqual([]);
		expect(next.report).toBeUndefined();
	});

	it("shares them with the chat it followed after a page came in", () => {
		const chat = openChat("a");
		const entry = addPending(chat, "go", [], 100);
		const next = openChat("b", chat);
		applyLatest(next, { messages: [reply("1")], more: false });
		forget(chat, entry);
		expect(next.pending).toEqual([]);
	});

	it("is not where a chat opened afresh starts from", () => {
		const chat = openChat("a");
		expect(chat.pending).toEqual([]);
		expect(chat.backToList).toBe(false);
	});
});
