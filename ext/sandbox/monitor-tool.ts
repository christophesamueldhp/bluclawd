/**
 * The `monitor` tool: a background job whose output lines are delivered to
 * the model as events (Claude Code `Monitor` parity). Registered by the
 * sandbox extension because the command must pass the same refusal and run
 * through the same operations as every other shell path.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type BackgroundExec,
	type BackgroundJobInfo,
	type BackgroundJobRegistry,
	backgroundBashJobs,
} from "../_shared/background-bash.ts";
import {
	type Batch,
	EVENT_DELIVERY,
	EventBatcher,
	monitorEndMessage,
	monitorEventMessage,
	type OutgoingMessage,
	RateLimiter,
} from "../_shared/monitor-events.ts";

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 3600;
const BATCH_WINDOW_MS = 200;
const DEFAULT_RATE_LIMIT = { max: 20, windowMs: 60_000 };

const monitorSchema = Type.Object({
	command: Type.String({
		description:
			"Shell command or script. Each output line (stdout and stderr both) is an event; exit ends the watch. Add 2>/dev/null to silence stderr.",
	}),
	description: Type.String({
		description: "Short description of what is being watched, shown in every event (e.g. 'errors in deploy.log').",
	}),
	timeout: Type.Optional(
		Type.Number({
			minimum: 1,
			description: `Kill the monitor after this many seconds. Default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}. Ignored when persistent is true.`,
		}),
	),
	// Optional, not required-with-a-default: pi validates arguments but never applies
	// schema defaults, so a required field would make omitting it an error rather than
	// the false this documents.
	persistent: Type.Optional(
		Type.Boolean({
			description:
				"Run for the lifetime of the session (no timeout). Use for session-length watches. Stop with kill_bash.",
			default: false,
		}),
	),
});

type MonitorParams = { command: string; description: string; timeout?: number; persistent?: boolean };

export interface MonitorToolDeps {
	sendMessage: (message: OutgoingMessage<unknown>, options: typeof EVENT_DELIVERY) => void;
	cwd: string;
	/** Resolved per call so the sandbox state (and the command) at call time decides the operations. */
	exec: (command: string) => BackgroundExec;
	/** A reason to refuse (sandbox.strict), or undefined to proceed. */
	refuse: () => string | undefined;
	registry?: BackgroundJobRegistry;
	rateLimit?: { max: number; windowMs: number };
}

export function createMonitorTool(deps: MonitorToolDeps): ToolDefinition<typeof monitorSchema, undefined> {
	const registry = deps.registry ?? backgroundBashJobs;
	const rateLimit = deps.rateLimit ?? DEFAULT_RATE_LIMIT;

	return {
		name: "monitor",
		label: "monitor",
		description: [
			"Start a background monitor that streams events from a long-running command. Each output line becomes a message in the conversation, delivered while you keep working or waking you when idle. Exit ends the watch and is always reported.",
			"Use it for one notification per occurrence (tail -f | grep --line-buffered ERROR; a poll loop that prints one line per change). For a single 'tell me when done' notification use bash with run_in_background instead: it notifies once on exit.",
			"Filter to the lines you would act on, covering failure signatures as well as success: a monitor that only greps the happy path stays silent through a crash. Every pipe stage must flush per line (grep --line-buffered, awk fflush()). Monitors that produce too many events are stopped automatically.",
			"Read the full buffer with bash_output, stop with kill_bash.",
		].join("\n"),
		promptSnippet: "Watch a long-running command and get each output line as an event",
		parameters: monitorSchema,
		async execute(_toolCallId, params: MonitorParams) {
			const refusal = deps.refuse();
			if (refusal) {
				return { content: [{ type: "text", text: refusal }], isError: true, details: undefined };
			}
			const timeout = params.persistent
				? undefined
				: Math.min(params.timeout ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);

			const limiter = new RateLimiter(rateLimit);
			const batcher = new EventBatcher({
				delayMs: BATCH_WINDOW_MS,
				// Runs from a raw timer, outside the registry's guarded sinks: a throw here
				// would be an uncaughtException, the same class the sink guard closes.
				onFlush: (batch) => {
					try {
						deliver(batch);
					} catch {}
				},
			});
			let current: BackgroundJobInfo | undefined;

			const deliver = (batch: Batch) => {
				// current is set before the first flush: deliver only runs from the batch timer.
				const job = registry.get(current!.id) ?? current!;
				// exit: the exit path sends the terminal message with whatever is left.
				// killed: a child that traps the signal keeps producing output, and the
				// exit guard alone would let it steer on until it finally died.
				if (job.exit || job.killed) return;
				registry.recordEvent(job.id);
				deps.sendMessage(monitorEventMessage(job, batch), EVENT_DELIVERY);
				if (limiter.record(Date.now())) {
					registry.kill(
						job.id,
						`too many events (${rateLimit.max} in ${rateLimit.windowMs / 1000}s), restart with a tighter filter`,
					);
				}
			};

			current = registry.start({
				command: params.command,
				cwd: deps.cwd,
				exec: deps.exec(params.command),
				description: params.description,
				timeout,
				kind: "monitor",
				onLines: (lines) => batcher.push(lines),
				onExit: (job) => {
					const batch = batcher.take();
					// A line that arrived just before exit rides along in the terminal message
					// instead of a batch flush, but it is still an event: count it here so
					// /tasks does not show 0 events for a monitor that delivered one.
					if (batch.lines.length > 0) registry.recordEvent(job.id);
					deps.sendMessage(monitorEndMessage(job, batch), EVENT_DELIVERY);
				},
			});

			return {
				content: [
					{
						type: "text",
						text: `Started monitor ${current.id} (${params.description}). Each output line arrives as an event; read the full buffer with bash_output, stop it with kill_bash.`,
					},
				],
				details: undefined,
			};
		},
	};
}
