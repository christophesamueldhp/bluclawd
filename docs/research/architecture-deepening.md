# Architecture deepening: validating the 8 candidates

Superseded in part by ADR-0006: runs are now pi sessions of their own, not in-process SDK sessions.

This note checks the 2026-11-04 architecture review (`main @ edaa709`) against the code, the git history, the tests and pi 1.0.4 in `node_modules/@earendil-works/pi-coding-agent`. For each of the review's 8 deepening candidates it gives a verdict, lists the review's errors, and adds the constraints a spec must respect. No source was changed.

Conventions:
- Lines are cited at `edaa709`.
- "Fix commits" are non-merge commits whose subject starts with `fix`, counted with one script for every candidate (see Sources).
- _Inference_ marks a conclusion that is not read directly from a source.

## Summary

| # | Candidate | Verdict | Strength after validation | Size | Depends on |
|---|---|---|---|---|---|
| 1 | Supervisor row lifecycle | Confirmed with corrections | Strong | L | none |
| 2 | Prompt outcome journey | Confirmed with corrections | Strong | L | 1 |
| 3 | Pane-side outcomes take pi's events | Confirmed with corrections | Strong | S–M | none (before 8) |
| 4 | Scheduler owns finishing | Confirmed with corrections | Worth doing: structural; the bug history is thin | S | none |
| 5 | Parent-scope views | Confirmed with corrections | Strong | M | 4 |
| 6 | Addressing a Run | Weakened | Worth doing, narrower than proposed | S–M | 4 (serial with 5) |
| 7 | Agent view row actions | Confirmed with corrections | Worth exploring | M–L | 1 (daemon half) |
| 8 | One pane report across IPC | Confirmed with corrections | Speculative: worth doing for shapes, not for timing | M | 1, 3 |

---

## 1. One row lifecycle in the supervisor

**Corrections**
- The review counts 58 commits to `supervisor.ts`. That figure includes 5 merges: there are 53 non-merge commits, and 28 of them are fixes.
- The 5 lookup helpers exist (`storedRowFor` :255, `paneListedAs` :261, `paneOf` :267, `listedPane` :275, `rowIdOf` :280). The same lookup is also written inline 5 more times: `claimStart` :218-221, `paneEnded` :415, `saveInstance` :490, `deleteInstance` :550, `listInstances` :454.
- Listing is not the only place that reaps. `RemoteControl.report()` calls `listInstances` (`control.ts:166`), so every pane report reaps too.

**Problem (confirmed)**
- The six maps the review lists hold row state (`supervisor.ts:87-107`), as do storage and `ExternalInstance.rowId`.
- `listExternalInstances()` (:373-409) mutates while it lists. It ends silent panes whose tmux is gone, and it reaps panes past their TTL. A reaped pane is either stopped, which writes storage and fires `onDropped`, or made silent, which fires `onSilent`.
- `starting()` (:202-208) deletes expired starts.
- Because listing reaps, callers must list in a fixed order: `handler.ts:87` reads `// Panes first: one reaped here shows its stored row again.`
- Fix commits touching `supervisor.ts` and `handler.ts` together: 8 (e759e09 336dc90 de3632e b30b64a c8b84f9 1c9fc85 94d1205 d7a6744).
- Six of the last eight `fix(remote)` commits touch `supervisor.ts` (confirmed).
- Every cited commit exists and touches the files claimed.

**The "may a Chat act" verdict (bca7a16)**
- bca7a16 changed only web files: `actable()` at `list.js:66-68` and the fallback at `app.js:2309`. The divergence it worked around sits in the daemon:
  - `remoteSessions` lists a silent row with `running: pane !== undefined` (`sessions.ts:91`).
  - Phone control therefore admits a message to it (`phone-control.ts:137`).
  - `sendExternal` → `paneOf` excludes silent panes (`supervisor.ts:318-323`), so http.ts answers 409 `session_not_running`.
- The verdict belongs in the listed row, computed from the row's state. `actable` and the app.js fallback then go away.

**Hidden constraints**
- **No timers today.** Reaping happens only when something lists (`RegistryDeps {now, tmux, dir}`, :72-78). A "time passes" transition needs either an explicit `tick(now)` driven by the daemon or reaping inside every read.
  - With remote off and agent view closed, `onDropped` and `onSilent` never fire today. Moving reaping to a timer changes when prompts settle as lost, which matters for candidate 2.
