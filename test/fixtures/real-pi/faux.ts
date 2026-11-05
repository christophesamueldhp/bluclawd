/**
 * A faux model for real pi processes (test/helpers/real-pi.ts). Each session follows its own script,
 * `<agent dir>/faux/<session name>.json` (`main` for a session without a name), read again on every
 * request, so a test can add steps while the session runs. Every request is logged as a line of
 * `<session name>.requests.jsonl` beside it: what that session's model was asked.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type JsonObject,
} from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

/** `stallMs`: the answer takes that long, unless the request is aborted first (as Esc does). */
export type FauxStep = { text: string; stallMs?: number } | { tool: string; args: JsonObject };

export const FAUX_MODELS = [
	{ id: "faux-1", reasoning: false },
	{ id: "faux-2", reasoning: true },
];

export function fauxDir(agentDir: string): string {
	return join(agentDir, "faux");
}

export default function fauxPi(pi: ExtensionAPI): void {
	const faux = fauxProvider({ provider: "faux", models: FAUX_MODELS });
	const respond: FauxResponseFactory = async (context, options, _state, model) => {
		faux.appendResponses([respond]);
		const dir = fauxDir(getAgentDir());
		mkdirSync(dir, { recursive: true });
		const key = pi.getSessionName() ?? "main";
		const log = join(dir, `${key}.requests.jsonl`);
		const asked = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
		appendFileSync(
			log,
			`${JSON.stringify({ model: model.id, reasoning: options?.reasoning, messages: context.messages })}\n`,
		);
		const script = join(dir, `${key}.json`);
		const step = (existsSync(script) ? (JSON.parse(readFileSync(script, "utf8")) as FauxStep[]) : [])[asked];
		if (!step) return fauxAssistantMessage(`faux script for ${key} ran dry`);
		if ("stallMs" in step && step.stallMs) {
			const { signal } = options ?? {};
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, step.stallMs);
				signal?.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		return fauxAssistantMessage(
			"tool" in step ? fauxToolCall(step.tool, step.args) : fauxText(step.text),
			"tool" in step ? { stopReason: "toolUse" } : undefined,
		);
	};
	faux.setResponses([respond]);
	pi.registerProvider(faux.provider);
}
