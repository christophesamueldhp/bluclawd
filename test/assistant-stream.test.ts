import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { AssistantStream } from "../daemon/assistant-stream.ts";

describe("Pi JSON streaming protocol", () => {
	it("builds text, thinking and partial tool arguments from wire deltas without a cumulative message", () => {
		const stream = new AssistantStream();
		const message = fauxAssistantMessage([]);
		stream.apply({ type: "message_start", message });
		const update = (assistantMessageEvent: unknown) =>
			stream.apply({ type: "message_update", usage: message.usage, assistantMessageEvent } as JsonAgentSessionEvent);
		update({ type: "text_start", contentIndex: 0 });
		const first = update({ type: "text_delta", contentIndex: 0, delta: "Hello " });
		update({ type: "text_delta", contentIndex: 0, delta: "world" });
		update({ type: "thinking_start", contentIndex: 1 });
		update({ type: "thinking_delta", contentIndex: 1, delta: "reason" });
		update({ type: "toolcall_start", contentIndex: 2, id: "bash1", toolName: "bash" });
		update({ type: "toolcall_delta", contentIndex: 2, delta: '{"command":"npm' });
		const last = update({ type: "toolcall_delta", contentIndex: 2, delta: ' test"}' });
		expect(first).toMatchObject({ message: { content: [{ type: "text", text: "Hello " }] } });
		expect(last).toMatchObject({
			message: {
				content: [
					{ type: "text", text: "Hello world" },
					{ type: "thinking", thinking: "reason" },
					{ type: "toolCall", id: "bash1", name: "bash", arguments: { command: "npm test" } },
				],
			},
		});
	});
	it("accepts a replayed cumulative message and appends later deltas without dropping it", () => {
		const stream = new AssistantStream();
		const message = fauxAssistantMessage("Earlier ") as AssistantMessage;
		stream.apply({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Earlier ", partial: message },
		});
		const next = stream.apply({
			type: "message_update",
			usage: message.usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "later" },
		});
		expect(next).toMatchObject({ message: { content: [{ text: "Earlier later" }] } });
	});
	it("waits for an authoritative message when attaching to an older daemon in mid-stream", () => {
		const stream = new AssistantStream();
		const message = fauxAssistantMessage("complete");
		expect(
			stream.apply({
				type: "message_update",
				usage: message.usage,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "tail" },
			}),
		).toBeUndefined();
		expect(stream.apply({ type: "message_end", message })).toEqual({ type: "message_end", message });
	});
});
