import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createCodemodeExtension,
	type ExtensionAPI,
	type ExtensionUIContext,
	getAgentDir,
	SettingsManager,
	type ToolCallEventResult,
	type ToolResultEvent,
	type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withCommandPrefix } from "../_shared/command-prefix.ts";
import { resolveToCwd } from "../_shared/path-resolve.ts";
import { startupSettings } from "../_shared/startup-settings.ts";
import { evaluateToolCallDeny, filterDeniedGrepToolResult } from "../permissions/policy.ts";
import { globalSandboxSetting } from "../sandbox/config.ts";
import type { AskNetwork } from "../sandbox/runtime.ts";
import { PARENT_MESSAGE_ADDRESS, SUBAGENT_MESSAGE_TOOL } from "./messages.ts";
import { askRunApproval, NETWORK_ACCESS } from "./run-approvals.ts";
import { RUN_MESSAGE_KINDS, type RunOutboxMessage } from "./run-mailbox.ts";
import { createRunShell } from "./run-shell.ts";
import { within } from "./run-workspace.ts";

const MAX_MESSAGE_BYTES = 8192;

export const RUN_DEFINITION_FLAG = "bluclawd-run-definition";

export interface RpcDenyRules {
	cwd: string;
	rules: string[];
}

interface RunPolicy {
	tools: string[];
	deny: RpcDenyRules[];
	workspace?: { root: string; source: string; gitDir: string };
	shell?: { runId: string; runDir: string };
}

const SHELL_EXCLUSIVE_FILE_TOOLS = ["read", "grep", "find", "ls", "edit", "write"];

export const WRITE_TOOLS = ["edit", "write"];

function readPolicy(path: unknown): RunPolicy | undefined {
	try {
		const { tools, deny, workspace, shell } = JSON.parse(readFileSync(String(path), "utf8"));
		const strings = (list: unknown) => Array.isArray(list) && list.every((item) => typeof item === "string");
		const root = workspace?.root;
		const source = workspace?.baseline?.source;
		const gitDir = workspace?.baseline?.gitDir;
		const valid =
			strings(tools) &&
			Array.isArray(deny) &&
			deny.every((set) => typeof set?.cwd === "string" && strings(set.rules)) &&
			(workspace === undefined ||
				(typeof root === "string" && typeof source === "string" && typeof gitDir === "string")) &&
			(shell === undefined || (typeof shell.runId === "string" && typeof shell.runDir === "string"));
		return valid
			? {
					tools,
					deny,
					...(workspace ? { workspace: { root, source, gitDir } } : {}),
					...(shell ? { shell: { runId: shell.runId, runDir: shell.runDir } } : {}),
				}
			: undefined;
	} catch {
		return undefined;
	}
}

function spellings(
	input: Record<string, unknown>,
	cwd: string,
	rulesCwd: string,
	workspace: RunPolicy["workspace"],
): [Record<string, unknown>, string][] {
	const path = resolveToCwd(typeof input.path === "string" && input.path ? input.path : ".", cwd);
	const found: [Record<string, unknown>, string][] = [
		[input, cwd],
		[{ ...input, path }, rulesCwd],
	];
	if (!workspace) return found;
	for (const candidate of new Set([path, realpathOrSelf(path)])) {
		if (!within(workspace.root, candidate)) continue;
		found.push([{ ...input, path: join(workspace.source, relative(workspace.root, candidate)) }, rulesCwd]);
	}
	return found;
}