- **tmux unknown.** When tmux cannot answer, the pane is dropped, not silenced (:398). That is a third outcome, beside "up" and "gone".
- **GLOSSARY, Silent pane.** A silent pane:
  - stays listed, alive;
  - refuses a start on its file (`claimStart`);
  - goes on as its row on a beat;
  - ends when tmux is gone, it unregisters, or it beats on another session.
- **Two roles for a silent pane.** It is still "the row's pane" for `setInstanceMeta` and `deleteInstance` (through `listedPane`), but not for `sendExternal` (through `paneOf`). Pin survival depends on the first: 9b1c9e4, 380023b, 55eb7ae, b30b64a, 1a4b4c0.
- **Storage writes.** `persistRow` writes storage on every changed beat (:168-185), and the row id comes from storage at register (:154).
- **Older panes.** An unregister with no `EndReason` means a pane from an older build (:284-287).

**Tests**
- Existing tests and their fakes:
  - `daemon-external-instances.test.ts`: 18 tests, uses `test/helpers/registry.ts` (`testRegistry`, a `paneUp` fake).
  - `daemon-lifecycle.test.ts`: 38 tests.
  - `remote-sessions.test.ts`: 14 tests.
  - `remote-prompt-outcomes.test.ts`.
- The clock and tmux fakes already exist. They stay valid because the supervisor's interface keeps its shape.
- New: one state × event table at that same interface, which also covers "list in any order".

**Risk.** It sits on the busiest fix path. Pin, delete and order handling across a hand-off must come out unchanged, so land it behind the existing tests first.

## 2. One owner for a Prompt outcome's journey

**Corrections**
- In `control.ts`, `delivered` (:173-175) is a pure pass-through. `dropped` and `silent` (:179-188) also push `server.status(sessionId)`, so they are not pure pass-throughs.
- `control.ts:185` does drop `sessionId` when it calls `delivery.silent(inbox)`. This is harmless, because inbox ids are unique phone ids.
- `PromptDelivery.sessionId` is really the row id (`delivery.ts:15,29`).

**Problem (confirmed)**
- Verdicts are decided in three places:
  - **Pane:** `outcomes.ts` and `report.ts`.
  - **Daemon:** `delivery.ts:38-111`, including `pane_gone` versus `session_changed` (`endedForAnother`).
  - **Phone:** `chat.js`.
- `serve.ts:45-46` wires `supervisor.onDropped/onSilent` to `remote.*`, and `remote-prompt-outcomes.test.ts:64-65` repeats that wiring by hand.
- The inbox sits on the pane entry (`supervisor.ts:40`). It is drained in `handler.ts:198`, and `delivered` is called at :199.
- **The phone mirrors the daemon's retention.** `chat.js:34` `KEEP_MS` equals `delivery.ts:11` `DELIVERY_KEEP_MS`, kept equal only by a test (`remote-web-chat.test.ts:590`, 75a3d2d). `settleSent` infers `lost daemon_restarted` at `chat.js:268-286`, and `protocol.ts:222-223` documents that the phone adds that reason.
- Fix commits touching at least two of delivery/control/serve/supervisor/chat.js: 7. Three of them touch all four daemon files: 0d27daf, 19aa632, e759e09.
- Phone-only fixes: 974cb06, 778368f (both chat.js).

**Hidden constraints**
- **Older builds (GLOSSARY, Prompt outcome).** "A pane from an older build reports none, and the phone guesses for it."
  - Today the phone tells an older pane apart by report shape: a report with no `outcomes` array (`chat.js:175,184`).
  - No report at all says nothing about the build (`chat.js:180-183`).
  - The daemon already knows whether a pane has reported (`hasReport`, `control.ts:190`) and asks for a report (`wantReport`, `handler.ts:205`). It can therefore make the "older build" call itself. The phone must stop guessing only for panes that do report.
- **"Unknown to this daemon" is not "older pane".** A restarted daemon has no record of a phone id. To answer for it, the daemon needs the ids the phone is still waiting on, plus a marker for its own lifetime, so it can say "lost, daemon restarted" itself. _Inference:_ that needs a new request or a new replay field, and an older phone must still work from the plain replay (`events.ts:88-90`).
- **Settle timing.** Timing follows candidate 1's reap timing, so they must change together.
- **The Silent rule.** A silent pane loses its inbox at once, while what pi already holds waits for the pane's report (GLOSSARY). `remote-prompt-outcomes.test.ts` (c63ab0b, 19aa632) tests this.

