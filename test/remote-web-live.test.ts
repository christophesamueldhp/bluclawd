import { describe, expect, it } from "vitest";
import { settle } from "../daemon/remote/web/live.js";

const assistant = (id: string, text: string, thinking?: string) => ({
	kind: "assistant",
	id,
	text,
	...(thinking ? { thinking } : {}),
	tools: [],
});
const result = (toolCallId: string) => ({ kind: "toolResult", id: `r-${toolCallId}`, toolCallId, ok: true, text: "" });
const tool = (id: string, running: boolean) => ({ id, name: "bash", summary: "ls", running });

describe("settle (the phone's reply in progress once a transcript fetch lands)", () => {
	it("keeps the text streaming mid-reply, even when an earlier message starts the same way", () => {
		const live = { text: "Hel", tools: [] };
		expect(settle(live, false, [assistant("a1", "Hello there")])).toEqual(live);
	});

	it("drops a finished reply once the transcript has it", () => {
		const live = { text: "Hello", thinking: "hmm", tools: [tool("c1", false)] };
		const messages = [assistant("a1", "Hello world", "hmm, ok"), result("c1")];
		expect(settle(live, true, messages)).toBeUndefined();
	});

	it("keeps a finished reply the transcript does not have yet", () => {
		const live = { text: "Second", tools: [] };
		expect(settle(live, true, [assistant("a1", "First")])).toEqual(live);
	});

	it("drops a tool once the transcript has its result, and keeps one still running", () => {
		const live = { text: "", tools: [tool("c1", true), tool("c2", true)] };
		expect(settle(live, false, [result("c1")])).toEqual({ text: "", tools: [tool("c2", true)] });
		expect(settle({ text: "", tools: [tool("c1", true)] }, false, [result("c1")])).toBeUndefined();
	});

	it("keeps the tools without a result when a finished reply's text goes", () => {
		const live = { text: "Hi", tools: [tool("c1", true)] };
		expect(settle(live, true, [assistant("a1", "Hi")])).toEqual({ text: "", tools: [tool("c1", true)] });
	});

	it("is nothing without a reply in progress", () => {
		expect(settle(undefined, true, [assistant("a1", "Hi")])).toBeUndefined();
	});
});
