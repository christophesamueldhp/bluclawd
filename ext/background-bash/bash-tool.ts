import type { BashOperations, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBashTool, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { withCommandPrefix } from "../_shared/command-prefix.ts";
import { type BackgroundJobInfo, backgroundBashJobs } from "./background-bash.ts";
import {
	autoBackgroundTimeoutMs,
	backgroundTasksDisabled,
	canAutoBackground,
	defaultTimeoutMs,
	effectiveTimeoutMs,
	formatTaskDuration,
	maxTimeoutMs,
} from "./bash-limits.ts";
import { type DetachReason, detachableExec, ShellDetachedError } from "./foreground-shells.ts";
import {
	EVENT_DELIVERY,
	type EventDelivery,
	exitDelivery,
	type OutgoingMessage,
	shouldNotifyExit,
	taskExitMessage,
	taskStallMessage,
} from "./monitor-events.ts";
import type { ShellStartRecord } from "./orphan-shells.ts";

const DESCRIPTION_TEXT = `Clear, concise description of what this command does, in active voice and plain words. Do not echo the command's text, its flags, or file paths: the user reads this description, often without seeing the command. Never use words like "complex" or "risk".

5-10 words for a simple command (git status → "Show working tree status"); more context for one that is harder to parse at a glance (git reset --hard origin/main → "Discard all local changes and match remote main").`;

/**
 * Declared here because pi's schema is not exported.
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
	backgroundTaskId?: string;
}

export const RUNNING_IN_BACKGROUND = "Running in the background (↓ to manage)";

export const wentToBackground = (details: unknown) => Boolean((details as BashDetails | undefined)?.backgroundTaskId);

export interface BackgroundBashOptions {
	cwd: string;
	shellPath?: string;
	commandPrefix?: () => string | undefined;
	operations: BashOperations;
	sendMessage(message: OutgoingMessage<unknown>, delivery: EventDelivery): void;
	isMain: boolean;
	endsWithFinalResponse?: boolean;
	record?: { start(record: ShellStartRecord): void; end(taskId: string): void };
}

function changesDirectory(command: string): boolean {
	return command.split(/&&|\|\||[;|&\n]/).some((part) => /^(?:cd|pushd|popd|chdir)(?:\s|$)/.test(part.trim()));
}

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

function timeoutError(err: unknown, timeoutMs: number): unknown {
	if (!(err instanceof Error)) return err;
	const respelled = err.message.replace(
		/Command timed out after [\d.]+ seconds$/,
		`Command timed out after ${formatTaskDuration(timeoutMs)}`,
	);
	return respelled === err.message ? err : new Error(respelled);
}

export function createBackgroundBashTool(options: BackgroundBashOptions): ToolDefinition {
	const { cwd, shellPath } = options;
	const base = createBashToolDefinition(cwd, { shellPath });
	const disabled = backgroundTasksDisabled();

	const parameters = Type.Object({
		command: base.parameters.properties.command,
		timeout: Type.Optional(
			Type.Number({
				description: `Timeout in seconds (optional, default ${defaultTimeoutMs() / 1000}, max ${maxTimeoutMs() / 1000})`,
			}),
		),
		description: Type.Optional(Type.String({ description: DESCRIPTION_TEXT })),
		...(disabled
			? {}
			: {
					run_in_background: Type.Optional(Type.Boolean()),
				}),
	});
	type Params = Static<typeof parameters> & { run_in_background?: boolean };

	return {
		...base,
		promptGuidelines: [
			...(base.promptGuidelines ?? []),
			...(disabled
				? []
				: [
						"`run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. No `&` needed.",
					]),
		],
		parameters,
		outputSchema,
		renderResult(result, renderOptions, theme, context) {
			if (wentToBackground(result.details)) return new Text(theme.fg("dim", RUNNING_IN_BACKGROUND), 0, 0);
			return base.renderResult?.(result as never, renderOptions, theme, context as never) as never;
		},
		async execute(id, rawParams, signal, onUpdate, ctx) {
			const { description, run_in_background, timeout, ...rest } = rawParams as Params;
			const command = String(rest.command ?? "");
			const startedAt = performance.now();
			const prefix = options.commandPrefix?.();
			const ops: BashOperations = prefix
				? {
						exec: (cmd, dir, execOptions) =>
							options.operations.exec(withCommandPrefix(prefix, cmd), dir, execOptions),
					}
				: options.operations;
			const owner = ctx?.sessionManager?.getSessionId();
			const agentId = options.isMain ? undefined : owner;
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
			const asked = timeout === undefined ? undefined : timeout * 1000;
			const timeoutMs = autoBackgroundTimeoutMs(effectiveTimeoutMs(asked), {
				isMain: options.isMain,
				canAutoBackground: auto,
			});
			const exec = disabled
				? ops.exec
				: detachableExec(ops.exec, { description, owner, agentId, onExit, onStall, autoBackground: auto });
			const tool = createBashTool(cwd, { shellPath, operations: { exec } });
			try {
				return (await tool.execute(id, { ...rest, timeout: timeoutMs / 1000 } as never, signal, onUpdate)) as never;
			} catch (err) {
				if (err instanceof ShellDetachedError) return started(err.job, err.reason, err.timeout);
				throw timeoutError(err, timeoutMs);
			}
		},
	} as ToolDefinition;
}