**Tests**
- Existing: `remote-prompt-outcomes.test.ts`. It is 612 lines with 18 tests; :25-70 sets up a real IPC socket server, `RemoteControl`, `SelfRegistration`, a clock and `tmuxGone`. The file ends with 3 `PromptDelivery` unit tests (:584-611).
- Existing: `remote-web-chat.test.ts`.
- Those unit tests grow into the new module's tests: inbox, take, report, end, silence and unknown, with no socket.
- The KEEP_MS equality test and the phone's inference tests are deleted.

**Risk.** The phone and the pane ship separately from the daemon, so every older combination must keep working. List the combinations in the spec: an older phone with a newer daemon, and an older pane with a newer daemon.

## 3. Pane-side Prompt outcomes take pi's events

**Corrections**
- There are 7 fix commits that touch `index.ts` and `outcomes.ts` together, not 5: the review's 5 plus 491efc6 and 02af608. All 7 of `outcomes.ts`'s 7 fixes are in that list.
- The "heartbeat" is not a pi event. It is bluclawd's own timer (`self-registration.ts:165`, `setInterval(heartbeat, HEARTBEAT_MS)`), and it reaches remote over the bus as `bluclawd:remote-watched` (`agent-view/index.ts:474`, `remote/index.ts:347-354`).
  - It fires even when `register` failed (`self-registration.ts:234-239`), so quiet looks keep counting while the daemon is down.
- "Each case rebuilds a fake pi" applies only to the `phonePane()` cases (`remote-report.test.ts:622-999`). The cases at :1027-1181 use a real `createAgentSession` (`realPane`).
- Command refusals (busy, dialog, draft) are decided in `report.ts:237-263` (`submitCommand`), not in `outcomes.ts`.

**Problem (confirmed)**
- `PromptOutcomes` (`outcomes.ts:46-137`) is pure. `index.ts:240-375` holds the rules that make it work:
  - the compacting flag (:242, :279-288);
  - the refusal, then `sent()` keyed by text joined as pi joins it (:300-308);
  - `quietLooks` with a reset on `settled` (:323-333);
  - `setTimeout(…, 0)` after `input` (:338);
  - `message_start` → `started` (:340);
  - `dequeued(Infinity)` when shutdown is not a quit (:361-369).
- No test drives `PromptOutcomes` on its own.

**pi behaviour the module must keep**
- **`agent_settled` is pi's event** (`extensions/types.d.ts:771`), emitted from a `finally` (`agent-session.js:682-688,1408`).
- **Text is joined.** `sendUserMessage` joins text parts with `"\n"` before `prompt()` (`agent-session.js:1844-1869`), which is why outcomes are keyed by joined text.
- **Manual compaction only.** `prompt()` throws while manual compaction runs (`agent-session.js:1524-1526`, `_compactionAbortController`, :2166). Auto-compaction uses another controller (:2472), so the flag correctly tracks only `reason === "manual"`.
- **The queue fills after the input handlers.** `prompt()` awaits every `input` handler in turn (`runner.js:1202-1235`) and only then queues steer or follow-up (`agent-session.js:1547-1558`). The `setTimeout(0)` look is what waits for that.
- **No queue event for extensions.** pi emits `queue_update` only as an `AgentSession` event (`agent-session.d.ts:56`); it is not in the extension event types. Extensions see only `ctx.hasPendingMessages()` and `ctx.isIdle()` (`types.d.ts:236,244`). So the deferred look moves into the module; it cannot be dropped.
- **Shutdown order.** A switch runs `abort()`, then `session_shutdown` with its reason, then dispose (`agent-session-runtime.js:102-112`). A quit comes through `dispose()` (:297-303).

**Constraints**
- `QUIET_LOOKS` is derived from agent-view's `HEARTBEAT_MS` (`outcomes.ts:14,37`), which ties this candidate to 8.
- `remote-prompt-outcomes.test.ts:18` imports `refusal()` and `remote-report.test.ts:21` imports `QUIET_LOOKS`. Keep both exports, or move those imports.
- No IPC change: the reports keep their shape, so this candidate is pane-only.

**Tests**
- The outcome cases (`remote-report.test.ts:670-999`) become "events in, outcomes out" tests on the module. The `phonePane()` fake (:622-668) already captures the `pi.on` and bus handlers and is the seed for them; no `OrchestratorClient.prototype` spy is needed at the module.
- The `realPane` cases stay as the integration check.

