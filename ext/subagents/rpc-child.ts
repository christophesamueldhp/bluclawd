/**
 * The one bluclawd extension an RPC run's pi loads (`-ne -e`): none of the orchestrator's, so the run has no
 * `subagent` or `schedule_wakeup` of its own. Its tools are fixed by a plain `--tools` list; every call, direct or
 * from a codemode script, is checked here as well against what the run was admitted with: one of its tools, and
 * none its orchestrator's or its workspace's deny rules refuse. A run that edits changes files only in its own
 * worktree, and is held there to the rules of the checkout it copies. A run given `bash` runs each command in a
 * sandbox of its own (run-shell.ts), never while another of its file tools runs, and each command's processes end with
 * it. The shell that pi's RPC `bash` command runs outside the tool list stays closed. Every run also has its own `subagent_message`, which only returns what it
 * would send: the run's host reads that off pi's events and passes it on, so the run reaches nothing itself.
 */
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
	type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveToCwd } from "../_shared/path-resolve.ts";
import { evaluateToolCallDeny, filterDeniedGrepToolResult } from "../permissions/policy.ts";
import { sandboxSetting } from "../sandbox/config.ts";
import type { AskNetwork } from "../sandbox/runtime.ts";
import { PARENT_MESSAGE_ADDRESS, SUBAGENT_MESSAGE_TOOL } from "./messages.ts";
import { askRunApproval, NETWORK_ACCESS } from "./run-approvals.ts";
import { RUN_MESSAGE_KINDS, type RunOutboxMessage } from "./run-mailbox.ts";
import { createRunShell } from "./run-shell.ts";
import { within } from "./run-workspace.ts";

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
	/** A run that edits: its worktree's root, the root of the checkout it copies, and the Git directory both share. */
	workspace?: { root: string; source: string; gitDir: string };
	/** A run given `bash`: its id and directory, which its shell's sandbox is named after and kept out of. */
	shell?: { runId: string; runDir: string };
}

/** pi's tools that read or change files: none runs while a shell command of the run does. */
const FILE_TOOLS = ["read", "grep", "find", "ls", "edit", "write"];

/** pi's tools that change the file at their `path`: a run given either works in a worktree of its own. */
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

/**
 * A call's input as the run spelled it, from its own directory, and with its path made absolute, from the directory
 * a set of rules was set in; in a worktree, also as the path of the same file in the checkout it copies. A rule
 * refuses the call if it matches any.
 */
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
	// As spelled, and as the file system names it: another case, or a link within the worktree, is the same file.
	let real = path;
	try {
		real = realpathSync.native(path);
	} catch {
		// Not there yet: only its spelling names it.
	}
	for (const candidate of new Set([path, real])) {
		if (!within(workspace.root, candidate)) continue;
		found.push([{ ...input, path: join(workspace.source, relative(workspace.root, candidate)) }, rulesCwd]);
	}
	return found;
}

/**
 * Why a run may not change the file at `path`: it has no worktree, or the file is not in it once every link on the way
 * is followed, or it is in its `.git`, which leads to the Git state its checkout shares.
 */
function unwritable(workspace: RunPolicy["workspace"], path: unknown, cwd: string): string | undefined {
	if (!workspace) return "Refused: this run has no worktree of its own to change files in.";
	if (typeof path !== "string" || !path) return "Refused: no path to change.";
	const outside = `Refused: ${path} is outside this run's worktree, ${workspace.root}; it may change files only there.`;
	// What exists of the path, links followed, is where the file lands: a link out of the worktree leads out of it.
	const target = resolveToCwd(path, cwd);
	let existing = target;
	for (;;) {
		try {
			lstatSync(existing);
			break;
		} catch {
			existing = dirname(existing);
		}
	}
	let landing: string;
	try {
		landing = join(realpathSync(existing), relative(existing, target));
	} catch {
		// A link to nothing: where a write through it lands cannot be checked.
		return outside;
	}
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
	// pi's own codemode, which `-ne` leaves out, without `models`: its helpers call models outside every tool hook.
	createCodemodeExtension({ models: false })(pi);
	pi.registerFlag(RUN_DEFINITION_FLAG, { description: "The run's admitted definition", type: "string" });

	let policy: RunPolicy | undefined;
	const currentPolicy = () => {
		policy ??= readPolicy(pi.getFlag(RUN_DEFINITION_FLAG));
		return policy;
	};

	/** A shell command running, and the file tools let through that have not ended: one excludes the other. */
	let commandRunning: Promise<void> | undefined;
	const fileToolsRunning = new Set<string>();
	pi.on("tool_execution_end", (event) => {
		fileToolsRunning.delete(event.toolCallId);
	});
	const shell = runShell(currentPolicy, async (run) => {
		while (commandRunning) await commandRunning;
		let done = () => {};
		commandRunning = new Promise((resolve) => {
			done = resolve;
		});
		try {
			// A file tool checks its path before it runs: no command may change what that path leads to meanwhile.
			while (fileToolsRunning.size > 0) await new Promise((resolve) => setTimeout(resolve, 10));
			return await run();
		} finally {
			commandRunning = undefined;
			done();
		}
	});

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		const admitted = currentPolicy();
		if (!admitted) return { block: true, reason: "Refused: this run's admitted tools could not be read." };
		// Every run's own, granted by no role: it reaches nothing but its host, and acts on nothing.
		if (event.toolName === SUBAGENT_MESSAGE_TOOL) return undefined;
		const lost = shell.uncontained();
		if (lost) return { block: true, reason: lost };
		if (!admitted.tools.includes(event.toolName)) {
			return { block: true, reason: `Refused: this run was not given ${event.toolName}.` };
		}
		if (admitted.shell && FILE_TOOLS.includes(event.toolName)) {
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

	// A folder grep reads every file in it, so a denied file's lines are dropped from what it found.
	pi.on("tool_result", (event, ctx): ToolResultEventResult | undefined => {
		let content = event.content as Array<{ type: string; text?: string; [k: string]: unknown }>;
		let filtered: ToolResultEventResult | undefined;
		const admitted = currentPolicy();
		for (const { cwd, rules } of admitted?.deny ?? []) {
			for (const [input, at] of spellings(
				event.input as Record<string, unknown>,
				ctx.cwd,
				cwd,
				admitted?.workspace,
			)) {
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

	pi.registerTool(shell.tool);

	pi.on("user_bash", () => ({
		result: { output: "Refused: a subagent run has no shell.", exitCode: 1, cancelled: false, truncated: false },
	}));
}

/**
 * The run's `bash`, pi's own with its commands run in the run's sandbox (run-shell.ts), one at a time and each through
 * `exclusive`. Its network asks go to the user through the run's orchestrator, once per host and port.
 */
function runShell(policy: () => RunPolicy | undefined, exclusive: <T>(run: () => Promise<T>) => Promise<T>) {
	let ui: Pick<ExtensionUIContext, "select"> | undefined;
	const answers = new Map<string, Promise<boolean>>();
	// pi's dialog replaces an open one without settling it, so one opens only after the last settled.
	let asking: Promise<unknown> = Promise.resolve();
	const ask: AskNetwork = ({ host, port }) => {
		const target = port === undefined ? host : `${host}:${port}`;
		let answer = answers.get(target);
		if (!answer) {
			answer = asking.then(
				async () => ui !== undefined && !(await askRunApproval(ui, { action: NETWORK_ACCESS, target }, undefined)),
			);
			asking = answer.catch(() => {});
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
			{ agentDir, user: () => sandboxSetting(SettingsManager.create(cwd, agentDir)), ask },
		);
		const current = shell;
		return exclusive(() => current.exec(command, cwd, options));
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
