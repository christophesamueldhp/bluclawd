/**
 * `contact_supervisor`: a child asks a question mid-run and waits for the answer
 * (pi-subagents' supervisor channel), instead of guessing at a decision that is not
 * its to make.
 *
 * The supervisor is the user. Children run in-process inside the parent's `task`
 * call, so the parent's model is blocked on that call and cannot answer; the user,
 * through the root session's UI, can. Questions queue behind permission prompts
 * rather than stacking dialogs. The tool exists only when there is a UI to ask.
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface SupervisorQuestion {
	agent: string;
	question: string;
	signal?: AbortSignal;
}

/** Puts a child's question to the user; undefined when it goes unanswered. */
export type SupervisorAsk = (request: SupervisorQuestion) => Promise<string | undefined>;

export const UNANSWERED =
	"No answer came. Decide on your own, choosing the more conservative option, and name the assumption in your final report.";

export function createSupervisorExtension(agent: string, ask: SupervisorAsk): InlineExtension {
	function factory(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "contact_supervisor",
			label: "Contact Supervisor",
			description:
				"Ask the user a question and wait for the answer, when continuing needs a decision that is not yours to make (scope, product, architecture, an ambiguous requirement). Not for progress reports or routine confirmation.",
			parameters: Type.Object({
				question: Type.String({ description: "One focused question, with the options you see if there are any" }),
			}),
			execute: async (_toolCallId, params, signal) => {
				const question = params.question.trim();
				if (!question) return { content: [{ type: "text", text: "Ask a question." }], details: undefined };
				let answer: string | undefined;
				try {
					answer = (await ask({ agent, question, signal }))?.trim();
				} catch {
					answer = undefined;
				}
				return {
					content: [{ type: "text", text: answer ? `The user answered: ${answer}` : UNANSWERED }],
					details: undefined,
				};
			},
		});
	}
	return { name: "subagent-supervisor", factory };
}
