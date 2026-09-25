# PLAN — background bash at Claude Code 2.1.281 fidelity

Goal: bring bluclawd's background bash to Claude Code 2.1.281 fidelity. That covers:
- `run_in_background`
- moving a foreground command to the background (Ctrl+B, timeout, a queued message)
- the output file
- notifications
- `task_stop`
- the footer pill, `/tasks` and the stall watchdog
- lifecycle

The previous round targeted 2.1.276. Every deviation that remains is listed under
"Deliberate deviations".

Revision 2 (2026-09-25): an adversarial review against the CC source.
- Resolved 7 open questions.
- Corrected 5 wrong claims: the pill hint, the key-hint casing, the Shells header rule, the
  orphan notice, and a bad citation.
- Added 13 gaps: signal exits, the passive user stop, `task_stop` ownership, subagent bash,
  Ctrl+B timing, sandbox teardown on `/new`, and others.

**Evidence.** Citations like `m0373:22568` point into the 2.1.281 bundle, split into modules
and pretty-printed with esbuild. To rebuild the split:
1. Cut the embedded JS section out of `~/.local/share/claude/versions/2.1.281`, from byte
   172,519,000 to the end of the file.
2. Split it on `// @bun @bytecode`.
3. Run `esbuild --format=esm` on each piece and name them `mNNNN.js` in order.

Before changing a string, quote the code itself; a summary of it is not enough.

**Verification.**
- Every task: `npx vitest run <touched tests>`, `npm run typecheck`, `npm run lint`.
- Anything the model reads, the footer draws or the dialog draws also needs a live tmux
  verify with a real model (opencode-go, real HOME, isolated `--session-dir`). Send
  multi-key sequences as one `tmux send-keys -l` write.
- Before each edit, re-check `git status` and mtimes: another session shares this tree.

## Decisions needed before starting

- [x] **D1 — `task_output`.** CC 2.1.280 removed TaskOutput, together with its aliases and
  `retrieval_status` output (retired-name set at `m0373:25255`). The model reads the
  `.output` file with Read instead.
  - **A (recommended): remove `task_output` entirely**, both the shell half and the subagent
    half. Background subagents still deliver their result as a notification, and `task_wait`
    covers waiting.
  - B: remove only the shell half.
- [x] **D2 — `timeout` unit.** CC's Bash `timeout` is in milliseconds (default 120000, max
  600000). pi's is in seconds, with no default. Models trained on CC send milliseconds, so
  `timeout: 600000` currently means about 7 days.
  - **Recommended: CC's millisecond schema in both the parent's and the children's bash
    (1.8).** The monitor tool follows too: CC's Monitor takes `timeout_ms`.
  - Alternative: keep seconds everywhere and only add the 120 s default.
- [x] **D3 — subagent bash (1.8).** CC subagents have the full Bash tool with
  `run_in_background`. bluclawd children get pi's stock bash (`ext/sandbox/child-bash.ts:28`),
  which has no background, no Ctrl+B or timeout move, and takes seconds.
  - **Recommended: give children the same bash as the parent.**
  - Alternative: record a deviation and drop 2.2.
- [x] **D4 — graceful kill (2.4).** CC sends SIGTERM to the tree, then SIGKILL to the group
  1500 ms later. pi's `createLocalBashOperations` exposes no pid and sends SIGKILL at once.
  pi exports `getShellConfig`, but not `trackDetachedChildPid`.
  - Matching CC means an exec of our own (about 60 lines) plus our own kill-at-exit.
  - **Recommended: a recorded deviation.** The model sees `killed` either way. Only commands
    that clean up on SIGTERM notice the difference.
- [ ] **D5 — commits.** Is one commit per task approved up front, or should each one be asked?

## Tier 1 — what the model sees