**Risk.** Low. It is in-process, and the change is behind one export.

## 4. The Run lifecycle owns "finishing"

**Corrections**
- There are four status merges, not three: `index.ts:478`, `task-source.ts:41`, `transcript-actions.ts:96`, and `panel.ts:41`, which the review missed.
- There are four separate encodings, not three: `panel.ts:139-140` (the x key) adds one.
- The review cites "Generation fixes in runs.ts landed in one file each" as evidence. It argues that the scheduler is sound, not that finishing is buggy. History is thin here: `directory.ts` has 3 commits and 1 fix (5453bbe), and `generations.ts` has 0 fixes.

**Problem (confirmed)**
- `RunState`, including `"finishing"`, is defined in `directory.ts:10`. It is derived on each read from the record plus `endedTurns` (:35-42).
- `endedTurns` is written only by `endTurn` (:61-64), and nothing ever deletes from it.
- Finishing is cleared implicitly when a resume bumps the generation (`runs.ts:335`).
- `endTurn` emits no change. The scheduler's `emitChange` (`runs.ts:547-553`) fires only on its own transitions, so the panel catches up through its 1 s ticker (`index.ts:355-361`).
- Finishing is awaited through `scheduler.whenFinal` (`runs.ts:204-207`), so the scheduler already owns its end, but not its start.

**Hidden constraints**
- **A latent bug.** `generations.ts:238` marks finishing on any child `agent_end`. pi's `agent_end` carries `willRetry` (`agent-session.d.ts:52`), and `agent_settled` comes later (`agent-session.js:682-704`). A run whose turn will be retried therefore reads as "finishing" (unreachable, not stoppable) while it still works.
  - The runner itself waits for `agent_settled` (`runner.ts:379-381`).
  - The test fake always sends `willRetry: false` (`subagents-directory.test.ts:74-76`).
  - The spec should decide this: key finishing on `agent_settled`, or on `!willRetry`.
- **Per generation.** Finishing belongs to one generation (`directory.ts:40`).
- **The after-last-await rule.** Today `endTurn` runs inside the `agent_end` subscription, a handler with no await, so the standard holds. The scheduler's finishing transition must likewise have no await in front of it. Leaving finishing goes with the terminal record, after `onFinalize`, the last await in `finalizeManagedRun` (`runs.ts:508-527`).

**Tests**
- Existing: `subagents-directory.test.ts`, which has a scripted runner and no TUI (:60-100); its finishing cases are at :253, :277 and :306.
- Existing: `subagents-runs.test.ts` and `subagents-generations.test.ts`.
- The finishing cases move to the scheduler.
- New: a test for `willRetry` or `agent_settled`.

**Risk.** Low.

## 5. One module for the Parent scope's views

**Corrections**
- There are more views than seven. The review's seven are confirmed: `index.ts:138,143,151,168,184,485` and `task-source.ts:69`. The review misses:
  - `runLaunchedBy` (`index.ts:266-271`);
  - the per-turn reminder (:388-400);
  - `findRun` (`task-source.ts:58-64`), which checks the owner but not the epoch;
  - `list` (:84-87);
  - `stopAll` (:106-116).
- The count of `generation ?? 0` (8) is right, but the occurrences are spread over four files, not only the views: `index.ts` ×3, `task-source.ts` ×2, `directory.ts` ×2, `runs.ts` ×1. The cause is the optional `generation?: number` (`runs.ts:43`).
- 5453bbe has four behaviour fixes, not three, and one of them (the shell pill) lands in `background-bash/index.ts`.
- `subagents-waiting.test.ts` does not use `createSubagentTui`. It uses `createParentSessionWithSubagents` (`test/helpers/subagent-session.ts:15`) and its own copy of `gate()` (:263).

**Problem (confirmed)**
- Two dismissal maps, both runId → generation, are kept in `index.ts`:
  - `dismissedFromPanel` (:99);
  - `dismissedFromTasks` (:101), passed to the task source (:252).
- Panel dismiss calls `runsChanged()` (:349-352). `/tasks` dismiss returns `true` with no signal (`task-source.ts:118-123`); its caller only re-renders the dialog (`tasks-dialog.ts:386-389`). The footer and the panel go stale until the next render.
- `panelHasRows` sits on the Task port (`_shared/agent-tasks.ts:58-59`) for the shell pill (`background-bash/index.ts:238,375`).

