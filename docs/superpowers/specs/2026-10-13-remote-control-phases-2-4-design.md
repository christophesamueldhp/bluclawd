# Remote control from a phone: phases 2–4

Builds on phase 1 (`2026-10-12-remote-control-phase1-design.md`): the daemon's `daemon/remote/`
listener, the PWA in `daemon/remote/web/`, `/remote-control`. Goal: parity with the Pi Relay app,
plus what it lacks (starting sessions from the phone, answering a session's dialog).

The user asked to continue to the end without design check-ins; the decisions below were taken on
that basis and are recorded here so they can be revisited.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Delivery | One branch per unit group, merged into `main` locally when green; never pushed without asking | The user's pi loads bluclawd from its GitHub clone, so `main` here is a checkpoint, not a release |
| New dependencies | None | AGENTS.md asks before adding one; Web Push is written on `node:crypto` |
| Pane ↔ remote | agent view keeps owning the heartbeat; it hands remote-only pane messages and the "a phone is watching" flag to `ext/remote` over pi's event bus (`pi.events`) | One registration per pane; `ext/remote` stays the only remote-specific code in the pi process |
| Session-tree actions | `ext/remote` dispatches `/remote-control <action> …` to itself (`pi.sendUserMessage(…, { expandPromptTemplates: true })`, as agent view dispatches `/agent-view`) | `fork` and `navigateTree` exist only on a command's context; a subcommand adds no visible command |
| Answering a dialog | The daemon captures the pane's screen (`tmux capture-pane`) and sends keys (`tmux send-keys`) | pi has no API to answer another extension's `ctx.ui.*` dialog; `ui_prompt_start` carries only kind and title |
| Streaming | A throttled snapshot (≥ 300 ms) of the message being streamed, sent only while a phone watches that session | `message_update` fires per token and the IPC is one connection per request |
| Push | Web Push (VAPID + RFC 8291 `aes128gcm`), keys made by the daemon, one subscription per paired device | Works on iOS 16.4+ for an installed PWA with no Apple account; payloads are end-to-end encrypted, so Apple's push service relays them without reading them |

## Units

### U1. Start and resume sessions from the phone

- The pane's heartbeat (`RegisterRequest.instance`) gains `launch: { command: string[] }`
  (`piCommand()`) and `leafId` (`ctx.sessionManager.getLeafId()`). The daemon keeps the latest
  `launch` in `remote.json`, so it can start panes after a restart with no pane alive.
- `POST /api/sessions` `{ cwd, task, model? }`: `cwd` must be an existing absolute directory
  (400 `invalid_cwd`), `task` non-empty and ≤ 32 KB, `model` `provider/id` if given. The daemon
  starts a pane with `Tmux.newSession({ cwd, command: launch.command, args: [--model …, "--", task] })`
  — the same argv agent view's composer builds. 503 `no_launch` before any pane has registered.
  201 `{ pane }`; the row appears when the pane registers.
- `POST /api/sessions/:id/prompt` on a stored row with a `sessionFile` (no process): resume it as
  agent view's peek reply does: start `["--session", file, "--", text]` in its `cwd` and delete
  the stored row. 202. Replaces phase 1's 409 for that case.
- `GET /api/directories`: distinct `cwd`s of listed sessions, most recent first, for the phone's
  directory picker.
- Transcript: when the registry has a `leafId` for the session, the branch is that entry's
  `parentId` chain instead of the file's last entry.
- PWA: the Sessions screen gets agent view's composer at the bottom ("New task…") with a
  directory picker (recent directories + free text); a stored session's composer is enabled and
  says "Reply resumes it".

### U2. Live streaming

- The register response gains `watched: boolean`: a phone has this session open on its event
  stream. Agent view emits it on the bus each heartbeat.
- While watched, `ext/remote` keeps a snapshot of the assistant message in flight from
  `message_update` (text, thinking, tool calls) and tools running from
  `tool_execution_start/end`, and sends it with a new IPC request `remote_live
  { instanceId, live | null }` at most every 300 ms, and `null` at `message_end`/`agent_end`.
- The daemon keeps the latest snapshot per instance and pushes it on the authenticated SSE
  stream as `event: live` with the snapshot as data. The PWA renders it below the transcript and
  drops it when the next `messages` fetch shows the finished message.

### U3. Push notifications

- VAPID key pair (P-256) made on first use, kept in `remote.json`. `GET /api/push/key` → the
  public key and `subscribed` (whether the calling device has a subscription). `POST /api/push/subscribe` `{ endpoint, keys: { p256dh, auth } }` stores the
  subscription on the calling device (replacing its previous one), only if the endpoint is https on
  `web.push.apple.com`, `fcm.googleapis.com`, `updates.push.services.mozilla.com` or
  `*.notify.windows.com` and `p256dh` is a P-256 point (else `invalid_subscription`); `POST /api/push/unsubscribe`.
  Revoking a device drops its subscription.
- `daemon/remote/webpush.ts`: VAPID JWT (ES256, `aud` = endpoint origin, `exp` ≤ 12 h,
  `sub` = `mailto:` from settings or `https://github.com/christophesamueldhp/bluclawd`) and RFC
  8291 payload encryption; `fetch` POST with `TTL: 3600`, `Urgency: high`. A 404/410 drops the
  subscription.
- `daemon/remote/notifier.ts`: every second while subscriptions exist, compares each session's
  row state with the last seen one; a session leaving Working for Needs input, Done or Failed
  notifies once (title: session label; body: "Needs input" / "Done" / "Failed" and the detail).
  A session seen for the first time does not notify.
- PWA: "Enable notifications" in the Sessions header when `Notification.permission` is not
  granted, shown only in the installed app; the tap asks permission and subscribes
  (`userVisibleOnly: true`). The service worker always shows a notification on `push`; a tap
  opens `/#s/<id>`.

### U4. Model, status, compact

- `ext/remote` sends `remote_report { instanceId, report }` at session start and on
  `model_select`, `thinking_level_select` and `turn_end`: current model (`provider/id`, name),
  available models (`ctx.modelRegistry.getAvailable()`, provider/id/name only), thinking level,
  context usage (`ctx.getContextUsage()`), and session tokens/cost.
- `GET /api/sessions/:id/status` → the latest report. `POST …/model` `{ provider, id }` and
  `POST …/compact` queue pane messages `set_model` (via `pi.setModel`) and `compact`
  (`ctx.compact()`); 409 `session_busy` for compact while Working.
- PWA: a session's header opens a sheet with the model (picker), thinking level, context usage,
  tokens and cost, and Compact.

### U5. Tree, fork, clone

- `POST …/tree` `{ entryId }`, `POST …/fork` `{ entryId }`, `POST …/clone`: pane messages
  `tree` / `fork` / `clone`, which `ext/remote` runs by dispatching `/remote-control tree <id>`,
  `/remote-control fork <id>` and `/remote-control clone` to itself; the command handler calls
  `navigateTree`, `fork(id, { position: "before" })` and `fork(leafId, { position: "at" })`.
  409 `session_busy` while Working. Fork and clone replace the pane's session; its row follows
  on the next heartbeat (same pane id, new `sessionFile`).
- PWA: a long press on one of your messages offers "Edit from here" (fork before it, the text
  returns to the composer), "Go back to here" (tree) and, in the header sheet, "Clone session".

### U6. Answer a dialog from the phone

- `GET /api/sessions/:id/screen` → the pane's last 60 lines (`Tmux.capture`), ANSI stripped.
  `POST …/keys` `{ keys: ("Up"|"Down"|"Left"|"Right"|"Enter"|"Escape"|"Tab"|"Space"|"BSpace")[] }`
  or `{ text }` (≤ 1 KB, sent literally with `send-keys -l`). Only for a running pane; 404
  otherwise.
- PWA: while a session is Needs input, its banner opens a terminal sheet (monospace capture,
  refreshed after each key and every 2 s) with ↑ ↓ ← → ⏎ Esc Tab and a text field.

### U7. Instant delivery and pagination

- New IPC request `wait { instanceId }`: answered when a message is queued for that pane, or
  after 25 s with none; settled at shutdown. `SelfRegistration` runs one wait at a time next to
  its heartbeat and handles what it returns as it handles heartbeat messages. A prompt from the
  phone then reaches its pane at once.
- `GET …/messages?before=<entryId>&limit=` returns the messages before that entry; the PWA loads
  older ones when scrolled to the top.

## Error handling

New codes: `invalid_cwd`, `no_launch` (503), `session_busy` (409). The PWA
maps each to a sentence. A pane message the pane does not understand (an older pane) is ignored
by it; the phone sees no change rather than an error.

## Testing

Each unit adds vitest suites in `test/` (inline fixtures, temp `PI_SERVER_DIR`, port 0): the
HTTP routes and their errors; pane-side handlers with a fake `pi`/`ctx` (throttle and clear with
fake timers); `webpush.ts` by decrypting its output with a receiver-side RFC 8291 implementation
in the test; the notifier's transitions; the tmux screen and keys commands against a fake `run`.
Every PWA change gets a browser check at 390×844 in light and dark with a demo server.

## Out of scope

An app icon, launchd auto-start, images from the phone, more than one Mac.

## Deviations from this design

- U1: a phone resume keeps the stored row until the pane the daemon started registers, then
  deletes it (the live twin is shown meanwhile, and another reply to the stored row is 409
  `session_busy`). A pane the daemon started from the phone that has not registered within 90 s
  is ended; a resumed one's stored row stays. A launch whose node or script is gone answers 503
  `no_launch`. The latest launch is kept in memory, and in `remote.json` only while remote
  control is on.
- U3: "Enable notifications" is offered while the device has no subscription, not only while
  permission is not granted (a re-paired phone keeps its permission but not its subscription).
- U4/U5: compact, tree, fork and clone are refused while Needs input too, not only while Working,
  and with 409 `pane_too_old` for a pane that sends no report (an older bluclawd), as is a model
  switch. A compact goes alone in its heartbeat, as a navigation does; a compact the pane skips or
  pi rejects reports again, and every report is signalled to the phone, unchanged ones too.
- U5: a ⋯ button on each message, not a long press, with "Edit in a new session" (fork),
  "Edit here" (tree to your message) and "Go back to here" (tree to a reply). A fork or clone is
  skipped while the pane's editor holds a draft, which pi's fork would replace.
- U6: one key per request (`keys` holds a single key), so Escape and the key after it never
  reach pi as one Alt chord.
- U7: `wait` only wakes the pane; its next register drains the messages, as a heartbeat does.
