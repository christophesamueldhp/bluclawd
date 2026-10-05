# Persistent Session Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve running agents when the user switches session views, and permit deleting the displayed session without resurrecting it.

**Architecture:** The daemon owns each conversation's RPC child from its first model prompt. An idle native Pi runtime hosts a conversation/roster shell; selection only changes an ordered snapshot/event subscription. Preserve the existing raw RPC protocol and legacy exit helper, but never use runtime replacement or continuation prompts for managed navigation.

**Tech Stack:** TypeScript ESM, Node.js builtins, Pi's exported extension/TUI/RPC APIs, Vitest, TypeScript, Biome; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-05-persistent-session-views-design.md` (approved by the user's “gas”; implementation method/plan review still pending).

## Global Constraints

- “Exactly one execution process writes each session file. A terminal viewer never appends remote messages to a local Pi session file.”
- “The package must remain installable through `pi install`; no changes to Pi-owned files, private runtime patching, or requirement to launch only through `bin.mjs`.”
- “Keep at most the newest 200 finalized display messages in the live projection, plus the complete current partial response and active tools.”
- “Older persisted history is read in pages of at most 200 entries without changing the child's branch.”
- “Deletion keeps the existing Agent View semantics: remove the row, preserve the `.jsonl` for explicit `/resume`. It is not permanent transcript deletion.”
- “Old aborted transcript entries are historical facts and are not rewritten or hidden.”
- “Third-party custom TUI parity is outside this fix.” `/tasks`, `/bashes`, and `/rewind` explicitly report their managed-screen limitation; child tools/checkpoint capture remain active.
- “Never silently fall back to local execution or restart a daemon that owns live work.”
- “RPC children must not bootstrap another viewer or another child.”
- Keep the existing 2,000 ms Ctrl+X confirmation window and two-left-press navigation. Keep legacy exit hand-off isolated to unmanaged sessions.
- No credentials or billable provider calls in automated verification. Isolate all daemon state with a temporary `PI_SERVER_DIR` and all Pi test settings/auth/session state with a temporary `PI_CODING_AGENT_DIR`; never stop the user's running daemon.

## Review Focus

- File aliases (relative paths and symlinks) must resolve to one writer, including when two starts race: Task 3.
- Identical message text and equal timestamps must not collapse distinct persisted entries or replay finalized output twice: Task 1.
- A clipboard read started in A must not paste into B after selection changes, including bracketed multiline/Unicode input: Task 7.
- A pending editor/confirmation dialog must remain answerable while another RPC command awaits completion: Task 4.
- Bootstrap/reload must not lose a prompt submitted before readiness or drop bundled child resources in `bin.mjs` development mode: Task 9.

---

## File structure and dependency order

| File | Responsibility |
| --- | --- |
| `daemon/view-types.ts` | Shared versioned view records and projection types; type-only Pi imports |
| `daemon/view-history.ts` | Read-only entry-tree history, stable cursor pages, identity reconciliation |
| `daemon/view-projection.ts` | Pure JSON-event/UI-request display reducer |
| `daemon/session-operations.ts` | Canonical file keys and serialized lifecycle operations |
| `daemon/supervisor.ts` | Child ownership, projections, viewer subscriptions, deletion fencing |
| `daemon/ipc/protocol.ts`, `handler.ts`, `ipc/server.ts` | New view handshake/history routes without changing raw RPC |
| `ext/agent-view/view-client.ts` | Long-lived JSONL client and command-response correlation |
| `ext/agent-view/session-controller.ts` | Selection transactions, drafts, submission and reconnect state |
| `ext/agent-view/session-commands.ts` | Explicit local/remote/unavailable command routing |
| `ext/agent-view/conversation-dialog.ts` | Stock component-based remote dialog interaction |
| `ext/agent-view/conversation-view.ts` | Managed transcript/editor rendering and keyboard handling |
| `ext/agent-view/session-shell.ts` | One custom screen hosting either conversation or Agent View |
| `ext/agent-view/managed-state.ts`, `index.ts` | Plain process-wide reload state and safe native bootstrap |
| `ext/agent-view/rows.ts`, `agent-view.ts` | Managed-current highlighting, attach actions, selected-row deletion |
| `daemon/child-resources.ts`, `rpc-process.ts` | Bundled child extension loading and injectable process launcher |
| `test/support/view-fixtures.ts`, `test/fixtures/view-rpc-child.mjs`, `test/fixtures/persistent-view-provider.ts` | Deterministic events/child and local-only faux-provider fixtures; no network/model billing |

Execute Tasks 1–4 before controller integration; Tasks 5–8 consume their contracts. Task 9 activates the new flow only after its screen and roster are usable. Do not activate partially built managed mode in earlier tasks.

## Shared contracts (defined by Task 1)

Use exported `JsonAgentSessionEvent`, `RpcCommand`, `RpcResponse`, `RpcSessionState`, `RpcExtensionUIRequest`, and `RpcExtensionUIResponse` from Pi, not cumulative SDK events for wire deltas. `DisplayMessage` is `Extract<JsonAgentSessionEvent, { type: "message_end" }>["message"]`.

Define in `daemon/view-types.ts`:

