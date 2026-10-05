import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
export function assistant(text: string, timestamp = 1) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "test",
		model: "test",
		timestamp,
		stopReason: "stop" as const,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
export function textDelta(delta: string, contentIndex = 0): JsonAgentSessionEvent {
	return {
		type: "message_update",
		usage: assistant("").usage,
		assistantMessageEvent: { type: "text_delta", delta, contentIndex },
	};
}
