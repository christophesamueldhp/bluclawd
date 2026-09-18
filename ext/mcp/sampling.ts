/**
 * MCP sampling: a server asks the client's model for a completion. Answered with
 * the session's own model, whatever its provider, and only after the user approves
 * each request — a server must not spend the user's tokens unseen.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionHeaders } from "../_shared/session-headers.ts";
import { promptMessagesToText } from "./schema.ts";

/** Upper bound on one sampled reply, whatever the server asks for. */
export const SAMPLING_MAX_TOKENS = 8192;

export interface SamplingParams {
	messages: { role: string; content: unknown }[];
	systemPrompt?: string;
	maxTokens: number;
}

export type SamplingReply = {
	role: "assistant";
	content: { type: "text"; text: string };
	model: string;
	stopReason: "endTurn" | "maxTokens";
};

/** The request as one user turn: text (with role markers for a conversation) plus images. */
export function samplingPrompt(params: SamplingParams): { text: string; images: ImageContent[] } {
	const flat = params.messages.flatMap((m) =>
		(Array.isArray(m.content) ? m.content : [m.content]).map((content) => ({ role: m.role, content })),
	);
	const images: ImageContent[] = [];
	for (const { content } of flat) {
		const c = content as Record<string, unknown>;
		if (c?.type === "image" && typeof c.data === "string" && typeof c.mimeType === "string") {
			images.push({ type: "image", data: c.data, mimeType: c.mimeType });
		}
	}
	const text = promptMessagesToText(flat.filter(({ content }) => (content as { type?: unknown })?.type !== "image"));
	return { text, images };
}

function preview(text: string, max = 600): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Ask, then complete. Throws (reported to the server as an error) on refusal or failure. */
export async function answerSampling(
	ctx: ExtensionContext,
	server: string,
	params: SamplingParams,
): Promise<SamplingReply> {
	if (!ctx.hasUI) throw new Error("sampling needs the user's approval, and this session has no UI");
	const model = ctx.model;
	if (!model) throw new Error("no model is selected");
	const { text, images } = samplingPrompt(params);
	const maxTokens = Math.min(Math.max(1, params.maxTokens || SAMPLING_MAX_TOKENS), SAMPLING_MAX_TOKENS);
	const system = params.systemPrompt ? `System prompt:\n${preview(params.systemPrompt, 300)}\n\n` : "";
	const approved = await ctx.ui.confirm(
		`MCP ${server} wants to use ${model.name ?? model.id} (up to ${maxTokens} tokens)`,
		`${system}${preview(text)}${images.length > 0 ? `\n\n+ ${images.length} image(s)` : ""}`,
	);
	if (!approved) throw new Error("the user declined the sampling request");

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) throw new Error(`no credentials for ${model.provider}`);
	const sessionId = ctx.sessionManager.getSessionId();
	const content: (TextContent | ImageContent)[] = [{ type: "text", text }, ...images];
	const response = await completeSimple(
		model,
		{
			...(params.systemPrompt && { systemPrompt: params.systemPrompt }),
			messages: [{ role: "user" as const, content, timestamp: Date.now() }],
		},
		{
			apiKey: auth.apiKey,
			headers: { ...sessionHeaders(model, sessionId), ...auth.headers },
			env: auth.env,
			maxTokens,
			sessionId,
		},
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage ?? `the model call ended with ${response.stopReason}`);
	}
	const reply = response.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	return {
		role: "assistant",
		content: { type: "text", text: reply },
		model: model.id,
		stopReason: response.stopReason === "length" ? "maxTokens" : "endTurn",
	};
}