- `VIEW_PROTOCOL_VERSION = 1`, `VIEW_MESSAGE_LIMIT = 200`, `VIEW_HISTORY_LIMIT = 200`.
- `ViewMessage = { key: string; entryId?: string; message: DisplayMessage }`; persisted keys derive from entry IDs, transient keys from generation/sequence, never message text.
- `ViewTool = { toolCallId: string; toolName: string; args: unknown; partialResult?: unknown; parentToolCallId?: string }`.
- `ViewProjection = { messages: ViewMessage[]; partial?: DisplayMessage; tools: Record<string, ViewTool>; activity: "idle" | "working" | "awaiting_input"; compacting: boolean; queues: { steering: unknown[]; followUp: unknown[] }; pendingDialog?: RpcExtensionUIRequest; statuses: Record<string, string>; widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>; title?: string; editorText?: string; historyBefore?: string }`.
- `ViewInput = JsonAgentSessionEvent | RpcExtensionUIRequest | { type: "view_ui_resolved"; requestId: string } | { type: "view_error"; message: string }`.
- `ViewReady = { type: "view_ready"; ok: true; viewProtocol: 1; instance: InstanceSummary; generation: string; sequence: number; projection: ViewProjection; state: RpcSessionState }` (`InstanceSummary` from `daemon/ipc/protocol.ts`).
- `ViewEvent = { type: "view_event"; generation: string; sequence: number; event: ViewInput }`.
- `ViewTerminal = { type: "view_terminal"; instanceId: string; generation: string; sequence: number; reason: "stopped" | "deleted" | "failed"; error?: string }`.
- `ViewRecord = ViewReady | ViewEvent | ViewTerminal | RpcResponse | ErrorResponse` (`ErrorResponse` from existing protocol).
- `HistoryPage = { messages: ViewMessage[]; before?: string }`; return at most 200 messages and use a stable persisted entry ID for `before`.
- `SessionTarget = { instanceId: string } | { sessionFile: string; cwd: string; model?: { provider: string; id: string } }` and `ManagedDraft = { text: string; images: ImageContent[] }` (type-only Pi AI import).

### Task 1: Read-only history and display projection

**Files:** Create `daemon/view-types.ts`, `daemon/view-history.ts`, `daemon/view-projection.ts`, `test/support/view-fixtures.ts`, `test/daemon-view-projection.test.ts`, `test/daemon-view-history.test.ts`.

**Interfaces:** Produce `readViewHistory(sessionFile: string, before?: string, limit?: number): HistoryPage`, `reconcileEntryIds(messages: ViewMessage[], persisted: ViewMessage[]): ViewMessage[]`, `createViewProjection(history?: HistoryPage): ViewProjection`, and `reduceViewProjection(state: ViewProjection, event: ViewInput, key: string): ViewProjection`. Fixtures export `assistant(text: string, timestamp?: number): DisplayMessage` and `textDelta(delta: string, contentIndex?: number): JsonAgentSessionEvent` with complete zero-usage assistant metadata.

- [x] **Step 1: Write failing tests** named `reconstructs text thinking and toolcall deltas`, `message_end replaces partial`, `does not mutate snapshots`, `keeps 200 finalized messages and complete partial`, `nested tools have distinct ids`, `agent_end does not settle retries`, and `dialog detach does not cancel`. Use authoritative text/thinking/toolcall-end content and test queue/compaction/UI clear events. History tests use a temporary valid JSONL tree with two identical messages at the same timestamp, an abandoned branch, compaction, and a trailing incomplete line. Pin missing saved files to a clear error, ignore malformed trailing fragments rather than modifying the file, clamp invalid page sizes to 200, and reject unknown history cursors.
  ```ts
  expect(final.partial).toBeUndefined();
  expect(final.messages.at(-1)?.message).toEqual(assistant("authoritative", 1));
  expect(many.messages).toHaveLength(200);
  expect(many.partial?.content).toEqual(completeStreamingContent);
  expect(page.messages.map(m => m.entryId)).toEqual(["first", "second"]);
  expect(readFileSync(file, "utf8")).toBe(originalFileBytes);
  ```
- [x] **Step 2: Verify RED:** `npx vitest run test/daemon-view-projection.test.ts test/daemon-view-history.test.ts`; expect missing-module failures for the new production modules.
- [x] **Step 3: Implement the interfaces.** Read files without `SessionManager.open()`; parse complete LF-terminated entries, walk the active parent chain, and retain compaction summaries without losing raw displayed history. Reconcile repeated messages by persisted occurrence/entry identity, not by text or timestamp alone. History reconciliation may add IDs/cursors but must not replace live partial/tool state. Purely clone reducer state; remove completed tools and resolved dialogs. No filesystem calls in the reducer.
- [x] **Step 4: Verify GREEN:** repeat Step 2, then `npm run typecheck`; expect passing tests/exit 0.
- [x] **Step 5: Commit:** `git add daemon/view-{types,history,projection}.ts test/support/view-fixtures.ts test/daemon-view-{projection,history}.test.ts && git commit -m "feat: project persistent session views from ordered events"`.

### Task 2: Atomic daemon view attachment and UI fan-out

**Files:** Modify `daemon/supervisor.ts` (`LiveInstance`, `bindRpcProcess`, `spawnInstance`, stream methods), `daemon/rpc-process.ts` (wire event typing); create `test/daemon-view-stream.test.ts`.

**Interfaces:** Consume Task 1. Produce `ServerSupervisor.openViewStream(instanceId: string, onRecord: (record: ViewEvent | ViewTerminal) => void): { ready: ViewReady; close(): void; handleRpc(command: RpcCommand): Promise<RpcResponse>; handleUiResponse(response: RpcExtensionUIResponse): boolean } | undefined` and `getViewHistory(instanceId: string, before?: string, limit?: number): HistoryPage | undefined`. Preserve `openRpcStream()`'s existing public shape. Cache the last confirmed child `RpcSessionState` during initialization/state-affecting commands; derive its streaming/compacting/queue flags from ordered projection events so it cannot report stale idle flags. Snapshot capture must not await a new RPC.

