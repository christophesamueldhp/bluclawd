/**
 * The `monitor` tool: a background job whose output lines are delivered to
 * the model as events.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { monitorSource } from "../_shared/monitor-source.ts";
import {
	type BackgroundExec,
	type BackgroundJobInfo,
	type BackgroundJobRegistry,
	backgroundBashJobs,
} from "./background-bash.ts";
import {
	EVENT_DELIVERY,
	EventBatcher,
	type EventDelivery,
	exitDelivery,
	formatDuration,
	monitorEndMessage,
	monitorEventMessage,
	type OutgoingMessage,
	TokenBucket,
	taskExitMessage,
} from "./monitor-events.ts";

/**
 * bluclawd's bounded monitor: every watch expires. `timeout_ms` defaults to 5
 * minutes, is refused past an hour, and is capped at 30 minutes.
 */
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 3_600_000;
const CAP_TIMEOUT_MS = 1_800_000;
const BATCH_WINDOW_MS = 200;
/** A bucket of 10 events, one back every 2s, and a stop after 30s of suppression. */
const DEFAULT_RATE_LIMIT = { capacity: 10, refillMs: 2000, maxSuppressMs: 30_000 };

const minutes = (ms: number) => `${Math.round(ms / 60_000)} minutes`;

/** bluclawd's Monitor prompt, with its tool names spelled as pi's (`bash`, `read`, `task_stop`). */
const MONITOR_DESCRIPTION = `Start a background monitor: each stdout line of a long-running command is an event. You keep working and events arrive in the chat as notifications; they are not replies from the user, even if one lands while you're waiting for the user to answer a question.

Pick by how many notifications you need:
- **One** ("tell me when the build finishes") → not monitor: **bash with \`run_in_background\`** and a command that exits when the condition is true, e.g. \`until grep -q "Ready in" dev.log; do sleep 0.5; done\`. An unbounded command (\`tail -f\`, \`while true\`) stays armed until the timeout, and \`tail -f log | grep -m 1 ...\` hangs too once the log goes quiet.
- **One per occurrence** → monitor, with an unbounded command (\`tail -f app.log | grep --line-buffered "ERROR"\`) or a poll loop that prints each new result and exits at a known end (e.g. one line per finished CI check, \`break\` when none is pending).

Script rules:
- Every pipe stage must flush per line or matches sit in its buffer unseen: \`grep\` needs \`--line-buffered\`, \`awk\` needs \`fflush()\`; \`| head -N\` delivers nothing until N lines accumulate.
- Only stdout is the event stream; stderr goes to the output file (readable via read). For a command you run directly, merge it with \`2>&1\` so its failures reach your filter.
- Poll loops: handle transient failures (\`curl ... || true\`), and sleep 30s+ for remote APIs, 0.5-1s for local checks.
- **Silence is not success.** The filter must match every terminal state, not just the happy path: \`grep -E --line-buffered "Traceback|Error|FAILED|Killed|OOM"\` beside the success marker, and a poll loop emits on \`succeeded|failed|cancelled|timeout\`. Before arming, ask: if this process crashed right now, would my filter emit anything? If unsure, widen it.
- Stay selective all the same: every line is a conversation message. Never pipe raw logs. A monitor that produces too many events is stopped automatically; restart it with a tighter filter.

The script runs in the same shell environment as bash. Exit ends the watch and reports its exit code. Every monitor expires after \`timeout_ms\` (default ${minutes(DEFAULT_TIMEOUT_MS)}, at most ${minutes(CAP_TIMEOUT_MS)}): it is killed and you get one notice with the event count. Re-arm it if you still need the watch; for a long watch set \`timeout_ms\` to the maximum and re-arm on each expiry, and widen the filter if an expiry with no events was unexpected. Use task_stop to cancel early.`;

