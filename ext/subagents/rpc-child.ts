/**
 * The one bluclawd extension an RPC run's pi loads (`-ne -e`): none of the orchestrator's, so the run has no
 * `subagent` or `schedule_wakeup` of its own. Its tools are fixed by a plain `--tools` list; every call, direct or
 * from a codemode script, is checked here as well against what the run was admitted with: one of its tools, and
 * none its orchestrator's or its workspace's deny rules refuse. This also closes the shell that pi's RPC `bash`
 * command runs outside the tool list. Every run also has its own `subagent_message`, which only returns what it
 * would send: the run's host reads that off pi's events and passes it on, so the run reaches nothing itself.
 */
import { readFileSync } from "node:fs";
import {
	createCodemodeExtension,
	type ExtensionAPI,
	type ToolCallEventResult,
	type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveToCwd } from "../_shared/path-resolve.ts";
import { evaluateToolCallDeny, filterDeniedGrepToolResult } from "../permissions/policy.ts";
import { PARENT_MESSAGE_ADDRESS, SUBAGENT_MESSAGE_TOOL } from "./messages.ts";
import { RUN_MESSAGE_KINDS, type RunOutboxMessage } from "./run-mailbox.ts";

/** As large as a message from a run gets: anything longer belongs in its Report. */
const MAX_MESSAGE_BYTES = 8192;

/** The flag naming the run's admitted definition (definition.json): what it may do. */
export const RUN_DEFINITION_FLAG = "bluclawd-run-definition";

/** Deny rules, with the directory their relative paths are from. */
export interface RpcDenyRules {
	cwd: string;
	rules: string[];
}

interface RunPolicy {
	tools: string[];
	deny: RpcDenyRules[];
}

function readPolicy(path: unknown): RunPolicy | undefined {
	try {
		const { tools, deny } = JSON.parse(readFileSync(String(path), "utf8"));
		const strings = (list: unknown) => Array.isArray(list) && list.every((item) => typeof item === "string");
		const valid =
			strings(tools) &&
			Array.isArray(deny) &&
			deny.every((set) => typeof set?.cwd === "string" && strings(set.rules));
		return valid ? { tools, deny } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A call's input as the run spelled it, from its own directory, and with its path made absolute, from the directory
 * a set of rules was set in: a rule refuses the call if it matches either.
 */
function spellings(input: Record<string, unknown>, cwd: string, rulesCwd: string): [Record<string, unknown>, string][] {
	const path = typeof input.path === "string" && input.path ? input.path : ".";
	return [
		[input, cwd],
		[{ ...input, path: resolveToCwd(path, cwd) }, rulesCwd],
	];
}

export default function rpcChild(pi: ExtensionAPI): void {
	// pi's own codemode, which `-ne` leaves out, without `models`: its helpers call models outside every tool hook.
	createCodemodeExtension({ models: false })(pi);
	pi.registerFlag(RUN_DEFINITION_FLAG, { description: "The run's admitted definition", type: "string" });

	let policy: RunPolicy | undefined;
	const currentPolicy = () => {
		policy ??= readPolicy(pi.getFlag(RUN_DEFINITION_FLAG));
		return policy;
	};

	pi.on("tool_call", (event, ctx): ToolCallEventResult | undefined => {
		const admitted = currentPolicy();
		if (!admitted) return { block: true, reason: "Refused: this run's admitted tools could not be read." };
		// Every run's own, granted by no role: it reaches nothing but its host, and acts on nothing.
		if (event.toolName === SUBAGENT_MESSAGE_TOOL) return undefined;
		if (!admitted.tools.includes(event.toolName)) {
			return { block: true, reason: `Refused: this run was not given ${event.toolName}.` };
		}
		for (const { cwd, rules } of admitted.deny) {
			for (const [input, at] of spellings(event.input as Record<string, unknown>, ctx.cwd, cwd)) {
				const denied = evaluateToolCallDeny(rules, event.toolName, input, at);
				if (denied) return denied;
			}
		}
		return undefined;
	});

	// A folder grep reads every file in it, so a denied file's lines are dropped from what it found.
	pi.on("tool_result", (event, ctx): ToolResultEventResult | undefined => {
		let content = event.content as Array<{ type: string; text?: string; [k: string]: unknown }>;
		let filtered: ToolResultEventResult | undefined;
		for (const { cwd, rules } of currentPolicy()?.deny ?? []) {
			for (const [input, at] of spellings(event.input as Record<string, unknown>, ctx.cwd, cwd)) {
				const result = filterDeniedGrepToolResult(
					rules,
					{
						toolName: event.toolName,
						input,
						content,
						structuredContent: event.structuredContent,
						isError: event.isError,
					},
					at,
				);
				if (result?.content) {
					content = result.content as typeof content;
					filtered = result;
				}
			}
		}
		return filtered;
	});

	pi.registerTool({
		name: SUBAGENT_MESSAGE_TOOL,
		label: "Message",
		exposure: "model-only",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		description:
			'Tell your orchestrator something while you work, without waiting for your report. Kind "question" or "blocker" when you need its decision, "finding" for a result it should know now: each wakes it. Kind "progress" only updates the status line it can look at, and wakes nobody. To tell a sibling run of the same orchestrator, give its name as `to`. Sending is not a reply: keep working, and do not acknowledge messages you receive.',
		parameters: Type.Object(
			{
				kind: Type.Union(
					RUN_MESSAGE_KINDS.map((kind) => Type.Literal(kind)),
					{ description: "progress, finding, question or blocker." },
				),
				content: Type.String({ description: "The message, self-contained." }),
				to: Type.Optional(
					Type.String({
						description: `A sibling run's name, or "${PARENT_MESSAGE_ADDRESS}" (the default) for your orchestrator.`,
					}),
				),
			},
			{ additionalProperties: false },
		),
		// Its host reads the result's details off pi's events and sends them on; nothing here reaches out.
		execute: async (_toolCallId, params) => {
			const to = params.to?.trim() || PARENT_MESSAGE_ADDRESS;
			if (Buffer.byteLength(params.content) > MAX_MESSAGE_BYTES) {
				throw new Error(`A message holds at most ${MAX_MESSAGE_BYTES} bytes; put the rest in your report.`);
			}
			const details: Omit<RunOutboxMessage, "seq"> = { to, kind: params.kind, content: params.content };
			const recipient = to === PARENT_MESSAGE_ADDRESS ? "your orchestrator" : `"${to}"`;
			return {
				content: [
					{
						type: "text",
						text: `Sent to ${recipient} as ${params.kind} (not yet handled). Keep working; do not wait for a reply.`,
					},
				],
				details,
			};
		},
	});

	pi.on("user_bash", () => ({
		result: { output: "Refused: a subagent run has no shell.", exitCode: 1, cancelled: false, truncated: false },
	}));
}