- [x] **Step 1: Write failing tests** `attach returns existing partial and active tools`, `snapshot watermark has no gaps`, `detach keeps child alive`, `two viewers receive dialogs`, `only first matching answer succeeds`, and `compaction and retries survive reattach`. Use the `FakeChild` pattern in `test/daemon-lifecycle.test.ts`; expose emitted events and sent/disposed counts in the new test's own fake.
  ```ts
  expect(attached.ready.viewProtocol).toBe(1);
  expect(next.sequence).toBe(attached.ready.sequence + 1);
  expect(child.disposed).toBe(false);
  expect(child.sent.filter(c => ["stop", "abort", "prompt"].includes(c.type))).toEqual([]);
  expect(supervisor.answer(id, sameAnswer)).toBe(false); // already answered by first viewer
  ```
- [x] **Step 2: Verify RED:** `npx vitest run test/daemon-view-stream.test.ts`; expect absent `openViewStream`/projection assertions to fail.
- [x] **Step 3: Implement live generation/sequence/projection and viewer sets.** Seed history before starting the child, bind before stdout events can reach consumers, and publish readiness only after child state is confirmed. Give legacy fake-child tests actual temporary JSONL files where they claim to resume saved history; do not weaken missing-file checks merely to preserve nonexistent `/p/*.jsonl` fixtures. Snapshot plus subscription registration is synchronous; each input updates projection before fan-out. Snapshot data is a detached copy. Keep raw subscribers separate; isolate throwing listeners. Broadcast explicit dialog-resolution and child failure/stop events, including to multiple viewers. Translate RPC-only extension errors to `view_error` notices without pretending they are typed cumulative SDK events. When finalized events arrive, reconcile their display identities against the read-only persisted entry index; refresh that index at attach/history boundaries if persistence lagged, without replacing partial/tool state.
- [x] **Step 4: Verify GREEN:** `npx vitest run test/daemon-view-stream.test.ts test/daemon-lifecycle.test.ts test/daemon-session-state.test.ts && npm run typecheck`; expect exit 0.
- [x] **Step 5: Commit:** `git add daemon/supervisor.ts daemon/rpc-process.ts test/daemon-view-stream.test.ts && git commit -m "feat: attach session viewers without replacing agent processes"`.

### Task 3: Serialize ownership and fence deletion callbacks

**Files:** Create `daemon/session-operations.ts`, `test/daemon-session-operations.test.ts`; modify `daemon/supervisor.ts` (start/stop/delete/update/exit/state sync), `test/daemon-lifecycle.test.ts`.

**Interfaces:** Produce `canonicalSessionKey(path: string): string` and `SessionOperations.run<T>(key: string, operation: "start" | "stop" | "delete", work: () => Promise<T>): Promise<T>` and `SessionOperations.isBlocked(key: string): boolean`. Attach is synchronous and consults `isBlocked` plus live readiness; it never awaits between snapshot/subscriber registration. Resolve existing paths through realpath; for not-yet-created paths resolve the nearest existing parent plus normalized suffix. Callers reject attach/start when a delete is pending; a queued operation cannot outlive its captured lifecycle revision. Existing public supervisor lifecycle signatures remain unchanged.

- [x] **Step 1: Write failing tests** `parallel alias starts create one child`, `external writer blocks spawn`, `delete rejects queued attach and prompt`, `late get_state cannot upsert removed row`, `late crash cannot resurrect deleted row`, `stop preserves transcript and deletion notifies all viewers`, `failed delete remains visible`, and `explicit later resume is allowed`.
  ```ts
  expect(aliasResult.id).toBe(first.id);
  expect(FakeChild.spawnOptions).toHaveLength(1);
  expect(loadInstances().some(row => row.id === deletedId)).toBe(false);
  expect(readFileSync(sessionFile, "utf8")).toBe(originalTranscript);
  expect(otherChild.disposed).toBe(false);
  ```
- [x] **Step 2: Verify RED:** `npx vitest run test/daemon-session-operations.test.ts test/daemon-lifecycle.test.ts`; expect race/resurrection/new gate failures, not fixture syntax failures.
- [x] **Step 3: Implement per-file queues/revisions and live-identity fences.** Mark deletion before awaiting cleanup; ignore updates/exit callbacks whose live object or revision is stale. Use an internal ungated cleanup method from already-gated deletion instead of reacquiring the same stop/delete lock. Always dispose a child even if optional presence cleanup fails; propagate real lifecycle/storage failures without reporting success. Emit `deleted` to the viewers known before a first-press stop; stopped viewers remain registered for this final lifecycle notification until they detach. Remove row only after successful stop, and retain file. Deliberate later spawn of the saved file may create a new row/generation.
- [x] **Step 4: Verify GREEN:** repeat Step 2 plus `test/daemon-view-stream.test.ts test/daemon-external-instances.test.ts test/daemon-shutdown.test.ts` in one Vitest command, then `npm run typecheck`; expect exit 0.
- [x] **Step 5: Commit:** `git add daemon/session-operations.ts daemon/supervisor.ts test/daemon-session-operations.test.ts test/daemon-lifecycle.test.ts && git commit -m "fix: serialize session ownership and prevent deleted row resurrection"`.

