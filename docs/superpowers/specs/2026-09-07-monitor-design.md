# Monitor tool design

Date: 2026-09-07. Status: approved in conversation, pending written review.

## Goal

Give the model a `monitor` tool in the shape of Claude Code's `Monitor`: run a
long-lived shell command in the background and deliver each line of its output
to the conversation as an event that wakes the model. Alongside it, give
ordinary `run_in_background` jobs a completion notification, which they do not
have today (they are poll-only through `bash_output`).

## Non-goals

- No WebSocket (`ws`) source. YAGNI.
- No push notifications to the user.
- No user-facing `/monitor` command. The model owns monitors; the user sees
  them in `/tasks` and stops them by asking the model or with `!` + `kill`.

## Latent bug fixed on the way

`backgroundBashJobs` in `ext/_shared/background-bash.ts` is a plain
`export const`. It is imported by two top-level extensions: `sandbox` (which
starts jobs) and `background-bash` (which reads, kills and lists them). pi's
package loader gives every top-level `pi.extensions` entry its own module
graph (`loadExtensionModule`, `moduleCache: false`), so the two extensions
almost certainly hold two different registries and `bash_output`, `kill_bash`
and `/tasks` see an empty one in the installed package. This is the class of
bug fixed by `sharedRef` in commit 633b0a7; the job registry was missed.

The fix is part of this design because monitors depend on the same registry.
The first implementation task verifies the bug live before fixing it, so the
regression test guards something real.

## 1. Shared registry (`ext/_shared/background-bash.ts`)

- `backgroundBashJobs` becomes
  `sharedRef("backgroundBashJobs", new BackgroundJobRegistry()).get()`.
- `BackgroundJobInfo` gains `kind: "job" | "monitor"`.
- `start()` accepts optional sinks: `onLines(lines: string[])` and
  `onExit(job: BackgroundJobInfo)`. The registry keeps buffering all output
  regardless, so `bash_output` still works on a monitor.
- Three pure, unit-tested pieces, in the pattern of `strictRefusalReason`:
  - `LineSplitter`: turns `onData` chunks into whole lines, carrying a
    trailing partial line into the next chunk and flushing it on exit.
  - `EventBatcher`: lines arriving within a 200 ms window form one batch. A
    batch holds at most 50 lines or 8 KB; the remainder is summarised as
    `…and N more lines`.
  - `RateLimiter`: more than 20 batches in a rolling 60 s window means
    auto-stop.

## 2. The `monitor` tool (registered in `ext/sandbox/index.ts`)

Registered next to `run_in_background`, because the command must pass
`strictRefusalReason()` and run through the same sandboxed or local operations.
This is the fourth shell path after the bash tool, background jobs and user
`!` commands.

Parameters:

| name          | type    | notes                                                        |
|---------------|---------|--------------------------------------------------------------|
| `command`     | string  | required; each output line is an event, exit ends the watch |
| `description` | string  | required; shown in every notification                        |
| `timeout`     | number  | seconds, default 300, max 3600 (same unit as pi's bash tool) |
| `persistent`  | boolean | default false; ignores timeout, lives until `kill_bash`      |

Tool result: `Started monitor bash_3 (description). Each output line arrives
as an event; stop it with kill_bash. /tasks lists it.`

Deliberate divergence from Claude Code: pi's `exec` merges stdout and stderr
into one stream, so both become events. The tool description says to add
`2>/dev/null` when stderr is noisy.

## 3. Delivering events to the model

- Each batch is sent with
  `pi.sendMessage({ customType: "bluclawd:monitor", display: true, content, details }, { deliverAs: "steer", triggerTurn: true })`.
  While streaming, pi queues it after the current turn's tool calls. While
  idle, pi starts a new turn (`sendCustomMessage` in pi's agent-session).
- Content is self-describing because it lands out of band:
  `[monitor bash_3 · errors in deploy.log]` on the first line, then the lines.
- A terminal event is always sent, whatever the cause:
  `ended: exit code N`, `killed`, `timed out after Ns`, `failed: <error>`, or
  `stopped: too many events (N in 60s), restart with a tighter filter`.
  Silence never means "still running".
- `pi.registerMessageRenderer("bluclawd:monitor")` in `background-bash`:
  accent header with id and description, plain event lines, terminal line in
  success / error / warning colour.

## 4. Completion notification for `run_in_background`

- `onExit` on an ordinary job sends `customType: "bluclawd:task-exit"`:
  `[task bash_2 · description] exited with code N — <command>` followed by
  at most the last 20 lines or 2 KB of output. Same delivery as monitors.
- A job killed through `kill_bash` does NOT notify: the model asked for it and
  already got the tool result. Timeouts and spawn failures do notify.
- `/tasks` shows a kind column (job / monitor) and, for monitors, the event
  count (batches sent, the same unit the rate limiter counts).

## 5. Verification

Unit tests:
- splitter, batcher, rate limiter, message formatting;
- the registry is visible across two separately loaded module copies
  (pattern of `test/global-state.test.ts`);
- `test/registration.test.ts`: `sandbox.tools` gains `monitor`.

Live in tmux with a real model (the idle-wake path cannot be unit tested):
- (a) a monitor emitting a line every few seconds while idle wakes the model;
- (b) an event arriving while a permission prompt is open does not break the
  prompt;
- (c) `run_in_background` with `until ...; do sleep 1; done` yields exactly one
  completion notification;
- (d) `/tasks` and `kill_bash` see a job started by the sandbox extension.

Docs: README command/tool table, "What it adds", and the stdout+stderr
divergence note.
