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
	EVENT_DELIVERY,
	EventBatcher,
	formatDuration,
	monitorEndMessage,
	monitorEventMessage,
	type OutgoingMessage,
	TokenBucket,
	taskExitMessage,
} from "../_shared/monitor-events.ts";
import { monitorSource } from "../_shared/monitor-source.ts";

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 3600;
const BATCH_WINDOW_MS = 200;
/** Claude Code's: a bucket of 10 events, one back every 2s, and a stop after 30s of suppression. */
const DEFAULT_RATE_LIMIT = { capacity: 10, refillMs: 2000, maxSuppressMs: 30_000 };

const monitorSchema = Type.Object({
	command: Type.Optional(
		Type.String({
			description:
				"Shell command or script. Each stdout line is an event; exit ends the watch. Stderr goes to the output file but does not trigger events: merge it with 2>&1 when its failures should reach your filter.",
		}),
	),
	ws: Type.Optional(
		Type.Object(
			{
				url: Type.String({ description: "ws:// or wss:// URL" }),
				protocols: Type.Optional(Type.Array(Type.String())),
			},
			{
				description:
					"WebSocket to open instead of a command. Each text frame is an event; binary frames are reported as a placeholder line. Socket close ends the watch. Cannot be combined with command.",
			},
		),
	),
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
				"Run for the lifetime of the session (no timeout). Use for session-length watches. Stop with task_stop.",
			default: false,
		}),
	),
});

type MonitorParams = {
	command?: string;
	ws?: { url: string; protocols?: string[] };
	description: string;
	timeout?: number;
	persistent?: boolean;
};

/** Single-quoted for sh: the output file path goes into the command line. */
const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * Stdout alone is the event stream (Claude Code's Monitor): the command's stderr is
 * appended to the job's output file by the shell itself, so it never reaches the
 * line sink. Without an output file both streams stay events, as before.
 */
export function stdoutOnly(exec: BackgroundExec): BackgroundExec {
	return (command, cwd, options) =>
		exec(options.outputFile ? `{ ${command}\n} 2>>${shellQuote(options.outputFile)}` : command, cwd, options);
}

/** A WebSocket as a job: each text frame is output, close is exit. Runs in this process, so the permission layer judges its host as a fetch. */
export function websocketExec(url: string, protocols?: string[]): BackgroundExec {
	return (_command, _cwd, { onData, signal, timeout }) =>
		new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let socket: WebSocket;
			const settle = (fn: () => void) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				fn();
			};
			const onAbort = () => {
				socket.close();
				settle(() => reject(new Error("aborted")));
			};
			try {
				socket = new WebSocket(url, protocols);
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			socket.binaryType = "arraybuffer";
			if (signal?.aborted) return onAbort();
			signal?.addEventListener("abort", onAbort, { once: true });
			if (timeout !== undefined) {
				timer = setTimeout(() => {
					socket.close();
					settle(() => reject(new Error(`timeout:${timeout}`)));
				}, timeout * 1000);
			}
			socket.addEventListener("message", (event) => {
				const text =
					typeof event.data === "string"
						? event.data
						: `[binary frame, ${(event.data as ArrayBuffer).byteLength} bytes]`;
				onData(Buffer.from(text.endsWith("\n") ? text : `${text}\n`));
			});
			socket.addEventListener("error", (event) => {
				const message = (event as ErrorEvent).message || "connection failed";
				onData(Buffer.from(`[WebSocket error: ${message}]\n`));
			});
			socket.addEventListener("close", (event) => {
				const reason = event.reason ? ` ${event.reason}` : "";
				onData(Buffer.from(`[WebSocket closed: ${event.code}${reason}]\n`));
				// 1000 is a normal close; anything else ends the watch as a failure.
				settle(() => resolve({ exitCode: event.code === 1000 ? 0 : event.code }));
			});
		});
}

export interface MonitorToolDeps {
	sendMessage: (message: OutgoingMessage<unknown>, options: typeof EVENT_DELIVERY) => void;
	cwd: string;
	/** Resolved per call so the sandbox state (and the command) at call time decides the operations. */
	exec: (command: string) => BackgroundExec;
	/** A reason to refuse (sandbox.strict), or undefined to proceed. */
	refuse: () => string | undefined;
	registry?: BackgroundJobRegistry;
	rateLimit?: { capacity: number; refillMs: number; maxSuppressMs: number };
}