### Task 4: Versioned view protocol and resilient JSONL client

**Files:** Modify `daemon/ipc/protocol.ts`, `daemon/handler.ts`, `daemon/ipc/server.ts`, `ext/agent-view/orchestrator-client.ts`; create `ext/agent-view/view-client.ts`, `test/agent-view-client.test.ts`; extend `test/daemon-ipc-server.test.ts`.

**Interfaces:** Add `ViewStreamRequest = { type: "view_stream"; instanceId: string; viewProtocol: 1 }`, `ViewHistoryRequest = { type: "view_history"; instanceId: string; before?: string; limit?: number }`, and history response `{ type: "view_history_result"; ok: true; page: HistoryPage }`. Advertise `viewProtocol?: number` in daemon metadata/getDaemonInfo without requiring old daemons to supply it. Produce `SessionViewClient.open(instanceId: string, options: { signal?: AbortSignal; onRecord: (record: ViewEvent | ViewTerminal) => void; onDisconnect: (error?: Error) => void }): Promise<{ ready: ViewReady; send(command: RpcCommand): Promise<RpcResponse>; answer(response: RpcExtensionUIResponse): Promise<boolean>; close(): void }>`; constructor accepts optional socket path. Add `OrchestratorClient.history(instanceId: string, before?: string): Promise<HistoryPage>`.

- [x] **Step 1: Write failing socket tests** `ready precedes live events`, `split UTF8 and coalesced JSONL frames`, `early buffered command is not dropped`, `out of order responses match ids`, `dialog answer bypasses slow command`, `close rejects pending requests`, `unknown protocol fails without stopping child`, `raw rpc_stream remains compatible`. Use `StringDecoder` and adversarial byte chunks including emoji and literal U+2028 inside strings.
  ```ts
  expect(records[0].type).toBe("view_ready");
  expect(history.page.messages.length).toBeLessThanOrEqual(200);
  expect(await answerWhileCommandPending).toBe(true);
  expect(stopCalls).toEqual([]);
  ```
- [x] **Step 2: Verify RED:** `npx vitest run test/agent-view-client.test.ts test/daemon-ipc-server.test.ts`; expect unsupported request/client failures.
- [x] **Step 3: Implement handshake/server/client.** Attach synchronously, queue any events until `view_ready` is written, then flush in order. Parse every already-buffered LF record after switching protocols. Correlate commands by unique IDs and dispatch UI answers immediately rather than behind an awaited command queue. Use a 10-second handshake deadline and 30-second command-ack deadline; do not time out accepted model work. Gracefully close on malformed records/oversized 16 MiB frame, never crash the daemon or retry a prompt. Respect socket backpressure and detach slow/broken viewers rather than stalling children; cap queued unsent view data at 16 MiB. Cancel timers/listeners idempotently.
- [x] **Step 4: Verify GREEN:** repeat Step 2 plus `test/agent-view-spawn.test.ts test/daemon-view-stream.test.ts`, then `npm run typecheck`; expect exit 0.
- [x] **Step 5: Commit:** stage only Task 4 files and commit `feat: stream versioned session views over the daemon socket`.

### Task 5: Transactional session selection and drafts

**Files:** Create `ext/agent-view/session-controller.ts`, `test/agent-view-controller.test.ts`.

**Interfaces:** Consume Tasks 1/4. Produce `SessionController(options: { client: OrchestratorClient; views: SessionViewClient; cwd: string; model?: { provider: string; id: string }; onChange: () => void })` with `select(target: SessionTarget, signal?: AbortSignal): Promise<boolean>`, `selected(): ViewReady | undefined`, `projection(): ViewProjection | undefined`, `draft(): ManagedDraft`, `setDraft(draft: ManagedDraft): void`, `submit(draft: ManagedDraft): Promise<"accepted" | "rejected" | "uncertain">`, `send(command: RpcCommand): Promise<RpcResponse>`, `answer(response: RpcExtensionUIResponse): Promise<boolean>`, `history(): Promise<HistoryPage>`, `blank(): void`, `cancelSelection(): void`, `reconnect(): Promise<boolean>`, `forget(instanceId: string): void`, `exportState(): { selectedId?: string; drafts: Record<string, ManagedDraft> }`, `restoreDrafts(drafts: Record<string, ManagedDraft>): void`, and `dispose(): void`.

- [x] **Step 1: Write failing tests** `A B A never stops or respawns live children`, `cancelled or failed attach retains old view`, `stale ready cannot steal selection`, `drafts and images belong to session`, `subscribe precedes first prompt`, `reply after deliberate stop revives saved conversation once`, `export and restore retain every session draft`, `busy prompt uses followUp`, `uncertain acknowledgement never resends`, `deleted terminal record blanks selection`, and `disconnect/reconnect replaces snapshot generation`.
  ```ts
  expect(client.stop).not.toHaveBeenCalled();
  expect(sentPrompt.streamingBehavior).toBe("followUp");
  expect(sentPrompt.images).toEqual(images);
  expect(await controller.submit(draft)).toBe("uncertain");
  expect(promptCalls).toHaveLength(1);
  ```
