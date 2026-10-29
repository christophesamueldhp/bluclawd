import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSnapshot } from "../daemon/orchestrator-client.ts";
import { LiveForwarder, latestOnly } from "../ext/remote/live.ts";
import { waitFor } from "./helpers/wait-for.ts";

const assistant = (...content: unknown[]) => ({ role: "assistant", content });

describe("LiveForwarder", () => {
	let sent: Array<LiveSnapshot | null>;
	let live: LiveForwarder;

	beforeEach(() => {
		vi.useFakeTimers();
		sent = [];
		live = new LiveForwarder((snapshot) => sent.push(snapshot));
	});
	afterEach(() => vi.useRealTimers());

	it("sends nothing while no phone watches", () => {
		live.onMessageUpdate(assistant({ type: "text", text: "Hi" }));
		live.onMessageEnd();
		vi.advanceTimersByTime(1000);
		expect(sent).toEqual([]);
	});

	it("sends the reply in progress at most every 300 ms, and its last state", () => {
		live.setWatched(true);
		live.onMessageUpdate(assistant({ type: "text", text: "H" }));
		expect(sent).toEqual([{ text: "H", tools: [] }]);
		live.onMessageUpdate(assistant({ type: "text", text: "He" }));
		live.onMessageUpdate(assistant({ type: "text", text: "Hel" }));
		vi.advanceTimersByTime(299);
		expect(sent).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(sent).toEqual([
			{ text: "H", tools: [] },
			{ text: "Hel", tools: [] },
		]);
		vi.advanceTimersByTime(1000);
		expect(sent).toHaveLength(2);
	});

	it("carries thinking and the tool calls being written, and ignores other roles", () => {
		live.setWatched(true);
		live.onMessageUpdate({ role: "user", content: "hi" });
		expect(sent).toEqual([]);
		live.onMessageUpdate(
			assistant(
				{ type: "thinking", thinking: "Let me look" },
				{ type: "text", text: "Looking." },
				{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la\nmore" } },
			),
		);
		expect(sent).toEqual([
			{
				text: "Looking.",
				thinking: "Let me look",
				tools: [{ id: "c1", name: "bash", summary: "ls -la", running: false }],
			},
		]);
	});

	it("clears the reply at its end, then shows the tools it runs until their results land", () => {
		live.setWatched(true);
		live.onMessageUpdate(assistant({ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }));
		live.onMessageEnd();
		expect(sent.at(-1)).toBeNull();
		live.onToolStart("c1", "bash", { command: "ls" });
		vi.advanceTimersByTime(300);
		expect(sent.at(-1)).toEqual({ text: "", tools: [{ id: "c1", name: "bash", summary: "ls", running: true }] });
		vi.advanceTimersByTime(300);
		live.onToolEnd("c1");
		expect(sent.at(-1)).toEqual({ text: "", tools: [{ id: "c1", name: "bash", summary: "ls", running: false }] });
		// The tool result message.
		live.onMessageEnd();
		expect(sent.at(-1)).toBeNull();
		expect(sent).toHaveLength(5);
	});

	it("keeps a tool still running past another message's end", () => {
		live.setWatched(true);
		live.onToolStart("c1", "bash", { command: "sleep 9" });
		live.onToolStart("c2", "read", { path: "a.ts" });
		vi.advanceTimersByTime(300);
		live.onToolEnd("c2");
		vi.advanceTimersByTime(300);
		live.onMessageEnd();
		vi.advanceTimersByTime(300);
		expect(sent.at(-1)).toEqual({ text: "", tools: [{ id: "c1", name: "bash", summary: "sleep 9", running: true }] });
	});

	it("clears at the run's end without a stale trailing send, and sends one null only", () => {
		live.setWatched(true);
		live.onMessageUpdate(assistant({ type: "text", text: "a" }));
		live.onMessageUpdate(assistant({ type: "text", text: "ab" }));
		live.onAgentEnd();
		live.onMessageEnd();
		vi.advanceTimersByTime(1000);
		expect(sent).toEqual([{ text: "a", tools: [] }, null]);
	});

	it("clears the phone's copy when it stops watching, and resends the current state when it watches again", () => {
		live.setWatched(true);
		live.onMessageUpdate(assistant({ type: "text", text: "a" }));
		live.onMessageUpdate(assistant({ type: "text", text: "ab" }));
		live.setWatched(false);
		vi.advanceTimersByTime(1000);
		expect(sent).toEqual([{ text: "a", tools: [] }, null]);
		live.setWatched(false);
		live.onMessageUpdate(assistant({ type: "text", text: "abc" }));
		expect(sent).toHaveLength(2);
		live.setWatched(true);
		expect(sent.at(-1)).toEqual({ text: "abc", tools: [] });
		live.setWatched(true);
		expect(sent).toHaveLength(3);
	});

	it("clears a turn stopped during a tool, as pi ends it: the tool, the aborted message, the run", () => {
		live.setWatched(true);
		live.onMessageUpdate(assistant({ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep 60" } }));
		live.onMessageEnd();
		live.onToolStart("c1", "bash", { command: "sleep 60" });
		vi.advanceTimersByTime(300);
		live.onToolEnd("c1");
		// pi's empty aborted assistant message has a message_end but no update.
		const before = sent.length;
		live.onMessageEnd();
		live.onAgentEnd();
		vi.advanceTimersByTime(1000);
		expect(sent.slice(before)).toEqual([null]);
	});

	it("cuts long thinking as the transcript does", () => {
		live.setWatched(true);
		live.onMessageUpdate(assistant({ type: "thinking", thinking: "x".repeat(5000) }));
		expect(sent[0]?.thinking).toHaveLength(2049);
	});
});

describe("latestOnly", () => {
	it("sends one at a time, skipping what a later snapshot replaced meanwhile, so the null comes last", async () => {
		const sent: Array<LiveSnapshot | null> = [];
		const done: Array<() => void> = [];
		const forward = latestOnly((live) => {
			sent.push(live);
			return new Promise<void>((resolve) => done.push(resolve));
		});
		const snapshot = (text: string): LiveSnapshot => ({ text, tools: [] });
		forward(snapshot("a"));
		forward(snapshot("ab"));
		forward(snapshot("abc"));
		forward(null);
		expect(sent).toEqual([snapshot("a")]);
		done.shift()?.();
		await waitFor(() => expect(sent).toEqual([snapshot("a"), null]));
		done.shift()?.();
		await Promise.resolve();
		forward(snapshot("next"));
		await waitFor(() => expect(sent).toEqual([snapshot("a"), null, snapshot("next")]));
	});

	it("goes on after a failed send", async () => {
		const sent: Array<LiveSnapshot | null> = [];
		const forward = latestOnly(async (live) => {
			sent.push(live);
			throw new Error("daemon down");
		});
		forward({ text: "a", tools: [] });
		forward(null);
		await waitFor(() => expect(sent).toEqual([{ text: "a", tools: [] }, null]));
	});
});