- [x] **1.1 Exit status and summary text.**
  - **Classifier** (`xle` `m0373:82593`, `a6t` `m0373:82225`, `$2o`/`F2o` `m0373:82195`):
    - The command classified is the first word of the **last** segment of the command
      (`ql(e).at(-1)`).
    - Exit code 1 is `completed` with a note for:

      | Command | Note |
      |---|---|
      | `grep`, `rg`, `egrep`, `fgrep` | No matches found |
      | `find` | Some directories were inaccessible |
      | `diff` | Files differ |
      | `test`, `[` | Condition is false |

    - For those commands, only exit codes ≥ 2 are errors.
    - For git, find the subcommand by skipping flags; `-C` and `-c` also consume their value.
      `git diff` and `git grep` then follow the rows above.
    - Any other command is an error on any non-zero exit.
    - Fall back to "failed" when the last segment follows `&&`, the command does not parse, or
      the command is longer than 10000 chars (`H6e` `m0373:9750`). For example,
      `cd x && grep y` exiting 1 is `failed`.
    - The note is attached only to `completed`.
    - Reuse the quote-aware splitter from `ext/permissions`.
  - **Signal exit (a bug today).**
    - pi resolves `exitCode: null` after a signal.
    - bluclawd then reports `<status>completed</status>` together with `failed with exit code
      null` and a `[killed]` trailer.
    - CC (`#b` `m0373:809`): SIGTERM becomes 144 and any other signal becomes 1, both with
      `noExitStatus`, so the status is `failed`.
  - **Summary** (`KBe` `m0373:82427`):
    - `completed (exit code N[: note])`
    - `failed with exit code N`, or plain `failed` when there is no code
    - `was stopped`
    - Drop `describeJobStatus` from the summary; it produces `failed: <msg>` and
      `timed out after`, which CC never says.
  - **Trailer** (`m0373:82451`): `[killed]` only when the job was killed; otherwise
    `[exited with code N]`, or `unknown` when there is no code.
  - **Monitor end** (`KBe` monitor branch): ` (exit N)` only when a code exists. "Ended
    without producing output" is decided by stdout bytes, not by the event count.
  - One classifier in `_shared/`, wired into:
    - `taskState` in `background-bash.ts`
    - `jobState` in `tasks-dialog.ts`
    - `endStatus`, `taskExitSummary` and `monitorEndSummary` in `monitor-events.ts`
  - → verify: a table-driven unit test covering each command, exit 1, exit 2, `&&`, a pipeline,
    `git -C d grep`, a signal kill, and a spawn error.
  - → commit.

- [x] **1.2 Notification envelope and delivery.**
  - pi turns a custom message into a bare `user` text. CC:
    - prefixes it with `[SYSTEM NOTIFICATION - NOT USER INPUT] …` (`MGe` `m0296:27`);
    - wraps it in `<system-reminder>`, escaping any `</system-reminder>` inside;
    - HTML-escapes (`Bt`: `& < >`) the task-id, tool-use-id and summary;
    - caps the content at 100000 chars.
  - **A stop from `/tasks` is passive** (`L9r` `m0471:355`, `passive: true`). It must not
    wake the model: send it with `triggerTurn: false`, and include the tool-use-id (the
    monitor path leaves it out today, `monitor-tool.ts:258`).
  - Apply this to every sender of `taskNotification`: shell exit, stall, user stop, and monitor
    events and ends.
  - Also look at `subagentExitMessage`, which has its own format.
  - This matters for safety: the prefix is what stops a model from reading a notification as
    user consent.
  - → verify: unit tests on `content` and on the delivery options; a live run where pressing `x`
    starts no turn; the session JSONL shows the envelope.
  - → commit.

- [x] **1.3 Bash schema and prompt** (`H3t` `m0373` ~84264, `QDn` `m0373:24561`).
  - Parameter texts:
    - `run_in_background`: `Set to true to run this command in the background.`
    - `description`: CC's long active-voice text.
    - `dangerouslyDisableSandbox`: `Set this to true to dangerously override sandbox mode and
      run commands without sandboxing.`
    - `timeout`: per D2.
  - Add the lean-prompt lines to `promptGuidelines`, in CC's order. First check that the spread
    from `baseBash` carries `promptGuidelines`.
    - ``- `timeout` is in milliseconds: default 120000, max 600000.``
    - ``- `run_in_background` runs the command detached: it keeps running across turns and
      re-invokes you when it exits. No `&` needed.``
  - CC picks the lean or the full prompt per model (`$w`→`fG`, `m0181:202`). The lean one is
    taken for every provider.
  - `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` turns all of these off:
    - the `run_in_background` parameter
    - the guideline line
    - the Ctrl+B hint and key
    - timeout auto-background (a timeout then kills the command)
    - the queued-message detach from 1.5
  - → verify: a snapshot of the schema and guidelines, with and without the env var.
  - → commit.