- [x] **Step 2: Verify RED:** `npx vitest run test/agent-view-controller.test.ts`; expect missing controller failures.
- [x] **Step 3: Implement selection generations and ownership separation.** Live instance IDs attach directly; saved/stopped targets start once without any prompt. New blank selection creates a child only upon submit, attaches, then sends its prompt. A stopped terminal record keeps the selected transcript visible but disables its dead transport; a subsequent deliberate submit starts that saved file once, obtains a fresh snapshot/generation, and only then sends the new prompt. An ordinary stopped event never automatically revives work. Keep old connection until target snapshot is accepted. Clear submitted drafts only on acceptance; preserve rejected/uncertain drafts with explicit notice. Reconnect is explicit (no repeated submission); replay fresh projection and ignore old-generation events. `dispose/blank` only detach, while `forget` also removes the matching draft. Never call native runtime methods.
- [x] **Step 4: Verify GREEN:** repeat Step 2 plus `test/agent-view-client.test.ts`, then `npm run typecheck`; expect exit 0.
- [x] **Step 5: Commit:** `git add ext/agent-view/session-controller.ts test/agent-view-controller.test.ts && git commit -m "feat: switch session subscriptions while preserving agent execution"`.

### Task 6: Explicit session command and UI-response routing

**Files:** Create `ext/agent-view/session-commands.ts`, `test/agent-view-session-commands.test.ts`.

**Interfaces:** Produce `routeSessionCommand(text: string, context: { busy: boolean; commands: Array<{ name: string; source: "extension" | "prompt" | "skill" }> }): { type: "prompt"; message: string } | { type: "rpc"; command: RpcCommand } | { type: "local"; action: "agents" | "new" | "resume" | "model" | "theme" | "help" | "settings" | "quit" | "reload" } | { type: "unavailable"; message: string }` and `stopSelectedSession(controller: SessionController): Promise<void>`.

- [x] **Step 1: Write failing tests** for every spec routing-table row, `/export` aliases, `/name` with spaces, image-only prompts, unknown slash commands, `/tasks`/`/bashes`/`/rewind` notices, skills/templates, and session-sensitive commands while busy. Ensure unsupported built-in/custom commands never become LLM prompts or idle-host operations.
  ```ts
  expect(route("/new")).toEqual({ type: "local", action: "new" });
  expect(route("/name useful task")).toEqual({ type: "rpc", command: { type: "set_session_name", name: "useful task" } });
  expect(route("/rewind").type).toBe("unavailable");
  expect(sent.slice(0, 2).map(c => c.type)).toEqual(["clear_queue", "abort"]);
  ```
- [x] **Step 2: Verify RED:** `npx vitest run test/agent-view-session-commands.test.ts`; expect missing router failures.
- [x] **Step 3: Implement routing and deliberate stop.** Use discovered `get_commands` for prompt/template/skill completion, a local builtin mapping for state/model/compact/name/export, and a bundled unsupported-command list. A discovered third-party extension command is not automatically proof of RPC UI compatibility: unknown extension commands receive an explicit compatibility notice rather than being silently executed; only explicitly known RPC-compatible commands may be forwarded. Standard dialog requests arising from model/tool work still work through the UI bridge. For busy compaction/branch operations report unavailable until idle; never use child `new_session`/`switch_session` for navigation. Clear queue before abort and restore returned text to the selected draft without dropping images. Any RPC failure surfaces to the caller; successful prompt disposition `handled` does not wait for settlement.
- [x] **Step 4: Verify GREEN:** repeat Step 2 plus `test/agent-view-controller.test.ts`, then `npm run typecheck`; expect exit 0.
- [x] **Step 5: Commit:** `git add ext/agent-view/session-commands.ts test/agent-view-session-commands.test.ts && git commit -m "feat: route managed session commands to their execution owner"`.

### Task 7: Conversation screen and remote dialogs

**Files:** Create `ext/agent-view/conversation-view.ts`, `ext/agent-view/conversation-dialog.ts`, `test/agent-view-conversation.test.ts`, `test/agent-view-dialog.test.ts`.

**Interfaces:** Produce `ConversationView(options: { tui: TUI; theme: Theme; keybindings: KeybindingsManager; controller: SessionController; onAgents: () => void; onLocalAction: (action: string) => void; readClipboard?: () => Promise<AgentClipboard> })` implementing `Component`, `Focusable`, `dispose(): void`, and `refresh(): void`. `createConversationDialog(request: RpcExtensionUIRequest, options: { theme: Theme; onAnswer: (response: RpcExtensionUIResponse) => void }): Component & Focusable & { dispose(): void }` supports select/confirm/input/editor. Use existing `AgentClipboard` type from `clipboard.ts`.

- [x] **Step 1: Write failing render/input tests** `complete partial text and tool output survive switching`, `left left changes view not work`, `explicit stop preserves queued draft`, `detach dialog sends no cancel`, `cancel dialog sends exactly matching response`, `async clipboard cannot cross session`, `narrow Unicode lines fit`, `resize/theme invalidate cached lines`, `multiline editor propagates focused cursor`, and `load older history preserves streaming state`.
  ```ts
  expect(rendered).toContain("earlier partial output");
  expect(lines.every(line => visibleWidth(line) <= 24)).toBe(true);
  expect(controller.draft().images).toEqual([]); // delayed paste belonged to prior selection
  expect(answered.map(a => a.id)).toEqual(["pending-request"]);
  expect(onAgents).toHaveBeenCalledTimes(1);
  ```
