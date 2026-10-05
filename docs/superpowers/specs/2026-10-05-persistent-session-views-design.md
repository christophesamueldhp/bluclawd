# Persistent session views and active-session deletion

Status: draft for user review. The user selected approach 1 (keep execution alive; switch only the view). This document specifies that approach; implementation has not started.

## Intent and success criteria

The user switches to another session and back while work is in progress. The original work must continue, without an `Operation aborted` message, repeated continuation prompts, or rerunning a tool. Agent View must also allow deleting the session currently displayed in the terminal.

Success means:

- Switching A → B → A preserves each live child's PID, instance ID, active turn, queued messages, and running tools.
- Opening, closing, or reconnecting a view never issues `abort`, `stop`, `switch_session`, `new_session`, or a continuation prompt to that session.
- Deleting the displayed session deliberately stops that session, removes its Agent View row, and leaves a blank composer ready for a new session. Other sessions continue.
- Exactly one execution process writes each session file. A terminal viewer never appends remote messages to a local Pi session file.
- Terminal exit detaches viewers; daemon-owned work continues unchanged.

Deletion keeps the existing Agent View semantics: remove the row, preserve the `.jsonl` for explicit `/resume`. It is not permanent transcript deletion. New behavior must be described that way in help text.

## Evidence and constraints

- `ext/agent-view/index.ts` replaces the native Pi runtime when opening a session, then invokes `handOff()` for the outgoing session.
- Pi's `AgentSessionRuntime.teardownCurrent()` aborts the current session before disposing it. This is upstream behavior, not a cosmetic error in this repository.
- `ext/agent-view/agent-view.ts` stops a live background writer before opening its file locally, then requests a continuation prompt if the turn was working or awaiting input.
- The same file explicitly rejects stop/delete for `row.self`.
- `daemon/ipc/server.ts` and `daemon/supervisor.ts` already provide `rpc_stream`; disconnecting a stream removes its subscriber without stopping the child.
- RPC `message_update` records contain deltas, not cumulative snapshots. A viewer attaching halfway through an answer cannot reconstruct its earlier deltas from a plain subscription or the persisted JSONL alone.
- The existing stream bridge serializes requests; a long-running command must not block an answer to an outstanding UI dialog.
- RPC supports select/confirm/input/editor and notification/status/widget/title requests, but not arbitrary terminal `ctx.ui.custom()` components. Native TUI built-in commands are not ordinary RPC prompt commands.
- The package must remain installable through `pi install`; no changes to Pi-owned files, private runtime patching, or requirement to launch only through `bin.mjs`.

## Architecture

### 1. Separate execution from terminal selection

Retain the existing daemon and one RPC child per live conversation. Daemon ownership begins before that conversation's first model prompt; it is not established by aborting an outgoing turn.

Add a terminal session controller inside the Agent View extension. It owns the selected instance, draft text/images per session, view lifecycle, and attach generation. It does not own model or tool execution.

The native Pi runtime is an idle UI host, not the execution runtime for managed conversations. A hidden bootstrap command obtains a command-capable context, captures any saved initial conversation as plain data, and releases its local runtime while idle before starting a child for that file. Suppress host self-registration and host hand-off after this transition, so the placeholder never appears as a real agent or becomes a daemon child on quit.

The new conversation screen uses the existing Pi TUI through `ctx.ui.custom()` and stock rendering/editor components. Do not create another terminal renderer. Its composer sends prompts to the selected child, never to the idle host. Initial startup and delayed initialization must prevent an ordinary local prompt from slipping through while managed mode is being established.

Lifecycle resources start only in TUI session startup or a command, never in the extension factory. RPC children must not bootstrap another viewer or another child.

### 2. Attachable conversation screen

Add a focused conversation component with:

- Saved history, streaming assistant text/thinking, tool calls and results, and explicit failure/stop notices.
- A multiline composer, image paste, command completion, per-session drafts, scrolling, resize handling, and focus propagation.
- The existing two-left-press path back to Agent View and Enter/right to select another conversation.
- Pending extension dialogs and supported notification/status/widget/title output.

Agent View's open action returns/selects an instance identity instead of transferring its session file into `ctx.switchSession()`. A stopped saved session is started once without a prompt, then attached. A live session is attached without spawning another writer. Ctrl+Enter creates a new daemon child using the chosen model and selects it; ordinary Enter in Agent View still creates a background session.

Only change selection after the target has a valid snapshot and subscription. If opening fails or is canceled, retain the old selection and its draft. Generation tokens discard stale responses from earlier attach attempts.

### 3. Snapshot plus ordered view events

