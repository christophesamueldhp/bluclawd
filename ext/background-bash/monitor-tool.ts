/**
 * The `monitor` tool: a background job whose output lines are delivered to
 * the model as events.
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
	type EventDelivery,
	exitDelivery,
	formatDuration,
	monitorEndMessage,
	monitorEventMessage,
	type OutgoingMessage,
	TokenBucket,
	taskExitMessage,
} from "../_shared/monitor-events.ts";
import { monitorSource } from "../_shared/monitor-source.ts";

/**
 * Claude Code's bounded monitor: every watch expires. `timeout_ms` defaults to 5
 * minutes, is refused past an hour, and is capped at 30 minutes.
 */
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 3_600_000;
const CAP_TIMEOUT_MS = 1_800_000;
const BATCH_WINDOW_MS = 200;
/** A bucket of 10 events, one back every 2s, and a stop after 30s of suppression. */
const DEFAULT_RATE_LIMIT = { capacity: 10, refillMs: 2000, maxSuppressMs: 30_000 };

const minutes = (ms: number) => `${Math.round(ms / 60_000)} minutes`;

/** Claude Code's Monitor prompt, with its tool names spelled as pi's (`bash`, `read`, `task_stop`). */
export const MONITOR_DESCRIPTION = `Start a background monitor that streams events from a long-running script. Each stdout line is an event — you keep working and notifications arrive in the chat. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.

Pick by how many notifications you need:
- **One** ("tell me when the server is ready / the build finishes") → use **bash with \`run_in_background\`** and a command that exits when the condition is true, e.g. \`until grep -q "Ready in" dev.log; do sleep 0.5; done\`. You get a single completion notification when it exits.
- **One per occurrence, until the monitor expires (re-arm to continue)** ("tell me every time an ERROR line appears") → monitor with an unbounded command (\`tail -f\`, \`inotifywait -m\`, \`while true\`).
- **One per occurrence, until a known end** ("emit each CI step result, stop when the run completes") → monitor with a command that emits lines and then exits.

Your script's stdout is the event stream. Each line becomes a notification. Exit ends the watch.

  # Each matching log line is an event
  tail -f /var/log/app.log | grep --line-buffered "ERROR"

  # Each file change is an event
  inotifywait -m --format '%e %f' /watched/dir

  # Poll GitHub for new PR comments and emit one line per new comment
  last=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  while true; do
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    gh api "repos/owner/repo/issues/123/comments?since=$last" --jq '.[] | "\\(.user.login): \\(.body)"'
    last=$now; sleep 30
  done

  # Node script that emits events as they arrive (e.g. WebSocket listener)
  node watch-for-events.js

  # Per-occurrence with a natural end: emit each CI check as it lands, exit when the run completes
  prev=""
  while true; do
    s=$(gh pr checks 123 --json name,bucket)
    cur=$(jq -r '.[] | select(.bucket!="pending") | "\\(.name): \\(.bucket)"' <<<"$s" | sort)
    comm -13 <(echo "$prev") <(echo "$cur")
    prev=$cur
    jq -e 'all(.bucket!="pending")' <<<"$s" >/dev/null && break
    sleep 30
  done

**Don't use an unbounded command for a single notification.** \`tail -f\`, \`inotifywait -m\`, and \`while true\` never exit on their own, so the monitor stays armed until timeout even after the event has fired. For "tell me when X is ready," use bash \`run_in_background\` with an \`until\` loop instead (one notification, ends in seconds). Note that \`tail -f log | grep -m 1 ...\` does *not* fix this: if the log goes quiet after the match, \`tail\` never receives SIGPIPE and the pipeline hangs anyway.

**Script quality:**
- Every pipe stage must flush per line or matches sit in its buffer unseen: \`grep\` needs \`--line-buffered\`, \`awk\` needs \`fflush()\`. \`head\` cannot flush at all — \`| head -N\` delivers nothing until N matches accumulate, then ends the stream.
- In poll loops, handle transient failures (\`curl ... || true\`) — one failed request shouldn't kill the monitor.
- Poll intervals: 30s+ for remote APIs (rate limits), 0.5-1s for local checks.
- Write a specific \`description\` — it appears in every notification ("errors in deploy.log" not "watching logs").
- Only stdout is the event stream. Stderr goes to the output file (readable via read) but does not trigger notifications — for a command you run directly (e.g. \`python train.py 2>&1 | grep --line-buffered ...\`), merge stderr with \`2>&1\` so its failures reach your filter. (No effect on \`tail -f\` of an existing log — that file only contains what its writer redirected.)

**Coverage — silence is not success.** When watching a job or process for an outcome, your filter must match every terminal state, not just the happy path. A monitor that greps only for the success marker stays silent through a crashloop, a hung process, or an unexpected exit — and silence looks identical to "still running." Before arming, ask: *if this process crashed right now, would my filter emit anything?* If not, widen it.

  # Wrong — silent on crash, hang, or any non-success exit
  tail -f run.log | grep --line-buffered "elapsed_steps="

  # Right — one alternation covering progress + the failure signatures you'd act on
  tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED|assert|Killed|OOM"

For poll loops checking job state, emit on every terminal status (\`succeeded|failed|cancelled|timeout\`), not just success. If you cannot confidently enumerate the failure signatures, broaden the grep alternation rather than narrow it — some extra noise is better than missing a crashloop.

**Output volume**: Every stdout line is a conversation message, so the filter should be selective — but selective means "the lines you'd act on," not "only good news." Never pipe raw logs; filter to exactly the success and failure signals you care about. Monitors that produce too many events are automatically stopped; restart with a tighter filter if this happens.

Stdout lines within 200ms are batched into a single notification, so multiline output from a single event groups naturally.

The script runs in the same shell environment as bash. Exit ends the watch (exit code is reported). Every monitor expires after \`timeout_ms\` (default ${minutes(DEFAULT_TIMEOUT_MS)}, at most ${minutes(CAP_TIMEOUT_MS)}): it is killed and you get one notice with the event count. Re-arm it if you still need the watch; for a long watch (PR monitoring, log tails) set \`timeout_ms\` to the maximum and re-arm on each expiry, and widen the filter if an expiry with no events was unexpected. Use task_stop to cancel early.
**ws source** — open a WebSocket and stream each incoming text frame as an event. No shell, no polling: the server pushes, you get notified.

  monitor({
    ws: {url: 'wss://events.example.com/stream', protocols: ['v1']},
    description: 'deploy events',
  })

Each text frame becomes one notification (multiline frames stay as one event). Binary frames are reported as \`[binary frame, N bytes]\` rather than passed through. Socket close ends the watch with the close code surfaced; errors are surfaced before close. Same rate limiting as bash — a firehose will be suppressed and eventually stopped, so subscribe to a filtered feed where one exists.

Prefer this over \`command: 'websocat wss://…'\` — it avoids the extra process and line-buffering pitfalls. Use bash when you need to transform or filter frames with shell tools before they become events.`;