- [x] **1.4 Timeout semantics** (`I4o` `m0373:84664`).
  - The default is 120 s and the maximum 600 s. `BASH_DEFAULT_TIMEOUT_MS` and
    `BASH_MAX_TIMEOUT_MS` override them; the max is never below the default.
  - `CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS` (`YJt` `m0250:56`, floor 2000) applies only on the
    main agent **and** only when the command can be auto-backgrounded
    (`if (!isMain || !canAutoBackground) return requested`).
  - A command whose first word is `sleep` is not auto-backgrounded (`x4o` `m0373:84291`). It is
    killed with exit 143 and the result `Command timed out after 2m 0s`.
  - **Bug:** an explicit `run_in_background` job gets `timeout` passed to `ops.exec`, so pi
    kills it at the timeout. CC clears the timer when a command goes to the background
    (`background()` → `#x()`, `m0373:818`/`915`). A background job has no timeout.
  - → verify: fake-timer units, plus a live run with `BASH_DEFAULT_TIMEOUT_MS=5000`:
    - a 10 s loop moves to the background;
    - `sleep 10` is killed with 143;
    - a `run_in_background` loop outlives its timeout.
  - → commit.

- [x] **1.5 Missing start-text variants** (`xxn` `m0373:22568`).
  - **cwd hint.** When the command uses cd/pushd/popd/chdir, append `Session cwd remains
    <cwd>; directory changes made by the backgrounded command do not apply to subsequent
    commands.` (`m0373:84641`)
  - **Queued-message detach.**
    - When the user submits while a foreground bash is running, detach it instead of making
      the message wait. Use `pi.on("input")` with `streamingBehavior` set.
    - Conditions (`dVo`/`ncr` `m0373:82547`; `m1404:1459`):
      - the shell has been running for ≥ 2 s;
      - the main session only;
      - background tasks are not disabled.
    - Tool result: `Command was moved to the background (ID: …) so that a message that arrived
      while it was running can reach you; it was not interrupted. Output is being written to:
      …`
  - **Reap text** for a synchronous subagent's shells. This depends on 1.8 and 2.2.
  - → verify: a unit per variant; a live run that types a message during `sleep 60; echo done`.
  - → commit.

- [x] **1.6 `task_output` per D1.**
  - Remove the tool, `shellTaskOutput`, and `waitFor`/`awaited` if nothing else uses them.
  - Remove every text that points at `task_output`:
    - the bash parameter
    - `ext/subagents/index.ts:599`
    - the TaskId description
    - the headless `/tasks` footer
  - → verify: grep finds no `task_output`; the suite is green.
  - → commit.

