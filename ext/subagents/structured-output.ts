/**
 * Structured output (pi-subagents' `outputSchema`): a child that must finish by
 * handing back JSON matching a schema, through a `structured_output` tool, instead
 * of prose the parent would have to parse.
 *
 * pi validates the call's arguments against the tool's parameters before running
 * it, so a value that does not match is sent back to the child with the paths that
 * failed, and the child can correct it. An accepted call ends the child's run.
 *
 * What the child handed back lives in its transcript, as that call's result: the
 * output the parent, the next chain step and a later `task_wait` all read.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

export const STRUCTURED_OUTPUT_TOOL = "structured_output";

export type OutputSchema = Record<string, unknown>;

/** A schema, or nothing: an empty object is what a model fills an unused parameter with. */
export function parseOutputSchema(raw: unknown): OutputSchema | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	return Object.keys(raw).length > 0 ? (raw as OutputSchema) : undefined;
}

/** Why a schema cannot be used, or undefined when it can. */
export function outputSchemaProblem(schema: OutputSchema): string | undefined {
	// The schema sits under `value` in the tool's parameters, where a local ref no longer resolves.
	if (JSON.stringify(schema).includes('"$ref"')) return "outputSchema cannot use $ref; inline the definitions.";
	try {
		Compile(schema as never);
	} catch (err) {
		return `outputSchema is not a valid JSON Schema: ${err instanceof Error ? err.message : String(err)}`;
	}
	return undefined;
}

export const STRUCTURED_OUTPUT_INSTRUCTIONS = `Finish by calling the \`${STRUCTURED_OUTPUT_TOOL}\` tool with your result as its value, matching its schema. That call is your answer: prose alone does not complete this task.`;

export const STRUCTURED_OUTPUT_REMINDER = `You have not called \`${STRUCTURED_OUTPUT_TOOL}\`. Call it now with your result; this task is not complete without it.`;

export function createStructuredOutputExtension(schema: OutputSchema): InlineExtension {
	function factory(pi: ExtensionAPI): void {
		pi.registerTool({
			name: STRUCTURED_OUTPUT_TOOL,
			label: "Structured Output",
			description: "Hand back your final result as JSON matching the schema. This ends your task.",
			parameters: Type.Object({ value: Type.Unsafe(schema) }),
			execute: async (_toolCallId, params) => ({
				content: [{ type: "text", text: JSON.stringify(params.value, null, 2) }],
				details: undefined,
				terminate: true,
			}),
		});
	}
	return { name: "subagent-structured-output", factory };
}

/** The JSON of the child's last accepted `structured_output` call, if it made one. */
export function structuredOutputOf(messages: readonly AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "toolResult" || msg.toolName !== STRUCTURED_OUTPUT_TOOL || msg.isError) continue;
		const part = msg.content.find((c) => c.type === "text");
		if (part?.type === "text") return part.text;
	}
	return undefined;
}