Add an explicitly versioned `view_stream` protocol alongside the existing raw `rpc_stream`. Keep old clients working; do not silently change raw Pi event shapes.

The daemon maintains a display projection per live instance: finalized messages, the current partial assistant response, active tool calls/latest partial results, run/queue state, pending dialog, and display statuses/widgets. Use a pure reducer for Pi's JSON event shapes. Completed messages replace partial projections rather than being appended twice. Tool calls are keyed by `toolCallId`; nested tool calls must remain distinct.

A `view_ready` record contains instance identity, a process-generation identifier, a monotonic sequence watermark, and the projection. Subsequent `view_event` records contain that generation, sequence number, and one Pi event or UI request. Snapshot capture and subscriber registration occur in one synchronous daemon step, without an await between them. Events after the watermark are delivered in order.

For a saved conversation, seed the projection from a read-only parse of its saved entry tree before spawning the child, after excluding any local/external writer. Preserve entry IDs and the active branch; do not mutate or migrate the file in the viewer. For a new conversation, begin with an empty projection. Bind the reducer before any child events can be delivered and do not accept prompts until initialization completes; startup-time events are reduced in order as well. Never overwrite live display state with a late `get_messages` response. Compaction changes model context, not the existing displayed history: append its summary/status without discarding finalized display messages. Operations that actually change branch/leaf require a safe authoritative refresh while idle and must not run during another active operation.

The client replaces its projection on reconnect and consumes only events newer than the snapshot watermark. A changed process generation resets sequence tracking. Cache current display state, not an unbounded event log. Keep at most the newest 200 finalized display messages in the live projection, plus the complete current partial response and active tools. Expose the oldest retained stable entry ID as a history cursor; older persisted history is read in pages of at most 200 entries without changing the child's branch. Trim only finalized display messages, not the active partial response. The view renders an explicit older-history action when messages were trimmed.

Subscribe before sending the first prompt. Command responses are correlated by unique IDs, independent of stream-event order. UI responses use the dialog request ID. Treat a successful prompt acknowledgement as acceptance, not completion; only `agent_settled` settles work including retry/compaction/follow-ups.

### 4. Command and extension-UI routing

The conversation controller handles terminal navigation locally:

| User action | Destination |
| --- | --- |
| Normal prompt / image / skill / prompt template | Selected child via RPC prompt |
| Prompt while busy | RPC prompt with `streamingBehavior: followUp` |
| Explicit steering | Selected child via RPC steer |
| Explicit stop | Clear the queue, then abort the selected child; restore cleared text to its draft |
| `/agent-view`, left-left | Local view change; no child lifecycle command |
| `/new` | Blank local selection; previous child continues; create a child when the new prompt is sent |
| `/resume` | Local saved-session picker, then start-or-attach without a prompt |
| `/model`, thinking controls, `/compact`, `/name` | Corresponding selected-child RPC commands |
| `/status`, `/context`, `/export` | Selected-child state/stats/export; never idle-host data |
| `/help`, theme/UI-only settings | Local UI |
| Known RPC-compatible extension command | RPC prompt to selected child |

Unknown slash commands are rejected with a clear explanation rather than becoming model prompts accidentally. Commands known to need unsupported native/custom TUI interactions are labeled unavailable in the managed screen; they must never execute against the placeholder's session. Third-party custom TUI parity is outside this fix. For this first implementation, session-sensitive bundled custom-UI commands (notably `/tasks`, `/bashes`, and `/rewind`) explicitly report that their interactive screen is unavailable in a managed conversation; their underlying model-callable tools and checkpoint capture remain active in the child. Do not falsely advertise remote UI parity. Adding interactive adapters is a separate follow-up, and this compatibility difference is visible in help and release notes.

Detaching a view does not answer or cancel a pending dialog. The daemon retains it for Agent View's Needs input band and replays it on reattach. Explicit cancellation sends one matching UI response. A disconnected viewer cannot claim it answered a dialog. Route UI responses separately from long-running RPC commands, preventing deadlocks.

Multiple terminals may view one daemon-owned session without a second writer. Dialog answers are validated by the daemon against the current pending request so only one succeeds. Remove the current single `onUiRequest` owner assumption for managed viewers. Replies from all viewers enter the child's queues rather than local runtimes.

### 5. Delete the selected session

Preserve the two-press Ctrl+X interaction:

1. First press arms deletion and explicitly stops current work in that session, just as for other rows. For a managed session, this is a deliberate user action, not a navigation side effect.
2. Second press within the existing confirmation window asks the daemon to delete that instance.
3. On success, detach its stream, clear its draft and selection, remove its row, and show the blank composer. Do not eagerly create an empty process/row.
4. On failure, preserve the selection and show the daemon error; never display deletion as successful.