const monitorSchema = Type.Object({
	command: Type.Optional(Type.String({ description: "Shell command or script." })),
	ws: Type.Optional(
		Type.Object(
			{
				url: Type.String(),
				protocols: Type.Optional(Type.Array(Type.String({ pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" }))),
			},
			{
				description:
					"In place of `command`, a WebSocket to watch: each text frame is one event (a multiline frame stays one), a binary frame is reported as `[binary frame, N bytes]`, and its close ends the watch with the close code. Subscribe to a filtered feed where one exists. Prefer it over `websocat`; use a command when frames need shell tools first.",
			},
		),
	),
	description: Type.String({
		description:
			'What you are monitoring, specific: it appears in every notification ("errors in deploy.log", not "watching logs").',
	}),
	// Optional, not required-with-a-default: pi validates arguments but never applies
	// schema defaults, so a required field would make omitting it an error rather than
	// the default this documents.
	timeout_ms: Type.Optional(
		Type.Number({
			minimum: 1000,
			maximum: MAX_TIMEOUT_MS,
			default: DEFAULT_TIMEOUT_MS,
			description: `Milliseconds; above ${CAP_TIMEOUT_MS} it is capped to ${CAP_TIMEOUT_MS}.`,
		}),
	),
});

type MonitorParams = {
	command?: string;
	ws?: { url: string; protocols?: string[] };
	description: string;
	timeout_ms?: number;
};

/** Single-quoted for sh: the output file path goes into the command line. */
const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * Stdout alone is the event stream: the command's stderr is appended to the job's
 * output file by the shell itself, so it never reaches the line sink. Without an
 * output file both streams stay events.
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
	sendMessage: (message: OutgoingMessage<unknown>, options: EventDelivery) => void;
	cwd: string;
	exec: BackgroundExec;
	/** pi's `shellCommandPrefix`, read per command: the settings are read after the tool is built. */
	commandPrefix?: () => string | undefined;
	registry?: BackgroundJobRegistry;
	rateLimit?: { capacity: number; refillMs: number; maxSuppressMs: number };
}

export function createMonitorTool(deps: MonitorToolDeps): ToolDefinition<typeof monitorSchema, undefined> {
	const registry = deps.registry ?? backgroundBashJobs;
	const rateLimit = deps.rateLimit ?? DEFAULT_RATE_LIMIT;

	return {
		name: "monitor",
		label: "monitor",
		// Off unless the user's `defaultTools` or `--tools` names it: few sessions call it, and every request pays for it.
		defaultActive: false,
		description: MONITOR_DESCRIPTION,
		promptSnippet: "Watch a long-running command or a WebSocket and get each output line or frame as an event",
		parameters: monitorSchema,
		async execute(toolCallId, params: MonitorParams, _signal, _onUpdate, ctx) {
			const source = monitorSource(params);
			if (source.kind === "invalid") {
				return { content: [{ type: "text", text: source.reason }], isError: true, details: undefined };
			}
			const command = source.kind === "command" ? source.command : undefined;
			const prefix = deps.commandPrefix?.();
			const watched = stdoutOnly(deps.exec);
			// Prefixed inside the stdout-only wrapping, so the prefix's stderr is not an event either.
			const exec: BackgroundExec = prefix
				? (cmd, dir, options) => watched(`${prefix}\n${cmd}`, dir, options)
				: watched;
			// In seconds, as the registry takes it.
			const timeout = Math.min(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, CAP_TIMEOUT_MS) / 1000;

			const bucket = new TokenBucket(rateLimit);
			let suppressed = 0;
			let suppressedSince: number | undefined;
			let lastSuppressedAt: number | undefined;
			let overloadSuppressed = 0;
			const batcher = new EventBatcher({
				delayMs: BATCH_WINDOW_MS,
				// Every line of a batch is one event; eventText applies the caps.
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
				// A refilled token alone is not recovery while other batches are still suppressed.
				if (lastSuppressedAt !== undefined && now - lastSuppressedAt >= rateLimit.refillMs) {
					suppressedSince = undefined;
					lastSuppressedAt = undefined;
					overloadSuppressed = 0;
				}
				if (!bucket.take(now)) {
					suppressed++;
					overloadSuppressed++;
					suppressedSince ??= now;
					lastSuppressedAt = now;
					if (now - suppressedSince > rateLimit.maxSuppressMs) {
						registry.kill(job.id, {
							reason: `[Monitor stopped — too much output (${overloadSuppressed} events suppressed over ${Math.round((now - suppressedSince) / 1000)}s). Restart with a more selective source.]`,
						});
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
				registry.recordEvent(job.id);
				deps.sendMessage(monitorEventMessage(job, [...notice, ...lines]), EVENT_DELIVERY);
			};

			current = registry.start({
				command: source.kind === "ws" ? source.url : source.command,
				cwd: deps.cwd,
				exec: source.kind === "ws" ? websocketExec(source.url, source.protocols) : exec,
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
						deps.sendMessage(taskExitMessage(job, toolCallId), exitDelivery(job));
						return;
					}
					if (job.exit?.error?.startsWith("timeout:")) {
						// Expiry is one notice, and the kill after it is silent.
						const events = registry.get(job.id)?.events ?? job.events;
						const expired =
							events === 0
								? `[Monitor expired after ${formatDuration(timeout * 1000)} with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]`
								: `[Monitor expired after ${formatDuration(timeout * 1000)} with ${events} ${events === 1 ? "event" : "events"} delivered. Re-arm it if you still need the watch.]`;
						deps.sendMessage(monitorEventMessage(job, [...lines, expired]), EVENT_DELIVERY);
						return;
					}
					deps.sendMessage(monitorEndMessage(job, lines), EVENT_DELIVERY);
				},
			});

			const lifetime = `expires in ${formatDuration(timeout * 1000)} unless the source ends first; you get one notice at expiry — re-arm if you still need the watch`;
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