**Constraints**
- The views use `inParentScope` (session id and epoch only). See candidate 6 for why that is not the branch check.
- The 30 s linger (`panel.ts:14-16`) needs a clock input.
- _Inference_: making `generation` required, with 0 for the launch, removes the 8 defaults. Records stored before the change lack the field and must read as 0. The ledger key `record.generation ? runId#n : runId` (`storage.ts:401`) keeps the same value.

**Tests**
- `subagents-task-source.test.ts` (7 tests, no TUI) is the seed for "records in, lists out" tests.
- The scope, dismiss and Waiting-count cases in `subagents-panel.test.ts` (14 tests, 13 using the TUI) and `subagents-tasks-done.test.ts` move to that interface. Keep a few rendering cases.

**Risk.** Medium. It touches `index.ts`, the file with the most commits in `ext/subagents` (61).

## 6. One module to address a Run

**Corrections (why Weakened)**
- **The three scope predicates are not duplicates.** Each answers a different question:
  - `inParentScope` (`parent-scope.ts:12-14`): the session id and epoch match.
  - `inScope` (:54-63): they match, and the SDK context is still alive.
  - `runInScope` (:74): `inScope`, and the originating entry is on the active branch (GLOSSARY, Parent scope).
- **The after-last-await rule does not hold "only because each caller remembers it".** Admission and the bus enforce it:
  - `admission.resume` checks again after its last await, then commits synchronously (`admission.ts:401-442`).
  - A launch checks scope and branch again after its last await (:316-323).
  - The bus refuses a stale epoch (`messages.ts:194-198`).
- **The post-await check in `transcript-actions.ts:40-42` guards only the note to the orchestrator.** The message or the resume is already committed by then.
- **There is a third sender:** the child's `subagent_message` (`generations.ts:108-120`), which messages a run but never resumes one.
- The refusal lines are `transcript-actions.ts:32-35` and :80-85, not 30-37 and 84-85.

**Problem (what remains)**
- `messageFromParent` (`generations.ts:323`) and `messageFromUser` (:365) both wait out finishing and then re-read the run with an unscoped `directory.get` (:331-335, :372-376).
- The lookups differ. `find` searches open runs, then the latest finished run of the session in any epoch, then disk (`directory.ts:85-108`). `get` looks in memory only, in any scope (:67-70).
- The same condition gets two texts. The parent path's refusal comes from admission (`admission.ts:405-408`); the user path writes its own for cancelled, failed and interrupted runs (`generations.ts:388-393`).
- Only the user path reuses the earlier generation's `executeTool` and `toolCallId`, and calls `launchResultEmitted` (:380-384, :313).

**Constraints**
- **ADR-0005.** The user may message or resume a run. The orchestrator is noted with `steer` and `triggerTurn: false` (`transcript-actions.ts:43-59`). A run the user resumed reports tagged "[Resumed by the user…]" and does wake the orchestrator (`generations.ts:271-274`).
- **ADR-0003.** Delegation is one level deep.

**Tests**
- All 13 tests in `subagents-user-message.test.ts` use `createSubagentTui` (confirmed).
- Two paths have no test: a user message to a finishing run, and a session change while that wait is pending.
- The parent path is covered without a TUI (`subagents-directory.test.ts:277,306`).

**Scope of the fix.** One module owns the lookup, the finishing wait, the refusal text and the choice between a resume and a live message, for the parent and the user. It runs the note's scope check synchronously after its last await. Scope checks keep their three meanings: name which predicate each step uses, rather than merging them.

## 7. Agent view's row actions as their own module

**Corrections**
- **"Drop 30 `*ForTest` hooks".** Production code has 2 hooks, `setInstancesForTest` (`agent-view.ts:1859`) and `selectedKeyForTest` (:1864). The 31 are their call sites in tests: `agent-view.test.ts` 21, `agent-view-panes.test.ts` 9, `agent-view-shell.test.ts` 1.
- **"16 `as unknown as OrchestratorClient` casts".** The count is right, but 9 are in `agent-view-self-registration.test.ts`, which does not test row actions.
- **"17 fixes, none in render\*".** Wrong: 11 of the 17 fix commits change a `render*` or `rowDetail` method, and 4 change only rendering:
  - de3632e (`renderPeek`);
  - 73b119f (`rowDetail`, plus an import);
  - 94d1205 (`renderPeek`);
  - d94a805 (`renderBody`).
  - Each was checked by mapping its hunks to the enclosing method in that commit's file.