A selected managed session is no longer classified as an untouchable external `self`; selection and execution ownership are separate fields. Band deletion includes the selected managed row and follows the same success/error handling. External legacy sessions in other terminals remain protected.

Serialize start/attach/delete operations per session-file identity in the daemon. While deletion is pending, reject new work for that instance. A late exit callback, metadata sync, reconnect, heartbeat, or view refresh must not upsert a removed row. Other viewers receive a deletion terminal event and return to a blank composer. Explicitly resuming the preserved transcript later is a new user action, not automatic resurrection.

### 6. Startup, migration, and failures

- Existing daemon-owned live sessions on a compatible daemon: attach directly; retain PID and work. A daemon started before `view_stream` support cannot gain that protocol while running. Report the upgrade limitation and let its sessions finish before restarting it; never kill them automatically to enable the new UI.
- Saved idle native sessions: release the native writer while idle, start one daemon child, attach without a continuation prompt.
- A native legacy session already working when managed mode is requested: do not abort or start a competing writer. Let that operation settle once before ownership migration, with a visible explanation. This is a compatibility boundary, not the ordinary new switching behavior.
- A native session actively held in another terminal: do not reuse the old aborting takeover path. Report that it must finish/be released safely there before managed ownership can begin.
- Reload: dispose viewer resources idempotently; keep child execution alive; reattach using the saved selected identity. No continuation prompt.
- Terminal exit: close viewer sockets/timers and leave managed children running. Legacy exit hand-off remains isolated to conversations not yet managed.
- Daemon unavailable or incompatible: show a retryable error and preserve the unsent draft. Never silently fall back to local execution or restart a daemon that owns live work.
- Connection lost while a prompt acknowledgement is uncertain: do not automatically resend; explain the uncertain delivery and recover state on reconnect. Avoid duplicate model work.
- Unexpected child exit or daemon crash: show a terminal error/stopped state. Reopening stored history may start a replacement child, but never automatically reissues a prompt or claims the original tool survived.

## Scope and likely files

Keep boundaries small: view-stream transport, display reducer, terminal session controller, conversation screen, and command/UI routing. Existing Agent View roster/filter/clipboard preferences remain shared functionality.

Expected integration surfaces: `ext/agent-view/index.ts`, `agent-view.ts`, `rows.ts`, `orchestrator-client.ts`, and new focused modules under that directory; `daemon/supervisor.ts`, `handler.ts`, `ipc/protocol.ts`, `ipc/server.ts`, and a display projection module; regression tests and README/help updates.

Do not modify Pi sources or package dependencies to expose private internals. Do not introduce worktrees for user conversations, new permissions behavior, permanent session-file deletion, or speculative process recovery. Old aborted transcript entries are historical facts and are not rewritten or hidden.

## Verification

Write failing tests before implementation for:

1. Switching repeatedly during text streaming and during a gated long-running tool: same PID/instance/turn, one tool execution, no lifecycle commands or continuation messages from navigation.
2. Mid-message/mid-tool attach and reconnect: complete prior partial output, ordered new output, no duplicated finalized messages, stale generations ignored.
3. Detach/terminal exit while work, follow-ups, retries, compaction, or a dialog are pending: child keeps running and the correct state is recovered.
4. Prompt and image submission, queued replies, explicit stop, negative command acknowledgements, uncertain delivery, and dialogs answered while another command is pending.
5. First/second Ctrl+X on the selected working and idle rows; bulk deletion including selection; deletion failures; no resurrection from late callbacks/reconnects; other sessions unaffected; `.jsonl` retained.
6. One writer per session file under concurrent start/attach/delete and multiple viewers.
7. Safe bootstrap/legacy migration, no placeholder row, no recursive RPC-child viewer startup, package-install and `bin.mjs` entry paths, and stale-daemon refusal.
8. Command routing cannot operate on the placeholder; unsupported custom TUI commands report their limitation.
9. Narrow widths, Unicode/ANSI text, resizing, focus, theme invalidation, multiline drafts and image paste.

Run targeted tests, the full Vitest suite, `npm run typecheck`, and lint checks. Run a real terminal smoke test against the installed Pi as well as the repository development dependency because their versions differ. Use a deterministic fake RPC child for lifecycle/PID assertions so verification does not require provider credentials or billable model calls. Real API/model testing is optional additional evidence, not a substitute for the lifecycle regression tests.

## Review boundary

The next step is user review of this specification, especially the new daemon-backed conversation screen, saved-transcript deletion semantics, and RPC/custom-TUI compatibility limits. After approval, write the implementation plan and ask the user to select its execution method. No product-code changes are authorized by this document alone.