- [x] **1.7 `task_stop` fidelity** (`m0519:225`, `m0519:733`, `m0471:297`).
  - Schema: `task_id` and `shell_id` are both optional (`shell_id` is a deprecated alias). With
    neither present the result is `Missing required parameter: task_id`.
  - Description: `Stop a running background task by ID`, plus CC's prompt bullets that apply.
  - **Ownership** (`Xer`):
    - The main session may stop a child's shell. The owning child is then told `Task "<d>" was
      stopped by main session` with `<status>stopped</status>` (`D9r` `m0471:351`).
    - A child stopping a shell it does not own gets `Task <id> is owned by <owner>; agent
      <caller> cannot stop it.`
    - Today every owner mismatch answers `No task found`.
  - Unknown id: `No task found with ID: <id>` + `. Running background agents: id (desc), …`.
    `Did you mean` only suggests teammate or named-agent names, so it does not apply here.
  - → verify: unit tests.
  - → commit.

- [x] **1.8 Subagent children get the parent's bash (per D3).**
  - `child-bash.ts` gains the same schema (the D2 units, `run_in_background`), `detachableExec`,
    the timeout move and the notifications, all addressed to the child session.
  - Extract the parent's `execute` body into a shared factory. Do not copy it.
  - Correct the stale comment at `ext/subagents/index.ts:1154`.
  - → verify: an in-process child starts a background job, gets its notification, and
    `task_stop` works from both sides.
  - → commit.

## Tier 2 — lifecycle

- [x] **2.1 `/clear` keeps background shells** (`m0985`, spec §11).
  - On `session_start` with reason `new`, move running jobs from the previous main-session id
    to the new one.
  - **Also:** the sandbox runs `deactivate()` on every `session_shutdown`
    (`ext/sandbox/index.ts:484`). That calls `SandboxManager.reset()` and deletes the session
    `$TMPDIR` underneath the jobs kept alive. Skip the teardown on `new`/`resume` while jobs are
    running, and keep the session tmp directory until they end.
  - → verify: a live `/new` with a sandboxed running job (network plus `$TMPDIR` use). It shows
    in `/tasks`, stops with `task_stop`, and its notification arrives.
  - → commit.

- [x] **2.2 Synchronous subagent reap** (depends on 1.8).
  - Shells started by a foreground child are killed when that child gives its final response.
    Their start text carries the reap sentence.
  - Background children are exempt.
  - → verify: a subagents test.
  - → commit.

- [x] **2.3 Orphan notice on resume** (`m1294:841`, `:1005`, `:1012`, `:1045`).
  - Record job start and end with `appendEntry` (kept out of the model's context).
  - On `session_start` with reason `resume`:
    - Skip jobs still alive in this process. The registry is process-wide, so a `/resume` in
      the same process must not report running jobs.
    - **One orphan:** a `stopped` notification with the summary `Background shell command
      didn't finish before the previous session ended` and CC's `<note>`.
    - **Two or more:** **one** aggregate notification.
      - `<task-id>`s for the first 20, plus `__orphan_summary__:shell`.
      - Summary: `N background shell command tasks didn't finish before the previous session
        ended. Task ids: …`
      - CC's plural note, which explains the `__orphan_summary` marker.
    - `triggerTurn: false`.
  - → verify: live — one orphan, then two, then a same-process `/resume` with a live job.
  - → commit.

- [x] **2.4 Graceful kill — per D4.** If D4 is to implement it:
  - an exec of our own with SIGTERM, polling every 100 ms, and SIGKILL to the group after
    1500 ms;
  - our own kill-at-exit;
  - exit codes 137 for a kill and 143 for a timeout.
  - → verify: a trap-SIGTERM marker script.
  - → commit.

- [x] **2.5 Session exit.**
  - pi's `killTrackedDetachedChildren` runs in the interactive and print modes. Confirm that it
    reaches background jobs, including sandboxed ones. Fix only if it does not.
  - → verify: live — quit with a job running, then `ps` shows no survivor.

- [x] **2.6 Hold notifications while `/tasks` is open** (`m1404:28532`).
  - Queue notifications while the dialog is open, and flush them on close.
  - Show `Background task update waiting while this panel is open`, or the
    `N background task updates …` form.
  - → verify: live.
  - → commit.

- [x] **2.7 5 GB output cap** (optional).
  - Past the cap, write `\n[output truncated: exceeded 5GB disk cap]\n` and stop writing.
  - Kill the job with 137 and `Command killed: output file exceeded 5GB`.
  - → verify: a unit with a small injected cap.
  - → commit.

## Tier 3 — UI

- [x] **3.1 Bash result when backgrounded** (spec §2, `m1351`).
  - Show one dim line, `Running in the background (↓ to manage)`. This form has parentheses
    (`parens: true`).
  - Wrap `renderResult` and key it off `details.backgroundTaskId`.
  - → verify: a render test and live.
  - → commit.

- [x] **3.2 Notification line in the transcript** (`m1357:2884`).
  - Render one line: `⏺ <summary>` on macOS, `●` elsewhere.
  - Dot colour: completed → success, failed → error, killed → warning.
  - → verify: render tests and live.
  - → commit.