- [x] **Step 2: Verify RED:** `npx vitest run test/agent-view-conversation.test.ts test/agent-view-dialog.test.ts`; expect missing component failures.
- [x] **Step 3: Implement stock TUI composition.** Use Pi's exported Markdown/theme helpers, Editor/Input/SelectList, and width functions; no second renderer. Render system/custom hidden messages according to display flags, tolerate unknown roles, and key tool output by call ID. Keep unsent drafts in the controller. Capture selected ID plus draft revision before asynchronous paste. Use injected keybindings for navigation/stop and the existing double-left timing; hide thinking/tool detail behind expansion. Dialog detach only disposes UI; explicit Esc cancels exactly once. Coalesce renders, retain scroll when scrolled up, and invalidate on theme/width changes. Show stopped/failed/disconnected/uncertain delivery states explicitly.
- [x] **Step 4: Verify GREEN:** repeat Step 2 plus `test/agent-view-clipboard.test.ts test/agent-view-controller.test.ts`, then `npm run typecheck`; expect exit 0.
- [x] **Step 5: Commit:** stage Task 7 files and commit `feat: display daemon-owned conversations in a switchable terminal view`.

### Task 8: Managed roster opening and selected-session deletion

**Files:** Modify `ext/agent-view/rows.ts`, `ext/agent-view/agent-view.ts`, `test/agent-view.test.ts`; create `ext/agent-view/session-shell.ts`, `test/agent-view-shell.test.ts`.

**Interfaces:** Add `AgentRow.current: boolean` separately from legacy `self`. Extend `collectRows(instances, self, currentId?: string)` without changing legacy defaults. Change `AgentViewOptions.onOpen` to `(target: SessionTarget) => Promise<boolean>` and add `currentId?: () => string | undefined`, `onDeleted?: (instanceId: string) => void`; keep create/reply/clipboard preference callbacks. Produce `SessionShell(options: { tui: TUI; theme: Theme; keybindings: KeybindingsManager; controller: SessionController; client: OrchestratorClient; cwd: string; home: string; version: string; onLocalAction: (action: string) => void })` implementing `Component`, `Focusable`, `showAgents(): void`, `showConversation(): void`, `refresh(): void`, `dispose(): void`.

- [x] **Step 1: Replace tests that enshrine aborting managed open** with `live open selects without stop`, `failed open retains usable roster`, `cancel pending selection`, `current managed row can be deleted`, `bulk delete includes current`, `delete error retains selection`, `unmanaged elsewhere remains protected`, and `CtrlEnter attaches child with chosen model and images`. Keep legacy self-protection tests explicitly labeled legacy.
  ```ts
  expect(calls.filter(([name]) => ["stop", "release"].includes(name))).toEqual([]); // open only
  expect(onDeleted).toHaveBeenCalledWith("selected");
  expect(controller.selected()).toBeUndefined();
  expect(controller.draft()).toEqual({ text: "", images: [] });
  expect(spawned.model).toEqual(chosenModel);
  ```
- [x] **Step 2: Verify RED:** `npx vitest run test/agent-view.test.ts test/agent-view-shell.test.ts`; expect current blocking/open-stop assertions to expose the old flow.
- [x] **Step 3: Implement async attach-first navigation and explicit deletion.** Do not tear down Agent View until `onOpen` succeeds; Esc aborts only the pending selection. Remove managed open's writer-stop/continue logic; never call old takeover for active external rows. Mark `current` visually without setting `self/external`. First Ctrl+X arms for 2,000 ms and stops intentionally; second deletes and invokes `onDeleted` only on acknowledgement. Aggregate bulk failures visibly. Shell owns exactly one focused child screen, while the controller owns subscriptions/drafts; roster replies/new tasks continue using daemon RPC. On selected deletion, controller forgets the row and shell shows blank conversation.
- [x] **Step 4: Verify GREEN:** repeat Step 2 plus `test/agent-view-controller.test.ts test/agent-view-clipboard.test.ts`, then `npm run typecheck`; update now-outdated callback mocks in `test/agent-view-switching.test.ts` without removing their behavioral coverage.
- [x] **Step 5: Commit:** stage Task 8 files and commit `fix: open persistent views and allow deleting the displayed agent`.

### Task 9: Safe native bootstrap, child resources, reload, and exit

**Files:** Create `ext/agent-view/managed-state.ts`, `daemon/child-resources.ts`, `test/agent-view-bootstrap.test.ts`, `test/daemon-child-resources.test.ts`; modify `ext/agent-view/index.ts`, `daemon/rpc-process.ts`, `test/agent-view-switching.test.ts`, `test/agent-view-self-registration.test.ts`, `test/daemon-rpc-process.test.ts`.

**Interfaces:** Produce `ManagedUiState = { phase: "native" | "waiting" | "replacing" | "managed"; selectedId?: string; drafts: Record<string, ManagedDraft>; pendingInput: ManagedDraft[] }`, shared through `sharedRef("agentViewManagedUi", initial)` with no persisted sockets/components/context closures. Define `bootstrapManagedSession(ctx: ExtensionCommandContext, state: ManagedUiState, start: (fresh: ReplacedSessionContext, initial?: SessionTarget) => Promise<void>): Promise<{ cancelled: boolean }>` in `managed-state.ts`. Produce `bundledChildExtensionArgs(): string[]` from `daemon/child-resources.ts`, resolving this repository's manifest extension files in manifest order. Add optional `RpcLaunch = (command: string, args: string[], options: SpawnOptions) => ChildProcess` injection to `RpcProcessInstance(options, launch?: RpcLaunch)` and `createRpcProcessInstance(options, launch?: RpcLaunch)`; production defaults to Node spawn and never accepts this seam over IPC.