- The behaviour fixes do land mostly in the action methods (f6be469, fe2628a, 0ab70d0, b38b42e confirmed).
- **`http.ts:435-469` spans two routes, and the start sequence is written twice.**
  - The resume route (:424-444) claims, spawns, then rolls back. `resumeIn` in agent view does the same (`agent-view.ts:807-815`).
  - The new-session route (:448-470) spawns, then claims. `startPane` does the same (:767-802), with no rollback.
- **The daemon already has a start operation.** `case "start"` and `start_failed` (`handler.ts:267-280`, `StartSpec`, `protocol.ts:135-158`) own the claim half. The missing part is the spawn and the rollback.

**Problem (confirmed)**
- `stopOrDelete` (:915-997) switches over the header and the shell, self, starting and other rows, with arm-then-commit.
- `deleteOwnPane` (:1000-1034) runs six ordered steps with its own rollback.
- `replyToPane` (:1426-1448) and `sendReply` (:1378-1422) hold the reply rules. `togglePin` is at :1036-1051.
- Fix commits touching `agent-view.ts` together with a daemon file: 7, including de3632e, which also touches `http.ts`.

**Hidden constraints**
- **Every row is a real pi in private tmux.** The view leaves through `panes.switchTo`, tmux `switch-client` (`daemon/tmux.ts:282`, `leaveFor` :818-829). It never waits on RPC, and `startPane` does not even await the claim.
- **The spawners differ.**
  - Agent view spawns in the pane process: `Tmux.newSession` takes `-x/-y` from `process.stdout`, plus `piEnv()`, `piCommand()` and per-call `env` (`tmux.ts:155-180`). `deleteOwnPane` needs that env.
  - The phone spawns in the daemon (`remote/spawn.ts:30-38`), with the pane-reported `launch.command`.
  - A daemon-side "start a pane" that also spawns would lose the terminal's size and env. Either the request carries them, or the shared operation owns only the claim-and-rollback order, with a spawner the caller passes in. _Inference_: the second keeps the agent view's behaviour without an IPC change.
- `startingRows` belongs to candidate 1's row table, so the daemon half of this candidate follows candidate 1.

**Tests**
- `agent-view-panes.test.ts` (38 tests) already records the fake client's and the fake `PaneOps`' calls into one ordered `calls` array (:38-96). The row-actions module can reuse that fixture directly, with calls instead of keystrokes.
- The claim and 409 paths are also covered in `remote-http`, `remote-control`, `daemon-lifecycle` and `remote-sessions`.

**Risk.** Medium. `agent-view.ts` is 2378 lines, and the arm, guard and cancel state (`opening`, `replying`) is interleaved with the actions.

## 8. One pane report across the IPC seam

**Corrections**
- **There are 7 shapes, not 6.** `RemoteSession` (`daemon/remote/sessions.ts:14-36`, copied at :48-62) is missing. There is also a hop before `SelfSessionInfo`: `selfRow()` builds an `InstanceSummary` that `selfInfo()` copies (`agent-view/index.ts:284-335`).
- **The field counts are 15 and 21, not 14 and 20:** the copy into the record at `handler.ts:176-192`, and `toInstanceSummary` at :43-65.
- **The cited commits touch more source files than claimed.**
  - 620b921 touches 10 source files, not 7.
  - 9bb7900 touches 11, not 8, and it is a feature (slash commands), not one added field.
- **More timing numbers.**
  - `START_MS = 90_000` (`supervisor.ts:52`, `control.ts:18`).
  - The client's request timeout of 30 s (`orchestrator-client.ts:276`), which `WAIT_MS = 25_000` (`handler.ts:68`) stays below.
  - `QUIET_LOOKS`, derived from the heartbeat (candidate 3).
- `self-registration.ts:58,63` do cite a reducer in `daemon/activity.ts` that no longer exists; the file now only exports a type (confirmed).

**Problem (confirmed)**
- `RegisterInput` (`orchestrator-client.ts:25-41`) duplicates `RegisterRequest.instance` (`protocol.ts:16-37`) exactly.
- There are four hand copies (`index.ts:288-301`, `self-registration.ts:200-215`, `handler.ts:176-192`, `handler.ts:43-65`) before `rowFromSummary`'s projection (`rows.ts:83-122`).
- Fix commits touching at least 3 of the shape files: 10.

