# Remote control from a phone: phase 1

Control bluclawd's agent-view sessions from an iPhone, as Claude Code's Remote Control does,
with a PWA served by bluclawd's own daemon. No App Store, no Apple developer account, no
third-party relay.

## Context

- The App Store app "Pi Relay" pairs with `zerray/pi-remote-control` (MIT): a separate daemon,
  per-session `/remote-control`, LAN/Tailscale, and a central APNs push gateway. It cannot start
  sessions. It is the feature reference, not a dependency; nothing is copied from it.
- `jmcombs/pi-extensions`' `pi-relay` is unrelated (a model-provider bridge to `claude -p` etc.).
- bluclawd's daemon (`daemon/`) already lists every agent-view session (activity, detail,
  `sessionFile`) and queues `PaneMessage`s (`prompt`, `abort`) that each pane's pi picks up on its
  3s heartbeat (`ext/agent-view/self-registration.ts`). Phase 1 builds on exactly that.

## Phases

Each phase gets its own spec, plan and implementation. This spec covers phase 1 only.

1. **Foundation (this spec):** HTTP + SSE listener in the daemon, pairing, session list with
   status, transcript from session JSONL, send a prompt, stop a turn, PWA shell.
2. Live streaming (pane pi forwards message/tool events to the daemon, instant delivery instead of
   the heartbeat) and starting a session from the phone (the daemon spawns a tmux pane; resume a
   stored row).
3. Push notifications: Web Push (adds the `web-push` dependency; needs the HTTPS origin and an
   installed PWA) when a session finishes or needs input.
4. Pi Relay parity: `/compact` (`ctx.compact`), model switch (`pi.setModel`), runtime status
   (model, tokens, cost, context), tree / fork / clone (`navigateTree`, `fork`), transcript
   pagination, answering a session's open dialog.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| App | PWA (Add to Home Screen) | No App Store or paid account; free sideloading expires every 7 days and has no push |
| Server | New module inside the existing daemon | One process and one session registry; reuses `list` and `send` |
| Network | Bind `127.0.0.1` only; reach it through `tailscale serve` (HTTPS) | Never exposed on the LAN or the internet; HTTPS is required for the service worker and, in phase 3, Web Push |
| Visibility | Every agent-view session, once remote control is on (global switch) | Required for starting sessions from the phone in phase 2; matches Claude Code's server mode |
| Server → phone | SSE (Server-Sent Events) | No `ws` dependency; iOS Safari supports EventSource |
| Storage | JSON file, not SQLite | A handful of device records |
| Dependencies | None in phase 1 | bluclawd has no runtime dependencies |
| PWA code | Vanilla JS ES modules with `// @ts-check`, no build step, no framework | Served as static files; checked by `tsc` through a separate `daemon/remote/web/tsconfig.json` (`checkJs`, DOM lib) added to `npm run typecheck`, so Node code gets no DOM types |
| Navigation | Session list → chat (Messages-style) | Several running sessions are visible at a glance |
| Visual style | Hybrid: iOS chrome (SF font, native navigation, round composer), monospace Claude Code–style tool calls (`Bash(…)` ⎿), bluclawd mascot cyan `#00c0e8` accent, `✻` working line with the session's `detail` | Readable prose with bluclawd's identity; light and dark follow the phone, using the `bluclawd` / `bluclawd-light` palettes |

## Architecture

```
iPhone PWA ──HTTPS── tailscale serve ──HTTP── daemon/remote/ (127.0.0.1:7878)
                                                 │ direct calls
                                                 ▼
                                    daemon supervisor (registry, send queue)
                                                 ▲ Unix socket, 3s heartbeat
                                    pi in each tmux pane (ext/agent-view)
                                    ext/remote: /remote-control
```

### Units

- `daemon/remote/http.ts`: `node:http` server, router, bearer auth, body limits, static files.
  Started and stopped by the daemon according to the persisted on/off state.
- `daemon/remote/pairing.ts`: pairing codes, device tokens, `remote.json` read and write.
- `daemon/remote/transcript.ts`: session JSONL → `RemoteMessage[]`. Pure function over file text.
- `daemon/remote/events.ts`: SSE client set, registry-change and JSONL-growth signals.
- `daemon/remote/web/`: `index.html`, `manifest.webmanifest`, `sw.js` (offline shell cache
  only), `app.js` and its modules, `style.css`, icons.
- `ext/remote/index.ts`: the `/remote-control` command. It talks to the daemon over the existing
  Unix socket through one new IPC request, `remote`, whose `action` is `status`, `on`, `off`,
  `pair`, `devices` or `revoke`. Added to `package.json`'s `pi.extensions` and to `/help`.

`daemon/remote/` calls the supervisor and handler functions directly; it does not go through the
socket.

## Pairing and security

1. `/remote-control` (any pi session) is a toggle: when off, it turns remote control on and
   shows:
   - the HTTPS URL, read from `tailscale status --json` (`Self.DNSName`, trailing dot
     stripped). If `tailscale serve`
     does not already proxy the port, it offers to run `tailscale serve --bg <port>`. If
     Tailscale is missing, it says so and shows `http://127.0.0.1:<port>` for local testing;
   - a 6-digit pairing code, valid for 5 minutes, single use.
   When on, `/remote-control` turns it off. `/remote-control pair` shows the URL and a fresh
   code while it stays on (pairing another device); `/remote-control devices` lists the paired
   devices and revokes one.
2. On the iPhone: open the URL in Safari, Share → Add to Home Screen, open it from the home
   screen, enter the code. Pairing happens inside the installed app, because a home-screen PWA
   has its own storage, separate from Safari.
3. `POST /api/pair` exchanges the code for a random 32-byte token (base64url). The daemon stores
   only its SHA-256 hash, with the device name, `createdAt` and `lastUsedAt`, in
   `<server dir>/remote.json`, mode 0600, alongside the on/off state and port.
