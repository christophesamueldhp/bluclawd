/** Reconstruct cumulative assistant messages from Pi's compact JSON/RPC deltas. */
import { type AssistantMessage, parseStreamingJson } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

export class AssistantStream {
	private message?: AssistantMessage;
	private readonly arguments = new Map<number, string>();

	apply(event: AgentSessionEvent | JsonAgentSessionEvent): AgentSessionEvent | undefined {
		if (event.type === "message_start") {
			if (event.message.role === "assistant") {
				this.message = structuredClone(event.message);
				this.arguments.clear();
			}
			return event;
		}
		if (event.type === "agent_settled" || (event.type === "message_end" && event.message.role === "assistant")) {
			this.message = undefined;
			this.arguments.clear();
			return event;
		}
		if (event.type !== "message_update") return event;
		if ("message" in event) {
			this.message = structuredClone(event.message as AssistantMessage);
			return event;
		}
		const message = this.message;
		if (!message) return; // A legacy daemon may attach in the middle of a message; message_end is authoritative.
		const delta = event.assistantMessageEvent;
		if ("contentIndex" in delta) {
			const index = delta.contentIndex;
			const block = message.content[index];
			switch (delta.type) {
				case "text_start":
					message.content[index] = { type: "text", text: "" };
					break;
				case "text_delta":
					if (block?.type === "text") block.text += delta.delta;
					break;
				case "text_end":
					message.content[index] = { type: "text", text: delta.content };
					break;
				case "thinking_start":
					message.content[index] = { type: "thinking", thinking: "" };
					break;
				case "thinking_delta":
					if (block?.type === "thinking") block.thinking += delta.delta;
					break;
				case "thinking_end":
					message.content[index] = { type: "thinking", thinking: delta.content };
					break;
				case "toolcall_start":
					message.content[index] = { type: "toolCall", id: delta.id, name: delta.toolName, arguments: {} };
					this.arguments.set(index, "");
					break;
				case "toolcall_delta": {
					const args = (this.arguments.get(index) ?? "") + delta.delta;
					this.arguments.set(index, args);
					if (block?.type === "toolCall") block.arguments = parseStreamingJson(args);
					break;
				}
				case "toolcall_end":
					message.content[index] = delta.toolCall;
					this.arguments.delete(index);
					break;
			}
		}
		message.usage = event.usage;
		return { ...event, message: structuredClone(message) } as AgentSessionEvent;
	}
}