- [x] **Step 1: Write failing tests** `factory starts no resources`, `RPC children never bootstrap`, `first input before ready goes to child once`, `blank host produces no self row or quit handoff`, `saved native writer disposed before child starts`, `legacy working migration waits without abort`, `cancelled replacement starts no child`, `reload reconnects without continuation`, `quit only detaches`, `stale daemon with live sessions is not restarted`, and `package and bin paths load child tools once`. Include input from CLI startup, not just editor submission.
  ```ts
  expect(ctx.abort).not.toHaveBeenCalled();
  expect(childSpawn).not.toHaveBeenCalled(); // before native wait/replacement gate is released
  expect(childPromptCalls).toEqual([initialPrompt]);
  expect(handOffAfterExit).not.toHaveBeenCalled(); // managed placeholder quit
  expect(resourcePaths[0]).toContain("ext/permissions/index.ts");
  ```
- [x] **Step 2: Verify RED:** `npx vitest run test/agent-view-bootstrap.test.ts test/daemon-child-resources.test.ts test/agent-view-switching.test.ts`; expect bootstrap/resource/new navigation failures.
- [x] **Step 3: Implement startup through a hidden bootstrap command.** In TUI startup only, dispatch the command using Pi's existing command path. Buffer normal input via the `input` event and gate native terminal input during transition; do not send buffered input to the idle host. If working, await `ctx.waitForIdle()` without aborting and recheck cancellation. Capture only plain initial file/model/cwd data, call `ctx.newSession()` once to release the original writer, and initialize the shell in fresh `withSession` context; schedule its custom-screen lifetime without keeping replacement blocked indefinitely. Recursive session_start recognizes `replacing/managed`. Do not load/create an unsaved placeholder child. Hide bootstrap commands from completion. On reload save plain selection/drafts and dispose every viewer; on quit managed state never captures the host for hand-off. Native/unmanaged quit retains its tested helper.
- [x] **Step 4: Integrate child resources and local host actions.** Append the package's absolute extension paths in manifest order for both installed-package and development child entry paths, deduplicating discovered copies through Pi's loader (verify once-only registration). Keep credentials/settings/project discovery as normal; no `--no-extensions` shortcut. Handle local theme/settings/help/reload/quit inside the shell without invoking native session-sensitive commands on the placeholder. Advertise/check protocol before entering managed mode; compatible daemon attach does not restart any process, incompatible live daemon reports a retryable upgrade limitation.
- [x] **Step 5: Verify GREEN:** repeat Step 2 plus `test/agent-view-hand-off.test.ts test/agent-view-self-registration.test.ts test/daemon-rpc-process.test.ts test/registration.test.ts`, then `npm run typecheck`; expect exit 0.
- [x] **Step 6: Commit:** stage Task 9 files and commit `feat: bootstrap persistent session execution before the first prompt`.

### Task 10: Real-child lifecycle regression and user-facing contract

**Files:** Create `test/fixtures/view-rpc-child.mjs`, `test/fixtures/persistent-view-provider.ts`, `test/agent-view-persistence.test.ts`, `scripts/probe-persistent-session-views.ts`; modify `README.md`, `ext/help/index.ts`.

**Interfaces:** The fake RPC child accepts get_state/get_messages/get_entries/prompt/clear_queue/abort and UI answers, emits deterministic UTF8 JSONL, and reports real PID plus tool-execution count. Its prompt has a controllable tool gate released by a test command; it never calls a provider. The probe exports `probePersistentSessionViews(options: { piPackageRoot?: string }): Promise<{ pidStable: boolean; toolExecutions: number; deletedRowAbsent: boolean; transcriptPreserved: boolean; childToolsLoaded: boolean }>`; use the Task 9 launch seam and temporary state, not the actual daemon socket. `test/fixtures/persistent-view-provider.ts` exports a normal extension factory that registers a local `fauxProvider` via `pi.registerProvider(faux.provider)`, provider `bluclawd-view-test`, model `view-test`, and a `view_test_gate` tool whose execution writes PID/count to an isolated gate directory and waits for a matching release file. Use `fauxAssistantMessage`/`fauxToolCall` to return a deterministic gate call followed by text after its tool result. Gate work obeys its abort signal and a 30-second deadline. Include this fixture only in temporary test-agent settings, never in the shipped package manifest or real user settings.

- [x] **Step 1: Write failing integration tests** `A B A during gated tool preserves real pid and runs once`, `terminal disconnect preserves active work`, `reattach recovers earlier partial and pending dialog`, `delete current blanks view and leaves other pid alive`, `late metadata cannot resurrect row`, and `explicit resume does not automatically prompt`. Launch genuine Node subprocesses through the injected launcher; drive actual IPC server/client/controller, not canned selection results.
  ```ts
  expect(afterPid).toBe(beforePid);
  expect(toolExecutions).toBe(1);
  expect(promptMessages).not.toContain(CONTINUE_PROMPT);
  expect(await controller.submit(nextDraft)).toBe("accepted");
  expect(transcriptPreserved).toBe(true);
  ```