- [x] **3.3 Footer pill and Ctrl+B.**
  - **Pill hint** (default path `m1404:16600`; the parentheses form sits behind
    `tengu_copper_thistle`, which is off).
    - The hint is a separate dim item: `1 shell · ↓ to manage`, or `1 shell · Enter to view
      tasks` when the pill is selected.
    - Today bluclawd draws `(↓ to manage)`.
  - **Ctrl+B** (`p6` `m0373:82540`; registration at 2 s, `m0373:84770`).
    - It moves only foreground shells that have run for ≥ 2 s. Before that it does nothing,
      and the key stays the editor's cursor-left.
    - Draw the hint under the running tool at padding 5 (`ToolProgressHint`, `m1388:45`), not
      as an `aboveEditor` widget. If pi cannot draw it there, record a deviation.
  - **Subagent shells:** once 1.8 lands, they show in the main session's pill and `/tasks`.
    CC's `rm`/`LA` ignore `agentId`.
  - → verify: live.
  - → commit.

- [x] **3.4 `/tasks` dialog** (`out` `m1404:14714`; visibility `rm` `m0206:55`).
  - **Visibility:** only running and pending tasks show, so finished shells drop out. Sort
    running tasks first, then by start time, newest first.
  - **Sections:**
    - Order: Shells, Monitors, Local agents.
    - Headers render dim as `  <bold label> (N)` (`Pu` `m1404:15143`).
    - Command monitors belong under Shells, labelled by their description.
    - The Shells header shows only when there are local agents (or teammates, cloud or
      completed agents). A Monitors section does not trigger it (`m1404:15087`).
  - **Subtitle:** `N active shells · N active agents`. Shells include command monitors; there
    is no monitors entry.
  - **Title** in the `background` colour.
  - **Row status:** dim and coloured at once. When the row is selected, the suggestion colour
    covers the status too (`fc` `m1404:13747`).
  - **Key hints** use title case and no parentheses (`F`, `keyCase: "title"`, `m0649:7`):
    - list: `↑/↓ to select · Enter to view · x to stop · Esc to close`
    - detail: `← to go back · Esc/Enter/Space to close · x to stop`
  - **Opening a detail view:**
    - Enter only. Drop →.
    - WebSocket monitors have no detail view and no `Enter to view` hint (`OA` `m1404:14706`).
    - When exactly one detailable task is visible, open its detail directly.
  - **Detail view:**
    - A running status uses the `background` colour.
    - The output box has a fixed height of 12.
    - `Loading output…` while loading.
    - The `Showing N lines` footer is italic. It gets ` of <size>` only when the file is larger
      than the 8192 bytes read (`m1404:14586`).
    - When the viewed task ends, go back to the list; if the detail was opened directly, close
      the dialog (`m1404:14885`). `←` from a directly opened detail with ≤ 1 task closes the
      dialog (`m1404:14903`).
    - Closing the detail prints `Shell details dismissed` (`m1404:14499`).
  - → verify: dialog render tests and a live tmux walk-through.
  - → commit.

- [x] **3.5 Small parity fixes.**
  - Generate `randomTaskId` from `crypto.randomBytes` (`m0356`).
  - Strip ANSI from the stall notice's tail.
  - Output-path segment:
    - replace every non-alphanumeric character with `-`, dots included;
    - cut anything over 200 characters and append a base36 hash (`gT` `m0203`);
    - realpath the root.
  - → verify: units.
  - → commit.

## Deliberate deviations (keep; do not re-litigate)

- **Output root:** `/tmp/claude/bluclawd-<uid>/…`, not `/tmp/claude-<uid>/…`.
  - Why: the sandbox runtime's default write paths cover `/tmp/claude`, and a monitor's shell
    appends its stderr there itself.
  - `CLAUDE_CODE_TMPDIR` is not honoured for the output root: the sandbox sets it to a session
    directory that it deletes at shutdown.
- **Tool names:** snake_case (`task_stop`, `read`), as pi names tools. The texts name the real
  tools.
- **Kept extras:** `task_wait`, monitor `persistent`, the monitor 3600 s cap, and the headless
  `/tasks` entry.
- **Pill without local agents:** it counts shells and monitors only (commit 5478d99, on
  purpose). CC would show `1 local agent`, or `N background tasks` for a mix.
