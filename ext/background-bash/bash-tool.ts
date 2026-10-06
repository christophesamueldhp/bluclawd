/**
 * The model's bash tool: `timeout` in milliseconds with a 2-minute default,
 * `run_in_background`, and a command still running at its timeout (or on Ctrl+B,
 * or when the user sends a message) moved to the background rather than killed.
 * Every session builds its bash here so they cannot drift apart; what differs is
 * the operations each runs through and who is told when a job ends.
 */

import type { BashOperations, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBashTool, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { type BackgroundJobInfo, backgroundBashJobs } from "../_shared/background-bash.ts";
import {
	autoBackgroundTimeoutMs,
	backgroundTasksDisabled,
	canAutoBackground,
	defaultTimeoutMs,
	effectiveTimeoutMs,
	formatClaudeDuration,
	maxTimeoutMs,
} from "../_shared/bash-limits.ts";
import { type DetachReason, detachableExec, ShellDetachedError } from "../_shared/foreground-shells.ts";
import {
	EVENT_DELIVERY,
	type EventDelivery,
	exitDelivery,
	type OutgoingMessage,
	shouldNotifyExit,
	taskExitMessage,
	taskStallMessage,
} from "../_shared/monitor-events.ts";
import type { ShellStartRecord } from "../_shared/orphan-shells.ts";

const DESCRIPTION_TEXT = `Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.

Say what the command does in plain words: do not echo the command's text, its flags, or file paths - the user reads this description, often without seeing the command.

For simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):
- ls → "List files in current directory"
- git status → "Show working tree status"
- npm install → "Install package dependencies"

For commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:
- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"
- git reset --hard origin/main → "Discard all local changes and match remote main"
- curl -s url | jq '.data[]' → "Fetch JSON from URL and extract data array elements"`;

/**
 * What codemode scripts receive: pi's bash result, which finished commands keep, plus the task a
 * backgrounded command became. Declared here because pi's schema is not exported.
 */
const outputSchema = Type.Object({
	output: Type.String({
		description:
			"Combined stdout and stderr, possibly truncated; for a backgrounded command, the notice naming its task",
	}),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	exit_code: Type.Optional(Type.Number({ description: "Absent while the command runs in the background" })),
	wall_time_seconds: Type.Number(),
	background_task_id: Type.Optional(Type.String({ description: "Set when the command went to the background" })),
	output_file: Type.Optional(Type.String({ description: "Where a backgrounded command writes its output" })),
});

interface BashDetails {
	/** Set when the command went to (or started in) the background. */
	backgroundTaskId?: string;
}

export interface ClaudeBashOptions {
	cwd: string;
	shellPath?: string;
	commandPrefix?: string;
	/** What every command runs through. */
	operations: BashOperations;
	/** Where a job's notifications go: the session that started it. */
	sendMessage(message: OutgoingMessage<unknown>, delivery: EventDelivery): void;
	/** The main agent, which alone honours CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS. */
	isMain: boolean;
	/** Background jobs end with this session's final response: the start text says so. */
	endsWithFinalResponse?: boolean;
	/**
	 * Records a background shell's start and end in the session log, so a resumed
	 * session can tell the model about shells that never finished (the main session).
	 */
	record?: { start(record: ShellStartRecord): void; end(taskId: string): void };
}

/** Whether a command changes directory in any of its parts. */
function changesDirectory(command: string): boolean {
	return command.split(/&&|\|\||[;|&\n]/).some((part) => /^(?:cd|pushd|popd|chdir)(?:\s|$)/.test(part.trim()));
}

/**
 * What the model reads when a command goes to the background: at the start, by
 * Ctrl+B, at its timeout, or for a message the user sent.
 */
export function backgroundStartText(
	job: BackgroundJobInfo,
	options: { reason?: DetachReason; timeoutSeconds?: number; cwd: string; endsWithFinalResponse?: boolean },
): string {
	const file = ` Output is being written to: ${job.outputFile ?? "(unavailable)"}.`;
	const byUser = options.reason === "user";
	let head: string;
	if (byUser) head = `Command was manually backgrounded by user with ID: ${job.id}.${file}`;
	else if (options.reason === "message") {
		head = `Command was moved to the background (ID: ${job.id}) so that a message that arrived while it was running can reach you; it was not interrupted.${file}`;
	} else if (options.reason === "timeout") {
		head = `Command did not complete within its ${Math.max(1, Math.round(options.timeoutSeconds ?? 1))}s timeout and was moved to the background (ID: ${job.id}).${file}`;
	} else head = `Command running in background with ID: ${job.id}.${file}`;
	const notice = options.endsWithFinalResponse
		? "If it exits while you are still working you will be notified, but it is terminated when you give your final response and no notification can follow that — so do not end your turn to wait for it; if you need its result, wait for it before giving your final response."
		: byUser
			? undefined
			: "You will be notified when it completes.";
	const read = byUser ? undefined : "To check interim output, use read on that file path.";
	const text = [head, notice, read].filter(Boolean).join(" ");
	return changesDirectory(job.command)
		? `${text}\nSession cwd remains ${options.cwd}; directory changes made by the backgrounded command do not apply to subsequent commands.`
		: text;
}

/** pi's timeout line, with the duration respelled from the milliseconds given. */
function claudeTimeoutError(err: unknown, timeoutMs: number): unknown {
	if (!(err instanceof Error)) return err;
	const respelled = err.message.replace(
		/Command timed out after [\d.]+ seconds$/,
		`Command timed out after ${formatClaudeDuration(timeoutMs)}`,
	);
	return respelled === err.message ? err : new Error(respelled);
}

export function createClaudeBashTool(options: ClaudeBashOptions): ToolDefinition {
	const { cwd, shellPath, commandPrefix } = options;
	const base = createBashToolDefinition(cwd, { shellPath, commandPrefix });
	const disabled = backgroundTasksDisabled();

	const parameters = Type.Object({
		command: base.parameters.properties.command,
		timeout: Type.Optional(Type.Number({ description: `Optional timeout in milliseconds (max ${maxTimeoutMs()})` })),
		description: Type.Optional(Type.String({ description: DESCRIPTION_TEXT })),
		...(disabled
			? {}
			: {
					run_in_background: Type.Optional(
						Type.Boolean({ description: "Set to true to run this command in the background." }),
					),
				}),
	});
	type Params = Static<typeof parameters> & { run_in_background?: boolean };

	return {
		...base,
		description: base.description.replace("timeout in seconds", "timeout in milliseconds"),
		promptGuidelines: [
			...(base.promptGuidelines ?? []),
			`\`timeout\` is in milliseconds: default ${defaultTimeoutMs()}, max ${maxTimeoutMs()}.`,
			...(disabled
				? []
				: [
						"`run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. No `&` needed.",
					]),
		],
		parameters,
		outputSchema,
		// pi draws `(timeout Ns)` from the argument, which is milliseconds here.
		renderCall(args, theme, context) {
			const timeout = (args as { timeout?: unknown }).timeout;
			const shown =
				typeof timeout === "number" && timeout > 0 ? { ...(args as object), timeout: timeout / 1000 } : args;
			return base.renderCall?.(shown as never, theme, context as never) as never;
		},
		renderResult(result, renderOptions, theme, context) {
			if ((result.details as BashDetails | undefined)?.backgroundTaskId) {
				return new Text(theme.fg("dim", "Running in the background (↓ to manage)"), 0, 0);
			}
			return base.renderResult?.(result as never, renderOptions, theme, context as never) as never;
		},
		async execute(id, rawParams, signal, onUpdate, ctx) {
			const { description, run_in_background, timeout, ...rest } = rawParams as Params;
			const command = String(rest.command ?? "");
			const startedAt = performance.now();
			const ops = options.operations;
			const owner = ctx?.sessionManager?.getSessionId();
			// A child session's jobs carry its session id as their agent id: the main
			// session sees and may stop them, another child may not.
			const agentId = options.isMain ? undefined : owner;
			// One notification on exit, so `until ...; do sleep 1; done` in the
			// background is the single-notification recipe.
			const onExit = (finished: BackgroundJobInfo) => {
				options.record?.end(finished.id);
				if (shouldNotifyExit(finished)) options.sendMessage(taskExitMessage(finished, id), exitDelivery(finished));
			};
			const onStall = (job: BackgroundJobInfo, tail: string) =>
				options.sendMessage(taskStallMessage(job, tail, id), EVENT_DELIVERY);
			const started = (job: BackgroundJobInfo, reason?: DetachReason, timeoutSeconds?: number) => {
				options.record?.start({
					taskId: job.id,
					toolUseId: id,
					description: description?.trim() || command,
					command,
					outputFile: job.outputFile,
				});
				const text = backgroundStartText(job, {
					reason,
					timeoutSeconds,
					cwd,
					endsWithFinalResponse: options.endsWithFinalResponse,
				});
				const structuredContent = {
					output: text,
					truncated: false,
					wall_time_seconds: Math.round((performance.now() - startedAt) / 100) / 10,
					background_task_id: job.id,
					...(job.outputFile ? { output_file: job.outputFile } : {}),
				};
				return {
					content: [{ type: "text" as const, text }],
					details: { backgroundTaskId: job.id },
					structuredContent,
				};
			};

			if (run_in_background && !disabled) {
				// The job owns the process from here: neither the call's signal nor a
				// timeout reaches it, since backgrounding means outliving this call.
				const job = backgroundBashJobs.start({
					command,
					cwd,
					description,
					owner,
					agentId,
					exec: ops.exec,
					onExit,
					onStall,
				});
				return started(job);
			}

			const auto = canAutoBackground(command);
			const timeoutMs = autoBackgroundTimeoutMs(effectiveTimeoutMs(timeout), {
				isMain: options.isMain,
				canAutoBackground: auto,
			});
			// Ctrl+B and the timeout move this call to the background mid-flight; with
			// background tasks off, the timeout ends it instead and nothing can move it.
			const exec = disabled
				? ops.exec
				: detachableExec(ops.exec, { description, owner, agentId, onExit, onStall, autoBackground: auto });
			const tool = createBashTool(cwd, { shellPath, commandPrefix, operations: { exec } });
			try {
				return (await tool.execute(id, { ...rest, timeout: timeoutMs / 1000 } as never, signal, onUpdate)) as never;
			} catch (err) {
				if (err instanceof ShellDetachedError) return started(err.job, err.reason, err.timeout);
				throw claudeTimeoutError(err, timeoutMs);
			}
		},
	} as ToolDefinition;
}
