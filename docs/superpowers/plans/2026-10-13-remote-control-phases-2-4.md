# Remote Control Phases 2–4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Each unit is one implementer dispatch, then a review; steps use `- [ ]`.

**Goal:** Parity with Pi Relay plus starting/resuming sessions and answering dialogs from the phone (spec: `docs/superpowers/specs/2026-10-13-remote-control-phases-2-4-design.md`).

**Architecture:** Extends phase 1's `daemon/remote/` (HTTP + SSE), `daemon/remote/web/` (PWA), `ext/remote/` (`/remote-control`), the daemon IPC (`daemon/ipc/protocol.ts`, `daemon/handler.ts`), and agent view's pane registration (`ext/agent-view/index.ts`, `self-registration.ts`, `orchestrator-client.ts`). Pane-side remote work lives in `ext/remote/`, fed by agent view over `pi.events`.

**Tech stack:** TypeScript on Node 26 (type stripping), `node:http`, `node:crypto`, tmux, vitest, vanilla JS PWA. No new dependencies.

**Conventions (all units):** tabs, biome (width 120), `import type`, no TS parameter properties (`erasableSyntaxOnly`), comments only for a non-obvious why, tests self-contained with inline fixtures, temp `PI_SERVER_DIR` and port 0, never touch `~/.pi/server`, the user's daemon or Tailscale config. TDD: failing test first. Gates per unit: `npm run typecheck`, `npm run lint`, `npm test`. Commit trailer:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MMRiYiQNxkutoa9PBreWNt
```

Shared names (keep exactly):

```ts
// daemon/ipc/protocol.ts additions
export type PaneMessage =
	| { type: "prompt"; text: string }
	| { type: "abort" }
	| { type: "rename"; name: string }
	| { type: "compact" }
	| { type: "set_model"; provider: string; id: string }
	| { type: "tree"; entryId: string }
	| { type: "fork"; entryId: string }
	| { type: "clone" };