- **Lean prompt for every model:** CC chooses lean or full per model.
- **Not ported:**
  - The same-turn prefix variant (`QOn`): pi gives no signal that a real user message shares
    the turn.
  - Collapsing consecutive completed notifications into `N background commands completed` in
    fullscreen (`kar`): pi message renderers get only `expanded`/`outputPad` and cannot see
    their neighbours.
  - The memory-pressure reap: it needs critical memory plus 30 minutes idle, and it is
    CC-host specific.
  - Ctrl+B for foreground subagents: out of scope.
  - The foreground `sleep` block and Monitor gating: gated off by default in CC
    (`tengu_amber_sentinel`).
  - The VSCode agent map.
  - The `-p` result held back while background work finishes.

## Execution record (2026-09-25)

**Decisions taken:** D1 = A (`task_output` removed entirely); D2 = milliseconds everywhere a
bash runs (the monitor keeps its seconds — see deviations); D3 = children get the parent's
bash (`ext/sandbox/bash-tool.ts` builds both); D4 = recorded deviation; D5 still open.

**Found while executing (not in revision 2):**
- pi rebuilds the whole session runtime, extension instances included, on `/new`, `/resume`
  and fork. Anything a background job needs after a switch cannot live in an instance:
  - job notifications and session-log records go through `_shared/main-session.ts`, which
    holds what arrives between sessions;
  - the sandbox runtime kept for running jobs, its temp dir, and its network prompt all
    live in `sharedRef`s (`sandbox.kept`, `sandbox.hostAsker`);
  - the previous main session id for the `/clear` hand-over is a `sharedRef` too.
- Classifier details from the code: the last segment is judged; `&&` before it, an
  unparsable command, or one over 10000 chars falls back to the plain rule.
- The Ctrl+B hint stays a widget above the editor: in the fullscreen TUI that is directly
  under the running tool at indent 5, and it also shows for commands with no output (which
  never call `renderResult`).

**Verification:**
- `npx tsc --noEmit` clean; `npx biome check .` one warning, in `ext/web/render.ts` (not
  this work); `npx vitest run`: 86 files, 1172 tests pass.
- Live in tmux with a real model (opencode-go `gpt-5.6-luna`):
  - background start text, the one-line render and the `⏺ … completed (exit code 0)` line;
  - the session JSONL carries the `<system-reminder>` envelope and the start/end entries;
  - `grep` with no match → `completed (exit code 1: No matches found)`;
  - a 3s timeout moves the command; `sleep 5` with 2000 ms → `Command timed out after 2s`;
  - Ctrl+B hint after 2s, and Ctrl+B moves the command;
  - pill `1 shell · ↓ to manage`, then ↓ Enter opens the dialog;
  - dialog list, detail, `x` stop with the held-update line, and no turn after it;
  - a message sent mid-command moves the command and gets answered;
  - `/new` keeps the job, and its notification lands in the new session and wakes it;
  - quitting kills the jobs;
  - resuming shows the orphan notice without a turn;
  - `--sandbox`: a job outlives `/new` with its `$TMPDIR` and the sandbox still confines;
    the temp dir is removed at quit.
  - a synchronous `task` child's background `sleep 300` is killed at its final response (its
    output file ends `[killed]`), and the child got the reap sentence;
  - typing `/tasks` while a foreground command runs does not move it to the background.
- Not live-verified (unit tests only): the aggregate orphan notice, the 5 GB cap, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`.

**Deviations added while executing (keep):**
- A shell that dies of a signal reports exit code 1: pi resolves no signal name, so CC's
  144-for-SIGTERM cannot be told apart.
- The output root is not realpathed (`/tmp`, not `/private/tmp`, on macOS): the sandbox's
  write allowance is keyed on `/tmp/claude`.
- The monitor tool keeps `timeout` in seconds; CC's Monitor is gated off by default, and
  the tool is a bluclawd extra.
- Monitor events keep their multi-line transcript box; only shell notifications are CC's
  one line.
- Background subagent results keep their own message format (agent scope, not this plan).
- The dismissed-detail line is a `notify`, as pi has no system transcript line.
- `ext/permissions/evaluate.ts` still lists `task_output` among ungoverned tools; that file
  belongs to the permissions work in progress in another session, and a dead name there is
  harmless.