4. Every API request carries `Authorization: Bearer <token>`; the SSE stream takes `?token=`
   because EventSource cannot set headers. Comparison is constant-time on the hash.
5. A code is invalidated after 5 wrong attempts. Without a valid token, everything returns 401
   except the static PWA files and `POST /api/pair`.
6. The listener binds `127.0.0.1` only. The port is `remote.port` from pi settings (default
   7878), read by the extension and passed to the daemon with `remote_set`, which persists it.

Known limits: the daemon runs only once some `pi` has started it (no launchd yet); the phone
cannot reach a sleeping Mac; the transcript's branch is the `parentId` chain from the file's last
entry, not pi's live leaf (phase 4 takes the leaf from the pane); the SSE token travels in the
URL (phase 2 may switch to a cookie set by `POST /api/pair`).

## API

All JSON under `/api`; all require the token except `POST /api/pair`.

| Endpoint | Behaviour |
|---|---|
| `POST /api/pair` `{code, deviceName}` → `{token}` | Exchange a pairing code for a token |
| `GET /api/sessions` | The daemon's `list` as agent view's rows (`collectRows` / `buildBands`), in display order: `id, label, cwd, band, state, alive, detail, createdAt, finishedAt` |
| `GET /api/sessions/:id/messages?limit=50` | Last `limit` messages (max 200) of the active branch |
| `POST /api/sessions/:id/prompt` `{text}` | `send` → `PaneMessage { type: "prompt" }`; the pane delivers it as a follow-up when a turn is running, as an agent-view peek reply does |
| `POST /api/sessions/:id/abort` | `send` → `PaneMessage { type: "abort" }` |
| `GET /api/events?token=` | SSE: `sessions` (registry changed), `messages {sessionId}` (that session's JSONL grew); a comment ping every 25s |

Events carry no content, only "refetch" signals; after any reconnect the phone refetches the list
and the open chat, so a dropped stream never leaves stale state.

### Transcript

`RemoteMessage` is one of:

- `user`: text; images as a placeholder (`[Image]`).
- `assistant`: text, collapsed thinking, tool calls as `{name, summary}` (the summary is the
  call's main argument: command, path or pattern).
- `toolResult`: `{toolName, ok, text}`; text truncated to 2 KB with a `truncated` flag.
- `marker`: `model_change`, `compaction` and similar entries, as a one-line label.

The active branch is the `parentId` chain from the last entry in the file. Lines that do not
parse are skipped (the last line may be half-written). A missing `sessionFile` gives an empty
transcript.

### Change detection

While any phone is connected, `events.ts` polls once a second: the session list's signature
(its JSON) and, for each connected client, the `stat` (size and mtime) of the `sessionFile` of
the session it has open. Any change in the list sends `sessions`; any change in size or mtime
(growth, or a rewrite that shrinks the file) sends `messages`. A poll replaces `fs.watch`: the
registry changes on 3 s heartbeats anyway, and polling needs no per-platform fallback.

## PWA screens

1. **Pair:** six-digit code input, Pair button, a hint to add the app to the home screen first.
   Shown again after a 401 (token revoked).
2. **Sessions:** agent view's bands (Needs input / Working / Idle), its ordering (pinned first,
   then `sortOrder`), one row each: state glyph (`✻` amber, spinner cyan, `∙` gray or red when
   failed), name, `detail` in monospace, age. A `● online` / `offline` indicator. No new-session
   composer in phase 1.
3. **Chat:** back to Sessions, Stop (only while Working). User messages as right-aligned
   bubbles; assistant prose unboxed; thinking collapsed (`▸ Thinking`); tool calls as monospace
   blocks with a cyan left border (red on error), tapping one shows the full result. While
   Working, a spinner line shows the current `detail`. A message just sent shows
   "sent · waiting for the session" until it appears in the transcript.
4. **States:** Needs input shows a banner explaining that the open dialog must be answered on the
   Mac and that a reply becomes the next prompt. Offline (no SSE for 5s) shows "Mac unreachable,
   retrying…".

## Error handling

- Prompt or abort to a session with no process (stored or stopped row): `409 session_not_running`;
  the phone says to open it on the Mac. Resuming from the phone is phase 2.
- Unknown session id: 404. Body over 64 KB or prompt text over 32 KB: 413.
- No path ever comes from the request; transcripts are read only from the registry's
  `sessionFile`.
- Port already in use: `/remote-control` reports it and the daemon keeps running without the
  listener.
- Daemon restart (changed build): the listener comes back from `remote.json`; tokens stay valid.

## Testing

vitest suites in `test/`, self-contained (JSONL fixtures are inline strings, as elsewhere):

- `remote-pairing`: code expiry, single use, 5-attempt limit, only hashes stored, revoke.
- `remote-transcript`: branch via `parentId`, malformed lines, truncation, each message kind.
- `remote-http`: server on a random port with a temporary `PI_SERVER_DIR`; 401 without a token,
  pair → token → sessions → prompt (the `PaneMessage` is queued), abort, 409, 404, 413, static
  files served without a token.
- `remote-events`: SSE gets `messages` when the JSONL grows and `sessions` when the registry
  changes.
- Extension registration test updated for `/remote-control`.

Manual check: daemon with a temporary `PI_SERVER_DIR` exercised with `curl`; then a real iPhone
through `tailscale serve`: pair, send a prompt to an agent-view session, see the reply appear,
stop a running turn.

## Out of scope for phase 1

Token streaming, instant delivery, new or resumed sessions from the phone, push notifications,
answering dialogs, compact, model switch, runtime status, tree / fork / clone, pagination, images
from the phone, launchd auto-start.