**Hidden constraints (push back on the timing half)**
- **Pane-side timing is deliberate.** `self-registration.ts:110-113` says the heartbeat is "Tuned here rather than in the daemon, where a TTL change only applies once every running daemon restarts". If the daemon owns the numbers, it has to send its TTL in the register reply. A pane with no such reply keeps 3 s, and an older pane ignores the field.
- **The restart grace stays in the view.** `agent-view.ts:536-541` carries rows over while the daemon relearns them, and only the view knows when it last saw the daemon restart.
- **No protocol version.** Compatibility is by optional fields: everything in `instance` except `id` and `cwd` is optional (`protocol.ts:16-37`), and `ResponseMeta.version/buildId` (:338-349) only detects a stale daemon. A whole report must stay readable from an older pane that sends the current flat shape.

**Tests**
- Existing: `agent-view-self-registration.test.ts` and `remote-sessions.test.ts`.
- New: a round-trip test, report → summary → row, that fails on a dropped field.

**Risk.** Medium. The protocol changes, and the pane and daemon builds diverge.

---

## Recommended order

```
daemon:    1 ──► 2 ──► 8
           └───► 7 (daemon half: start operation)
pane:      3 ─────────► 8        (QUIET_LOOKS follows HEARTBEAT_MS)
subagents: 4 ──► 5 ──► 6
```

**Dependencies**
- 2 needs 1, because the inbox lives on 1's pane entry and settle timing follows 1's reaping.
- 8 needs 1 and 3. 1 and 8 both touch `handler.ts:43-192` and `supervisor.ts` register, and 8's timing changes `QUIET_LOOKS`.
- 7's daemon half needs 1 (`startingRows`, `claimStart`). Its pane half, the module over `client` and `PaneOps`, can start at once, but it conflicts with 8 in `ext/agent-view/`.
- 5 and 6 need 4: their four merges and the finishing wait disappear with it.

**Overlaps (do not run in parallel)**
- 1 / 2 / 8: `supervisor.ts`, `handler.ts`, `serve.ts`.
- 5 / 6: `index.ts` (`findOwnedRun` :485 is both a view and an address step) and `transcript-actions.ts`.
- 7 / 8: `agent-view.ts`, `agent-view/index.ts`.

**What can run in parallel**
- The three tracks are disjoint. Run 3 and 4 first; both are small and low-risk.

## Sources

**Commands** (at `edaa709`)
- `git log --no-merges --format=%h -- <file> | wc -l`, and `git log --format=%s -- <file> | grep -cE '^fix'`, per file. With merges: `supervisor.ts` 58, without merges 53, fixes 28. `agent-view.ts`: 48, 46 and 17.
- Co-change script `/tmp/cochange.sh MIN files…` (outside the repo): lists fix commits that touch at least MIN of the files. Results:

| Candidate | Rule | Fix commits |
|---|---|---|
| C1 | ≥2 of supervisor, handler | 8 |
| C2 | ≥2 of delivery, control, serve, chat.js, supervisor | 7 |
| C3 | index + outcomes | 7 |
| C4–6 | ≥2 subagents files | 5 |
| C8 | ≥3 shape files | 10 |

- `git log --no-merges --format='%h %s' | grep -F 'fix(remote)' | head`, plus `git show --name-only`, for the last-8 claim.
- `git show --name-only` on every commit the review cites.
- `git show -U0 <sha> -- ext/agent-view/agent-view.ts`, with the hunks mapped to their methods, for the render claim.
- `grep -c 'ForTest'`, `grep -c 'as unknown as OrchestratorClient'` and `grep -n 'generation ?? 0'` over `test/` and `ext/`.

**Files read**
- The review (`architecture-review-20261104-1945.html`), `GLOSSARY.md`, `CODING_STANDARDS.md` and `docs/adr/0001-0005`.
- Every source and test file cited above, at the lines cited.

**pi 1.0.4** (`node_modules/@earendil-works/pi-coding-agent/dist/core/`)
- `extensions/types.d.ts:236,244,582-884,1176`
- `extensions/runner.js:1202-1235`
- `agent-session.d.ts:48-56`
- `agent-session.js:653-704,747,1408,1472-1558,1844-1869,2166,2472,2760`
- `agent-session-runtime.js:102-112,297-303`