- [x] **Step 2: Verify RED:** run `npx vitest run test/agent-view-persistence.test.ts` before adding the real-child fixture/probe; expect missing-fixture/probe failure. If an assertion exposes a production defect afterward, preserve it as RED, trace the owning task's root cause, and fix there before continuing; do not weaken lifecycle assertions.
- [x] **Step 3: Implement fixture/probe and satisfy lifecycle tests.** Cover both dependency resolution paths using the installed Pi root and repository dependency. The probe honors explicit `options.piPackageRoot` or `PI_PACKAGE_ROOT`, resolving that installation's RPC entry; do not merely set an environment variable while launching the repository's Pi in both runs. Separately use real Pi RPC initialization without a model prompt to assert bundled tools/checkpoints/commands load once, and that no child viewer boots recursively. Cleanup sockets/children/tempdirs in finally blocks and impose explicit deadlines covering failure exits.
- [x] **Step 4: Update README/help.** Replace the interrupted-turn hand-off claim and old limitation paragraph with persistent process/view semantics, active deletion and `.jsonl` retention, safe one-time legacy migration, incompatible-daemon behavior, deliberate stop vs navigation, and managed custom-UI limitations. Document Ctrl+Enter model selection now being applied at child startup. Do not claim full native custom-TUI parity or erase historical aborted entries.
- [x] **Step 5: Verify GREEN:** `npx vitest run test/agent-view-persistence.test.ts test/cc-commands.test.ts test/smoke.test.ts && npm run typecheck`; expect exit 0. Run the probe against each available Pi installation, requiring all boolean fields true and `toolExecutions === 1`.
- [x] **Step 6: Commit:** stage Task 10 files and any regression-specific fixes from owning tasks; commit `test: prove session view switches preserve live execution`.

### Task 11: Whole-branch verification and handoff

**Files:** Review all changed product/test/docs files; update this plan's completed checkboxes and `TODO.md` only after evidence is recorded.

**Interfaces:** Consume the complete implementation. Deliver verification evidence and a reviewed branch, not another product subsystem.

- [x] **Step 1: Run all automated checks:** `npm test && npm run typecheck && npm run lint`. Require exit 0, inspect complete output, and distinguish pre-existing lint problems from new ones without silently formatting unrelated code. Planning baseline: 38 test files / 397 tests passed and typecheck exited 0 on 2026-10-05; baseline lint was not run.
- [x] **Step 2: Run probe against repo Pi:** `node --experimental-strip-types scripts/probe-persistent-session-views.ts`; require stable PID, one tool execution, no deleted row, preserved transcript, and child resources loaded.
- [x] **Step 3: Run probe against installed Pi:** `PI_PACKAGE_ROOT=/Users/christophesamueldhp/.pi/agent/install/releases/1.0.3/node_modules/@earendil-works/pi-coding-agent node --experimental-strip-types scripts/probe-persistent-session-views.ts`; use that package's RPC entry explicitly and record its version. If unavailable, report the verification gap instead of claiming parity.
- [ ] **Step 4: Do isolated terminal smoke checks** for both Pi installations: use a temporary agent directory/settings fixture with the package installed and no credentials, configure `test/fixtures/persistent-view-provider.ts` only in that isolated harness, select `--provider bluclawd-view-test --model view-test`, then exercise A/B/A, image draft, pending editor dialog, selected Ctrl+X, resize, and exit. Verify native bootstrap/custom-screen focus visually or by captured PTY output. Do not touch the real user's sessions or Pi files. If the environment cannot provide a PTY, state that limitation rather than treating the headless probe as a visual test.
- [x] **Step 5: Review the whole diff** against the spec, especially private upstream calls, session-file writes from UI, unbounded event storage, prompt retransmission, callback resurrection, first-input races, and command/session mismatch. Use a fresh independent reviewer if a subagent/review tool becomes available; otherwise perform an inline review and explicitly report that it was not independent. Fix findings with focused failing regressions and rerun Steps 1–4 that cover the changed paths.
- [x] **Step 6: Record evidence and commit tracking/docs:** `git diff --check`, stage only the changed plan/tracking documents, commit `docs: record persistent session view verification`. Use finishing-a-development-branch to offer integration choices; do not push/merge or remove the worktree without the user's selection.

## Plan self-review and execution boundary

Spec coverage: ownership/bootstrap → Tasks 3/9; attachable screen → Tasks 5/7/8; ordered snapshots/history → Tasks 1/2/4; commands/dialogs → Tasks 4/6/7; active/bulk deletion → Tasks 3/5/8; legacy/reload/exit/failures → Tasks 3–5/9; all requested verification → Tasks 1–11. Review Focus inputs are each pinned to a named failing test above.

Types used across tasks are defined in Shared contracts or in the producer's Interfaces block. Existing signatures stay compatible except the internal Agent View opening callback, whose mocks and callers are updated in Tasks 8/9. The new view protocol remains version 1 and raw RPC keeps its original records.

Execution completed on branch `fix/persistent-session-views` after user authorization (`kerjakan langsung`). Tasks 1–10 and final automated/inline review checks are complete. Task 11 terminal checks pass on Pi 0.84.4 and 1.0.3 for native bootstrap, two gated children, A/B/A, pending stock editor, selected Ctrl+X, resize and managed quit. Physical clipboard image integration remains unchecked (covered by isolated injected-clipboard/stock-editor tests instead). Latest result: 565 tests / 52 files, typecheck and lint exit 0 (two test-only type warnings). Both RPC probes return stable PID, one tool execution, deleted row absent, preserved transcript and child tools loaded. No independent reviewer was available; four inline review findings were fixed with failing→passing regressions. No push or merge has been performed. Native execution is recommended here because there is no available subagent tool and the tasks share several sequential protocol/controller interfaces. At execution time, read using-git-worktrees and establish an isolated workspace, then use executing-plans; do not claim an independent reviewer exists if none is available.