export function createMonitorTool(deps: MonitorToolDeps): ToolDefinition<typeof monitorSchema, undefined> {
	const registry = deps.registry ?? backgroundBashJobs;
	const rateLimit = deps.rateLimit ?? DEFAULT_RATE_LIMIT;

	return {
		name: "monitor",
		label: "monitor",
		description: [
			"Start a background monitor that streams events from a long-running command or a WebSocket. Each stdout line (or text frame) becomes a message in the conversation, delivered while you keep working or waking you when idle. Exit ends the watch and is always reported.",
			"Use it for one notification per occurrence (tail -f | grep --line-buffered ERROR; a poll loop that prints one line per change). For a single 'tell me when done' notification use bash with run_in_background instead: it notifies once on exit.",
			"Filter to the lines you would act on, covering failure signatures as well as success: a monitor that only greps the happy path stays silent through a crash. Every pipe stage must flush per line (grep --line-buffered, awk fflush()). Monitors that produce too many events are stopped automatically.",
			"The whole output, stderr included, is in the output file named when the monitor starts (read it with the read tool); stop it with task_stop.",
		].join("\n"),
		promptSnippet: "Watch a long-running command or a WebSocket and get each output line or frame as an event",
		parameters: monitorSchema,
		async execute(_toolCallId, params: MonitorParams, _signal, _onUpdate, ctx) {
			const source = monitorSource(params);
			if (source.kind === "invalid") {
				return { content: [{ type: "text", text: source.reason }], isError: true, details: undefined };
			}
			const command = source.kind === "command" ? source.command : undefined;
			// The sandbox refusal is about shells; a socket opens in this process and is
			// judged by the permission layer as a fetch of its host.
			const refusal = command === undefined ? undefined : deps.refuse();
			if (refusal) {
				return { content: [{ type: "text", text: refusal }], isError: true, details: undefined };
			}
			const timeout = params.persistent
				? undefined
				: Math.min(params.timeout ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);

			const bucket = new TokenBucket(rateLimit);
			let suppressed = 0;
			let suppressedSince: number | undefined;
			const batcher = new EventBatcher({
				delayMs: BATCH_WINDOW_MS,
				// Every line of a batch is one event; eventText applies Claude Code's caps.
				maxLines: Number.POSITIVE_INFINITY,
				maxBytes: Number.POSITIVE_INFINITY,
				// Runs from a raw timer, outside the registry's guarded sinks: a throw here
				// would be an uncaughtException, the same class the sink guard closes.
				onFlush: (batch) => {
					try {
						deliver(batch.lines);
					} catch {}
				},
			});
			let current: BackgroundJobInfo | undefined;

			const deliver = (lines: string[]) => {
				// current is set before the first flush: deliver only runs from the batch timer.
				const job = registry.get(current!.id) ?? current!;
				// exit: the exit path sends the terminal message with whatever is left.
				// killed: a child that traps the signal keeps producing output, and the
				// exit guard alone would let it steer on until it finally died.
				if (job.exit || job.killed) return;
				const now = Date.now();
				if (!bucket.take(now)) {
					suppressed++;
					suppressedSince ??= now;
					if (now - suppressedSince > rateLimit.maxSuppressMs) {
						registry.kill(
							job.id,
							`[Monitor stopped — too much output (${suppressed} events suppressed over ${Math.round((now - suppressedSince) / 1000)}s). Restart with a more selective source.]`,
						);
					}
					return;
				}
				const notice =
					suppressed > 0
						? [
								`[${suppressed} events suppressed — output rate too high. Consider using TaskStop to restart this monitor with a more selective filter.]`,
							]
						: [];
				suppressed = 0;
				suppressedSince = undefined;
				registry.recordEvent(job.id);
				deps.sendMessage(monitorEventMessage(job, [...notice, ...lines]), EVENT_DELIVERY);
			};

			current = registry.start({
				command: source.kind === "ws" ? source.url : source.command,
				cwd: deps.cwd,
				exec:
					source.kind === "ws"
						? websocketExec(source.url, source.protocols)
						: stdoutOnly(deps.exec(source.command)),
				owner: ctx?.sessionManager?.getSessionId(),
				idPrefix: command === undefined ? "s" : "b",
				description: params.description,
				timeout,
				kind: "monitor",
				onLines: (lines) => batcher.push(lines),
				onExit: (job) => {
					const { lines } = batcher.take();
					// A line that arrived just before exit rides along in the terminal message
					// instead of a batch flush, but it is still an event: count it here so
					// /tasks does not show 0 events for a monitor that delivered one.
					if (lines.length > 0) registry.recordEvent(job.id);
					// The model's own task_stop is its answer already.
					if (job.killed && !job.stopReason && !job.stoppedByUser) return;
					if (job.stoppedByUser) {
						deps.sendMessage(taskExitMessage(job), EVENT_DELIVERY);
						return;
					}
					if (job.exit?.error?.startsWith("timeout:") && timeout !== undefined) {
						// Expiry is one notice, and the kill after it is silent (Claude Code).
						const events = registry.get(job.id)?.events ?? job.events;
						const expired =
							events === 0
								? `[Monitor expired after ${formatDuration(timeout * 1000)} with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]`
								: `[Monitor expired after ${formatDuration(timeout * 1000)} with ${events} event(s) delivered. Re-arm it if you still need the watch.]`;
						deps.sendMessage(monitorEventMessage(job, [...lines, expired]), EVENT_DELIVERY);
						return;
					}
					deps.sendMessage(monitorEndMessage(job, lines), EVENT_DELIVERY);
				},
			});

			const lifetime =
				timeout === undefined
					? "persistent — runs until TaskStop or session end"
					: `expires in ${formatDuration(timeout * 1000)} unless the source ends first; you get one notice at expiry — re-arm if you still need the watch`;
			return {
				content: [
					{
						type: "text",
						text: `Monitor started (task ${current.id}, ${lifetime}). You will be notified on each event. Keep working — do not poll or sleep. Events may arrive while you are waiting for the user — an event is not their reply.`,
					},
				],
				details: undefined,
			};
		},
	};
}