const monitorSchema = Type.Object({
	command: Type.Optional(
		Type.String({ description: "Shell command or script. Each stdout line is an event; exit ends the watch." }),
	),
	ws: Type.Optional(
		Type.Object(
			{
				url: Type.String(),
				protocols: Type.Optional(Type.Array(Type.String({ pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" }))),
			},
			{
				description:
					"WebSocket to open. Each text frame is an event; binary frames are reported as a placeholder line. Socket close ends the watch. Cannot be combined with command.",
			},
		),
	),
	description: Type.String({
		description: "Short human-readable description of what you are monitoring (shown in notifications).",
	}),
	// Optional, not required-with-a-default: pi validates arguments but never applies
	// schema defaults, so a required field would make omitting it an error rather than
	// the default this documents.
	timeout_ms: Type.Optional(
		Type.Number({
			minimum: 1000,
			maximum: MAX_TIMEOUT_MS,
			default: DEFAULT_TIMEOUT_MS,
			description: `Kill the monitor after this deadline. Default ${DEFAULT_TIMEOUT_MS}ms. Deadlines above ${CAP_TIMEOUT_MS}ms are capped to ${CAP_TIMEOUT_MS}ms. You are notified at expiry and can re-arm.`,
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
	registry?: BackgroundJobRegistry;
	rateLimit?: { capacity: number; refillMs: number; maxSuppressMs: number };
}

export function createMonitorTool(deps: MonitorToolDeps): ToolDefinition<typeof monitorSchema, undefined> {
	const registry = deps.registry ?? backgroundBashJobs;
	const rateLimit = deps.rateLimit ?? DEFAULT_RATE_LIMIT;

	return {
		name: "monitor",
		label: "monitor",
		description: MONITOR_DESCRIPTION,
		promptSnippet: "Watch a long-running command or a WebSocket and get each output line or frame as an event",
		parameters: monitorSchema,
		async execute(toolCallId, params: MonitorParams, _signal, _onUpdate, ctx) {
			const source = monitorSource(params);
			if (source.kind === "invalid") {
				return { content: [{ type: "text", text: source.reason }], isError: true, details: undefined };
			}
			const command = source.kind === "command" ? source.command : undefined;
			// In seconds, as the registry takes it.
			const timeout = Math.min(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, CAP_TIMEOUT_MS) / 1000;

			const bucket = new TokenBucket(rateLimit);
			let suppressed = 0;
			let suppressedSince: number | undefined;
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
				if (!bucket.take(now)) {
					suppressed++;
					suppressedSince ??= now;
					if (now - suppressedSince > rateLimit.maxSuppressMs) {
						registry.kill(job.id, {
							reason: `[Monitor stopped — too much output (${suppressed} events suppressed over ${Math.round((now - suppressedSince) / 1000)}s). Restart with a more selective source.]`,
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
				suppressedSince = undefined;
				registry.recordEvent(job.id);
				deps.sendMessage(monitorEventMessage(job, [...notice, ...lines]), EVENT_DELIVERY);
			};

			current = registry.start({
				command: source.kind === "ws" ? source.url : source.command,
				cwd: deps.cwd,
				exec: source.kind === "ws" ? websocketExec(source.url, source.protocols) : stdoutOnly(deps.exec),
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