// RegisterRequest.instance gains: leafId?: string; launch?: { command: string[] }
// RegisterResponse gains: watched?: boolean
// New requests: RemoteLiveRequest { type: "remote_live"; instanceId: string; live: LiveSnapshot | null }
//               RemoteReportRequest { type: "remote_report"; instanceId: string; report: PaneReport }
//               WaitRequest { type: "wait"; instanceId: string }  → RegisterResponse-like { type: "wait_result", messages? }
export interface LiveSnapshot { text: string; thinking?: string; tools: Array<{ id: string; name: string; summary: string; running: boolean }> }
export interface PaneReport {
	model?: { provider: string; id: string; name?: string };
	models: Array<{ provider: string; id: string; name?: string }>;
	thinkingLevel?: string;
	context?: { tokens: number | null; contextWindow: number; percent: number | null };
	usage?: { input: number; output: number; cost: number };
}
```

The pi-side mirror types in `ext/agent-view/orchestrator-client.ts` must match.

Bus channels (pi.events): `"bluclawd:pane-message"` (data: a PaneMessage agent view does not handle itself), `"bluclawd:remote-watched"` (data: boolean, emitted after every heartbeat).

---

### Unit 1: start and resume sessions (spec U1)

- [ ] Protocol: `leafId`, `launch` on `RegisterRequest.instance`; mirror in orchestrator-client `RegisterInput`; `InstanceRecord`/`InstanceSummary` carry `leafId` (not `launch`).
- [ ] Agent view: `selfInfo(ctx)` adds `leafId: ctx.sessionManager.getLeafId() ?? undefined`; `SelfRegistration.beat()` passes `leafId` and `launch: { command: piCommand() }` (import from `tmux.ts`). Test in `test/agent-view-self-registration.test.ts`: the register input carries both.
- [ ] Daemon: `handler.ts` register case stores `leafId` on the record and hands `launch` to `RemoteControl.noteLaunch(launch)` (via a setter like `setRemoteControl`, no import cycle), which persists it in `remote.json` (`RemoteState.launch?: { command: string[] }`) only when it changed.
- [ ] `daemon/remote/spawn.ts`: `startSession({ cwd, task?, model?, sessionFile?, launch, tmux })` → pane name. Builds args exactly as agent view: new → `[...(model ? ["--model", model] : []), "--", task]`; resume → `["--session", sessionFile, "--", text]`. Uses `new Tmux()` from `ext/agent-view/tmux.ts` (injectable for tests: pass a `Tmux` built with a fake `run`). Test: argv for new, new+model, resume; tmux failure surfaces as an error.
- [ ] HTTP (`http.ts`, deps gain `startSession`, `deleteInstance`, `launch()`):
  - `POST /api/sessions` `{ cwd, task, model? }` → 400 `invalid_cwd` (not absolute / not a directory via `statSync`), 400 `empty_prompt`, 413 `prompt_too_large`, 400 `invalid_model` (not `provider/id`), 503 `no_launch`, else 201 `{ pane }`.
  - `POST /api/sessions/:id/prompt` on a stored row (not running) with a `sessionFile` → resume + `deleteInstance(id)` → 202; without a file → 409 `session_not_running` as before.
  - `GET /api/directories` → `{ directories: string[] }` distinct cwds by most recent `createdAt`.
  - Tests in `test/remote-http.test.ts` for each.
- [ ] Transcript: `loadTranscript(file, limit, leafId?)`; `activeBranch(entries, leafId?)` starts from `leafId` when it exists in the file. `findSession` returns `leafId`. Tests.
- [ ] PWA: Sessions screen composer (textarea "New task…", directory `<select>` of `/api/directories` + "Other…" text input, Start button) → `POST /api/sessions`, then show "Starting…" until the list has a new row; stored session composer enabled with placeholder "Reply resumes it"; map new error codes in `ERRORS`. Browser check by the controller.
- [ ] Gates; commit `feat(remote): start and resume sessions from the phone`.

### Unit 2: live streaming (spec U2)

- [ ] Daemon: `RemoteControl` (or a small `daemon/remote/live.ts` store) keeps `Map<instanceId, LiveSnapshot>`; IPC `remote_live` sets/clears it; `watched(id)` = an SSE client has `session=id` (expose `RemoteEvents.watching(): Set<string>`); register response sets `watched`. SSE: when a watched session's snapshot changes, send `event: live` with `{ sessionId, live }` (content allowed on this authenticated stream); clear on unregister. Tests: http SSE receives `live`; register response `watched` true only while a stream with that session is open.
- [ ] Agent view: after each heartbeat, `pi.events.emit("bluclawd:remote-watched", res.watched === true)` (SelfRegistration gets an `onWatched` callback). For PaneMessage types it does not handle (`compact`, `set_model`, `tree`, `fork`, `clone`), `pi.events.emit("bluclawd:pane-message", message)`.
- [ ] `ext/remote/live.ts`: `LiveForwarder` (pure, injectable clock/sender): `onMessageUpdate(message)`, `onToolStart(id,name,args)`, `onToolEnd(id)`, `onMessageEnd()`, `setWatched(bool)`; sends at most every 300 ms while watched, sends `null` on end or when unwatched. Uses `toolSummary` logic (import from `daemon/remote/transcript.ts`). Tests with fake timers.
- [ ] `ext/remote/index.ts` wires `pi.on("message_update" | "tool_execution_start" | "tool_execution_end" | "message_end" | "agent_end")` and the bus to a `LiveForwarder` whose sender is `client.remoteLive(paneId, live)`; pane id = `Tmux.currentPane()`; no-op without one. Registration test event count updated.
- [ ] PWA: on `live`, render the snapshot after the transcript (assistant text, collapsed thinking, tool blocks with a spinner when running); clear when a `messages` fetch lands. Browser check.
- [ ] Gates; commit `feat(remote): stream the reply in progress to the phone`.

### Unit 3: push notifications (spec U3)

- [ ] `daemon/remote/webpush.ts`: `generateVapidKeys()`, `vapidAuthorization(endpoint, keys, subject, now)` (ES256 JWT, raw r||s signature via `dsaEncoding: "ieee-p1363"`), `encryptPayload(plaintext, p256dh, auth)` per RFC 8291 (aes128gcm, record size 4096, single record, padding delimiter 0x02), `sendPush(subscription, payload, keys, subject, fetchImpl)` → `"ok" | "gone" | "error"`. Test: decrypt with a receiver-side implementation written in the test (ECDH with the receiver private key, HKDF per RFC 8291), JWT header/claims and signature verify with the public key.
- [ ] `RemoteStore`: `vapid` keys, per-device `push?: { endpoint, keys: { p256dh, auth } }`; `setPush(deviceId, sub | undefined)`; revoke drops it. `authenticate` returns the device (already).
- [ ] HTTP: `GET /api/push/key` → `{ publicKey }` (base64url, uncompressed point); `POST /api/push/subscribe`, `POST /api/push/unsubscribe` (device from the token). Tests.
- [ ] `daemon/remote/notifier.ts`: `Notifier.observe(sessions: RemoteSession[])` → notifications for transitions from `working` to `needs`/`done`/`failed`/`idle`(as Done); first sight never notifies; one per transition. `RemoteControl` runs it every second while any device has a subscription, sending to all subscribed devices; payload JSON `{ title, body, sessionId }`; `gone` drops the subscription. Tests for the transitions.
- [ ] PWA: "Enable notifications" button (installed app only, permission not granted), `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`, POST it; `sw.js` `push` → `showNotification(title, { body, data: { sessionId }, tag: sessionId })`, `notificationclick` → focus/open `/#s/<id>`. Browser check (push itself cannot be tested headless; check the button and subscription call path with a stubbed `pushManager` if needed).
- [ ] Gates; commit `feat(remote): push notifications when a session finishes or needs you`.