function realpathOrSelf(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

function landingOf(target: string): string | undefined {
	let existing = target;
	for (;;) {
		try {
			lstatSync(existing);
			break;
		} catch {
			existing = dirname(existing);
		}
	}
	try {
		return join(realpathSync(existing), relative(existing, target));
	} catch {
		return undefined;
	}
}

function unwritable(workspace: RunPolicy["workspace"], path: unknown, cwd: string): string | undefined {
	if (!workspace) return "Refused: this run has no worktree of its own to change files in.";
	if (typeof path !== "string" || !path) return "Refused: no path to change.";
	const outside = `Refused: ${path} is outside this run's worktree, ${workspace.root}; it may change files only there.`;
	const target = resolveToCwd(path, cwd);
	const landing = landingOf(target);
	if (landing === undefined) return outside;
	for (const spelled of [target, landing]) {
		if (!within(workspace.root, spelled)) return outside;
		const segments = relative(workspace.root, spelled).split(sep);
		if (segments.some((segment) => segment.toLowerCase() === ".git")) {
			return `Refused: ${path} is Git's own state, which this run may not change.`;
		}
	}
	return undefined;
}

export default function rpcChild(pi: ExtensionAPI): void {
	// pi's own codemode, which `-ne` leaves out, without `models`, because its helpers call models outside every tool hook.
	createCodemodeExtension({ models: false })(pi);
	pi.registerFlag(RUN_DEFINITION_FLAG, { description: "The run's admitted definition", type: "string" });

	let policy: RunPolicy | undefined;
	const currentPolicy = () => {
		policy ??= readPolicy(pi.getFlag(RUN_DEFINITION_FLAG));
		return policy;
	};

	let commandRunning: Promise<void> | undefined;
	const fileToolsRunning = new Set<string>();
	const waitForFileTools = async () => {
		while (fileToolsRunning.size > 0) await new Promise((resolve) => setTimeout(resolve, 10));
	};
	pi.on("tool_execution_end", (event) => {
		fileToolsRunning.delete(event.toolCallId);
	});
	let commandPrefix: string | undefined;
	pi.on("session_start", (event, ctx) => {
		try {
			commandPrefix = startupSettings(event, ctx).settings.getShellCommandPrefix();
		} catch {
			commandPrefix = undefined;
		}
	});
	const shell = runShell(
		currentPolicy,
		() => commandPrefix,
		async (run) => {
			while (commandRunning) await commandRunning;
			let done = () => {};
			commandRunning = new Promise((resolve) => {
				done = resolve;
			});
			try {
				await waitForFileTools();
				return await run();
			} finally {
				commandRunning = undefined;
				done();
			}
		},
	);

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		const admitted = currentPolicy();
		if (!admitted) return { block: true, reason: "Refused: this run's admitted tools could not be read." };
		const alwaysGranted = event.toolName === SUBAGENT_MESSAGE_TOOL;
		if (alwaysGranted) return undefined;
		const lost = shell.uncontained();
		if (lost) return { block: true, reason: lost };
		if (!admitted.tools.includes(event.toolName)) {
			return { block: true, reason: `Refused: this run was not given ${event.toolName}.` };
		}
		if (admitted.shell && SHELL_EXCLUSIVE_FILE_TOOLS.includes(event.toolName)) {
			while (commandRunning) await commandRunning;
			fileToolsRunning.add(event.toolCallId);
		}
		if (event.toolName === "bash" && (!admitted.shell || !admitted.workspace)) {
			return { block: true, reason: "Refused: this run has no shell of its own." };
		}
		if (WRITE_TOOLS.includes(event.toolName)) {
			const refused = unwritable(admitted.workspace, (event.input as { path?: unknown }).path, ctx.cwd);
			if (refused) return { block: true, reason: refused };
		}
		for (const { cwd, rules } of admitted.deny) {
			for (const [input, at] of spellings(
				event.input as Record<string, unknown>,
				ctx.cwd,
				cwd,
				admitted.workspace,
			)) {
				const denied = evaluateToolCallDeny(rules, event.toolName, input, at);
				if (denied) return denied;
			}
		}
		return undefined;
	});

	pi.on("tool_result", (event, ctx) => dropDeniedGrepLines(currentPolicy(), event, ctx.cwd));

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

	pi.registerTool(shell.tool);

	pi.on("user_bash", () => ({
		result: { output: "Refused: a subagent run has no shell.", exitCode: 1, cancelled: false, truncated: false },
	}));
}

function dropDeniedGrepLines(
	admitted: RunPolicy | undefined,
	event: ToolResultEvent,
	cwd: string,
): ToolResultEventResult | undefined {
	let content = event.content as Array<{ type: string; text?: string; [k: string]: unknown }>;
	let filtered: ToolResultEventResult | undefined;
	for (const { cwd: rulesCwd, rules } of admitted?.deny ?? []) {
		for (const [input, at] of spellings(event.input as Record<string, unknown>, cwd, rulesCwd, admitted?.workspace)) {
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
}

function runShell(
	policy: () => RunPolicy | undefined,
	commandPrefix: () => string | undefined,
	exclusive: <T>(run: () => Promise<T>) => Promise<T>,
) {
	let ui: Pick<ExtensionUIContext, "select"> | undefined;
	const answers = new Map<string, Promise<boolean>>();
	let lastDialogSettled: Promise<unknown> = Promise.resolve();
	const ask: AskNetwork = ({ host, port }) => {
		const target = port === undefined ? host : `${host}:${port}`;
		let answer = answers.get(target);
		if (!answer) {
			answer = lastDialogSettled.then(
				async () => ui !== undefined && !(await askRunApproval(ui, { action: NETWORK_ACCESS, target }, undefined)),
			);
			lastDialogSettled = answer.catch(() => {});
			answers.set(target, answer);
		}
		return answer;
	};
	let shell: ReturnType<typeof createRunShell> | undefined;
	const exec: BashOperations["exec"] = (command, cwd, options) => {
		const admitted = policy();
		if (!admitted?.shell || !admitted.workspace) throw new Error("Refused: this run has no shell of its own.");
		const agentDir = getAgentDir();
		shell ??= createRunShell(
			{ ...admitted.shell, workspace: admitted.workspace, deny: admitted.deny },
			{ agentDir, user: () => globalSandboxSetting(SettingsManager.create(cwd, agentDir)), ask },
		);
		const current = shell;
		const prefixBelowDenyCheck = commandPrefix();
		return exclusive(() => current.exec(withCommandPrefix(prefixBelowDenyCheck, command), cwd, options));
	};
	const base = createBashToolDefinition(process.cwd(), { operations: { exec } });
	return {
		tool: {
			...base,
			executionMode: "sequential" as const,
			execute: ((toolCallId, params, signal, onUpdate, ctx) => {
				ui = ctx.ui;
				return base.execute(toolCallId, params, signal, onUpdate, ctx);
			}) as typeof base.execute,
		},
		uncontained: () => shell?.uncontained(),
	};
}