### Unit 4: model, status, compact (spec U4)

- [ ] `ext/remote/report.ts`: `buildReport(ctx)` → `PaneReport` (models deduped, sorted by provider/name; usage from `ext/_shared/session-usage.ts` if it exposes totals, else summed from session entries' assistant `usage`). Sent with `remote_report` on `session_start`, `model_select`, `thinking_level_select`, `turn_end`. Tests with a fake ctx.
- [ ] Bus handler in `ext/remote`: `set_model` → `ctx.modelRegistry.find(provider, id)` then `pi.setModel(model)`; `compact` → `ctx.compact()`.
- [ ] Daemon stores the report per instance; `GET /api/sessions/:id/status` → `{ report }` (404 none yet); `POST …/model` `{ provider, id }` (400 `invalid_model`), `POST …/compact` (409 `session_busy` while working); both 409 `session_not_running` for stored rows. Tests.
- [ ] PWA: tap the title → status sheet: model `<select>` (from report.models), thinking level, context bar, tokens/cost, Compact button. Browser check.
- [ ] Gates; commit `feat(remote): model, status and compact from the phone`.

### Unit 5: tree, fork, clone (spec U5)

- [ ] `/remote-control` handler: subcommands `tree <entryId>`, `fork <entryId>`, `clone` (internal; usage line unchanged); they call `ctx.navigateTree(id)`, `ctx.fork(id, { position: "before" })`, `ctx.fork(leafId, { position: "at" })`. Bus handler dispatches them with `pi.sendUserMessage("/remote-control …", { expandPromptTemplates: true })` only when `ctx.isIdle()`.
- [ ] Verify (and record in the commit message) that a dispatched command does not land in the JSONL as a user message, by a test against the probe harness or by reading pi's dispatch code in `node_modules/@earendil-works/pi-coding-agent/dist`.
- [ ] HTTP `POST …/tree` `{ entryId }`, `POST …/fork` `{ entryId }`, `POST …/clone`: 409 `session_busy` while working, 409 `session_not_running` stored, 400 `invalid_entry` when `entryId` is not in the active branch. Tests.
- [ ] PWA: long press (or a "⋯" on each user bubble) → "Edit from here" (fork before; put its text into the composer), "Go back to here" (tree); status sheet "Clone session". Browser check.
- [ ] Gates; commit `feat(remote): edit from a message, go back, clone, from the phone`.

### Unit 6: answer a dialog (spec U6)

- [ ] `Tmux` gains `sendKeys(name, keys: string[])` and `sendText(name, text)` (`send-keys -t =name: -l -- text`). Test against a fake `run` (argv).
- [ ] HTTP `GET …/screen` → `{ lines }` (capture 60, ANSI stripped via `ext/_shared/ansi.ts`), `POST …/keys` `{ keys }` (allowlist `Up Down Left Right Enter Escape Tab Space BSpace`) or `{ text }` (≤ 1024). Only for a running row with a `pane`; 404 otherwise. Tests with an injected tmux.
- [ ] PWA: Needs-input banner gets "Answer"; opens a terminal sheet (monospace, the capture), key buttons, text field + Send, refresh after each action and every 2 s while open. Browser check.
- [ ] Gates; commit `feat(remote): answer a session's dialog from the phone`.

### Unit 7: instant delivery, pagination (spec U7)

- [ ] Supervisor: `waitExternal(id, timeoutMs)` → Promise<PaneMessage[]>, resolved by `sendExternal` (drain) or timer; `settleWaits()` at shutdown. IPC `wait`. Tests (fake timers).
- [ ] `SelfRegistration`: a wait loop (one in flight; request timeout 30 s; on error back off 3 s); messages go to `onMessage`. The heartbeat keeps draining too (both paths drain, so no duplicate delivery). Tests.
- [ ] Transcript `before` cursor; HTTP `?before=`; PWA loads older messages at scroll top (keeps scroll position). Tests + browser check.
- [ ] README: update the Remote control section (what the phone can do now; what it still cannot). Gates; commit `feat(remote): instant delivery and older messages`.

### Final

- [ ] Whole-branch review; fix; merge into `main` locally; full gates on `main`.
