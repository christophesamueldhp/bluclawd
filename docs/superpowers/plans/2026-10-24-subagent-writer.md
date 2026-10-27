# Subagent Writer (M3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, natively in the current session. The approved design preserves native execution unless an implementer/reviewer tool becomes available. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a subprocess-backed implementation worker that returns private, reviewable patches and supports human-authorized, checkpoint-safe integration without weakening M0–M2.

**Architecture:** Keep the fresh SDK conversation and provider credentials parent-side. A dedicated controller subprocess owns a separate sandbox and executes every writer filesystem/search/shell operation through that boundary. Retain exact-base worktrees and apply validated artifacts only through `/subagent-apply <run-id>` after interactive confirmation.

**Tech Stack:** Existing TypeScript/ES modules, Node subprocesses/private pipes, public Pi SDK APIs, Git, sandbox-runtime `0.0.81`, Vitest, and repository npm scripts/lockfile; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-24-subagent-writer-design.md` (approved by the user).

**Predecessor:** `docs/superpowers/plans/2026-10-23-subagents.md`; M0–M2 baseline commit `519889c` on `feat/read-only-subagents`.

**Status:** Historical plan, superseded as product scope by `docs/superpowers/specs/2026-10-24-configurable-subagents-design.md`. The replacement role-neutral plan is `docs/superpowers/plans/2026-10-24-configurable-subagents.md` (awaiting review). Do not implement a separate writer role or resume these obsolete tasks. The real cleanup gate failed in the retained isolated checkout; changing names/workspace defaults does not make that proof pass.

## Global Constraints

- Use public Pi APIs. Do not modify Pi internals, serialize provider functions, or pass provider credentials/history to the execution worker.
- Reuse installed sandbox-runtime `0.0.81` and the existing npm lockfile/scripts. Ask before adding dependencies or changing manifests; do not change `strict: false` to simplify types.
- Require a trusted project, validated policy, clean Git parent, exact selected HEAD, and proven backend. No implicit main/default branch, dirty-state copy, ignored-file/dependency copy, or repository-selected controller/loader.
- Custom roles need explicit capability `read-only | writer`; omission preserves today's read-only ceiling. Tools alone cannot escalate a read-only role.
- Writer tools are `read`, `grep`, `find`, `ls`, `write`, `edit`, and gated `bash`, intersected with role and parent restrictions. No MCP, codemode, monitor, arbitrary extensions, nesting, or background-service transfer.
- No automatic integration, commit, stash, reset, push, deployment, migration against external state, or worktree deletion. No network access from model-selected commands. Provider requests remain parent-side.
- At most one writer may be admitted (queued or active) per parent runtime. Share the existing two-active/four-queued scheduler and five-minute admission deadline, 12-turn ceiling, 40-call ceiling, per-run 100k reported tokens, and parent-turn six-run/300k reported-token limits. Definitions may lower but never raise them.
- Maximum wire frame: 256 KiB; maximum model tool input: 32 KiB. Public tool output remains bounded to 32 KiB and parent-facing reports to 8 KiB. Initial artifact caps: 1 MiB patch and 100 changed files. Enforce byte limits, not JavaScript character counts.
- Initial patch support is regular UTF-8 text files, including new/deleted files. Reject binary changes, symlink changes, submodule changes, executable-mode changes, and unsupported filter/LFS repositories rather than silently weakening validation.
- Never release a slot/writer lease while execution may still be alive. Preserve `stopping`, partial work, and diagnostics if settlement cannot be established. Never kill a process solely because a persisted PID matches.
- Prove daemon/detached/double-fork, timeout, and owner-loss containment on each enabled backend. If the existing public APIs cannot prove it, stop and ask about a narrower capability or another backend. Do not silently substitute either.
- Preserve M0–M2 task ownership, usage attribution, notification holds, global instructions, trust handling, and read-only tool ceilings. A child report is untrusted data, not authorization or evidence of tests passing.
- Artifacts/transcripts remain private user state; no automatic worktree/artifact cleanup. Tests may clean only their own temporary fixtures. Product cleanup must not erase user work.
- Apply requires explicit interactive confirmation, correct owner/origin/generation, exact base and clean parent, safe paths, a valid artifact digest, and a parent safety checkpoint. No noninteractive/model/phone apply route.
- English in persisted artifacts. Ask before executing planned commits; no push, merge, deployment, or history rewrite is included. Every task's verification also runs `npm run typecheck`, `npm run lint`, and `git diff --check` before a proposed commit. Report actual output, including skips/failures.

## Review Focus

1. **Inherited temporary/system allowances and helper imports:** sibling paths, credentials, and parent/shared Git data must stay inaccessible even when the runtime needs public dependencies; Task 0 and Task 2 test the effective OS boundary.
2. **Apparently clean but unsafe Git state:** index suppression flags, sparse checkout, filters/hooks, unusual names, ignored-file and case-folding collisions must not cause hidden overwrites or host-side code execution; Task 1 and Task 5 pin refusal behavior.
3. **Fragmented/spoofed control output:** split UTF-8, multiple frames, malformed/oversized payloads, and shell text resembling evidence/usage frames must not corrupt control state or accounting; Task 2 and Task 4 cover them.
4. **Nested cwd and asynchronous drift:** worker execution paths must preserve the dispatching subdirectory while artifact paths stay repository-relative; session/base changes during queueing, auth, setup, and confirmation must invalidate the request; Task 1, Task 3, and Task 5 cover them.
5. **Cross-instance apply/rewind and uncertain termination:** no nested-lock deadlock, stale-lock takeover, unowned cancellation, early slot release, or automatic recovery over concurrent user work; Task 2, Task 3, and Task 5 cover them.

---

## File Structure and Dependency Order

| Owner | Create / modify | Responsibility |
| --- | --- | --- |
| Task 0 | `test/helpers/writer-fixture.ts`, `test/fixtures/subagent-writer/{probe-controller,probe-tool,descendants}.mjs`, `test/subagents-writer-backend.test.ts`; retain `test/subagents-writer-sandbox.test.ts` | Real local proof; no product activation |
| Task 1 | `ext/subagents/{workspace,writer-policy}.ts`; modify `definitions.ts` only for writer tool constants/types | Safe repository identity/setup and immutable writer policy |
| Task 2 | `ext/subagents/{writer-protocol,writer-worker,writer-tool-host,writer-client}.ts`; extend `writer-policy.ts` | Validated IPC, sandbox controller, sandboxed tool helper, parent gateway |
| Task 3 | `ext/subagents/{session,writer-runner}.ts`, `ext/subagents/agents/writer.md`; modify `runner.ts`, `definitions.ts`, `runs.ts`, `index.ts` | Shared SDK lifecycle, explicit capability, one-writer admission, end-to-end execution |
| Task 4 | `ext/subagents/artifacts.ts`; modify `runs.ts`, `writer-runner.ts`, `results.ts`, `storage.ts` | Validated patch retention and runtime-owned evidence |
| Task 5 | `ext/_shared/writer-mutations.ts`, `ext/subagents/apply.ts`; modify `workspace.ts`, `index.ts`, `runs.ts`, `ext/checkpoints/index.ts` | Cooperating mutation leases, explicit apply, checkpoint safety/created-file attribution |
| Task 6 | `writer-runner.ts`, `README.md`, this plan and predecessor status; targeted task/remote/registration tests | Integrated acceptance, honest platform documentation, release checks |

Repository test snippets below assume `f` is created with Task 0's helper in `beforeEach` and `await f.cleanup()` runs in `afterEach`. Imports and ordinary setup are not new production interfaces.

Implement in order. Do not register writer execution in Task 1 or Task 2. Tasks 3–5 keep production writer dispatch disabled through the internal `WRITER_RELEASE_ENABLED = false` constant in `writer-runner.ts`; no definition, argument, environment variable, or settings field can enable it. Integration tests may mock this constant to exercise the route, but mocks never establish backend support. Task 6 alone may enable production dispatch after the real gates pass, followed by fresh checks on the enabled tree. Do not duplicate Pi's agent loop or build a generic workflow/transport framework.

## Task 0: Prove the Backend Before Building the Capability

**Files:** Create the proof fixtures/tests in the table; update only the predecessor's M3 evidence with actual outcomes. No production module changes.

**Interfaces:**
- Consumes: public `SandboxManager`, public tool factories, public `createLocalBashOperations`, existing macOS filesystem feasibility test, and the approved design.
- Produces: a recorded supported/unsupported backend decision with exact Node/OS/sandbox versions and real command outcomes. Later tasks may not infer support from `isSupportedPlatform()` alone.
- Test helper `createWriterFixture(): Promise<{ parentCwd: string; siblingDir: string; runDir: string; exec: ExtensionAPI["exec"]; cleanup(): Promise<void> }>` creates a private temporary committed Git repository and separately owned sibling/run directories. `exec` is argument-vector execution with timeout/abort support, not a shell interpolator. Add fixture extensions locally in tests rather than a new test framework.

- [ ] **Step 1: Write failing real-backend assertions.** The controller lives outside its command sandbox and never initializes the parent's manager. File/search helpers execute complete public tool operations inside the sandbox; Bash is wrapped and spawned by the controller. Pin these assertions:

```ts
expect(parentTrackedText).toBe("original\n");
expect(siblingCanaryExists).toBe(false);
expect(deniedReadCanaryInAnyOutput).toBe(false);
expect(parentSandboxConfigAfter).toEqual(parentSandboxConfigBefore);
expect(ownedCommandProcessesAfterStop).toEqual([]);
expect(ownedCommandProcessesAfterParentLoss).toEqual([]);
```

Cover write/edit/read/grep/find/ls, shell reads/writes, traversal and symlink swaps, `.git`/`GIT_DIR`/common-object access, home credentials, default temporary allowances, public-runtime carve-outs, and outbound network denial. Use fixture-owned loopback/Unix-socket endpoints for network probes, not external services. Include concurrent permitted parent activity. Exercise inherited-stdio background commands, `detached: true`/new sessions, double-fork, timeout, and abrupt owner exit. Use fixture-owned identifiers/start identity, not bare persisted PIDs; bound probe lifetimes so a failed proof cannot leave an indefinite daemon.

- [ ] **Step 2: Run the red proof.** `npm test -- test/subagents-writer-backend.test.ts`. Confirm a genuine safety assertion fails against the insufficient baseline; record unsupported dependencies/platform separately. A skipped suite is not proof and does not permit proceeding.
- [ ] **Step 3: Implement only the minimal test-owned subprocess/sandbox prototype.** Scrub environment and constrain all file/search/shell processes; use existing public APIs. Do not invent a second product backend or keep widening permissions until a test starts.
- [ ] **Step 4: Run proof plus existing feasibility tests.** `npm test -- test/subagents-writer-backend.test.ts test/subagents-writer-sandbox.test.ts`. Proceed only when every required assertion actually passes on the intended backend. If detached cleanup or filesystem containment cannot be established, record the failure, leave writer disabled, and return to the user before Task 1. Run this proof on Linux before claiming Linux support; macOS success cannot stand in for it or vice versa.
- [ ] **Step 5: Review evidence and request authorization for the proposed local commit:** `test: prove subprocess writer isolation and cleanup`. Commit only authorized fixture/test/evidence changes; do not claim M3 shipped.

## Task 1: Exact-Base Workspaces and Immutable Writer Policy

**Files:** Create `ext/subagents/workspace.ts`, `ext/subagents/writer-policy.ts`, `test/subagents-workspace.test.ts`, `test/subagents-writer-policy.test.ts`; modify `ext/subagents/definitions.ts` for writer tool names/types only.

**Interfaces:**
- Consumes: Task 0's backend decision and fixture helper; `pathRule`, `evaluateToolCallDeny`, and the existing permission glob/symlink semantics.
- Produces in `workspace.ts`:
  - `WriterRepository { parentCwd: string; checkoutRoot: string; commonGitDir: string }`.
  - `WriterBase extends WriterRepository { baseCommit: string; statusDigest: string }`.
  - `WriterWorkspace extends WriterBase { runId: string; runDir: string; root: string; gitDir: string; scratchDir: string; executionCwd: string }`.
  - `resolveWriterRepository(cwd: string, exec: ExtensionAPI["exec"], signal?: AbortSignal): Promise<WriterRepository>` resolves identity without requiring a clean tree, so rewind can use it later.
  - `inspectWriterBase(cwd: string, exec: ExtensionAPI["exec"], signal?: AbortSignal): Promise<WriterBase>` requires eligible, genuinely clean state.
  - `createWriterWorkspace(options: { base: WriterBase; runId: string; runDir: string; exec: ExtensionAPI["exec"]; signal: AbortSignal; isCurrent(): boolean }): Promise<WriterWorkspace>` creates only the pinned detached worktree.
  - `createSafeWriterGitExec(exec: ExtensionAPI["exec"], repository: WriterRepository): ExtensionAPI["exec"]` pins cwd, scrubs Git environment through trusted `env` arguments, disables hooks/fsmonitor/external execution, and preserves only trusted temporary-index/identity assignments required by checkpoint machinery.
- Produces `WRITER_ALLOWED_TOOLS` and `WriterToolName` in `definitions.ts`, without widening `AllowedSubagentTool` or the read-only parser yet.
- Produces branded, frozen `WriterPolicySnapshot { base: WriterBase; denyRules: readonly string[]; allowedTools: readonly WriterToolName[] }`, `createWriterPolicySnapshot(options: { base: WriterBase; denyRules: readonly string[]; allowedTools: readonly WriterToolName[] }): { ok: boolean; snapshot?: WriterPolicySnapshot; error?: string }`, and `isValidWriterPolicySnapshot(value: unknown): value is WriterPolicySnapshot` in `writer-policy.ts`. Constructor options are exactly the three public snapshot fields; the brand is runtime-only.

- [ ] **Step 1: Write failing tests.** Assert the exact HEAD/base and canonical identities; nested dispatch cwd maps to the same subdirectory in the worktree. Refuse staged/unstaged/untracked changes, unborn HEAD, conflicts, unsupported sparse/index-suppression state, filter/LFS/submodule setup, and malformed policy. Git hooks/filter/fsmonitor sentinels must never run on the host. Dirty state or `isCurrent() === false` arising after an awaited preflight must prevent creation; aborted/failed setup preserves and identifies any partial workspace. User ignored files/dependencies must not appear in it. Assert Read/Edit/Write restrictions are retained/rebased, read-denied content cannot become a patch source, and unrepresentable rules refuse rather than disappear.
```ts
it("refuses dirty state without creating a worktree", async () => {
  writeFileSync(join(f.parentCwd, "untracked.txt"), "user work\n");
  await expect(inspectWriterBase(f.parentCwd, f.exec)).rejects.toThrow(/clean/i);
  expect(existsSync(join(f.runDir, "worktree"))).toBe(false);
});
```

- [ ] **Step 2: Run red.** `npm test -- test/subagents-workspace.test.ts test/subagents-writer-policy.test.ts`; require missing-export/behavior failures, not a setup or syntax accident.
- [ ] **Step 3: Implement the named interfaces.** Use argument-vector Git execution, bounded timeouts and abort signals; disable executable Git features before any status/checkout operation. Refuse unsupported repository features rather than implement sparse/filter support. Set workspace `root` to `<runDir>/worktree` and `scratchDir` to `<runDir>/scratch`; keep controller artifacts/transcripts outside both. Compute `executionCwd` from the original cwd relative to the checkout root, while keeping artifact paths root-relative. Freeze policy before admission; compile workspace-specific OS rules only after the run's actual workspace exists. Do not add auto-cleanup or register a writer.
- [ ] **Step 4: Verify.** Run the two new suites plus `npm test -- test/subagents-policy.test.ts test/permissions-deny.test.ts test/subagents-definitions.test.ts`; all must pass, including existing read-only behavior.
- [ ] **Step 5: Review the diff and request authorization for:** `feat: add pinned writer workspaces and policy snapshots`.

## Task 2: Private Worker Protocol and Sandboxed Tool Execution

**Files:** Create `ext/subagents/{writer-protocol,writer-worker,writer-tool-host,writer-client}.ts`, `test/subagents-writer-protocol.test.ts`, `test/subagents-writer-execution.test.ts`; extend `writer-policy.ts`. No tool registration yet.

**Interfaces:**
- Consumes: Task 1's repository/workspace/policy/tool names and Task 0's proven backend.
- `writer-protocol.ts` owns `WRITER_PROTOCOL_VERSION = 1`, `MAX_WRITER_FRAME_BYTES = 256 * 1024`, `MAX_WRITER_INPUT_BYTES = 32 * 1024`, `encodeWriterFrame(frame: WriterFrame): Buffer`, and `WriterFrameDecoder.push(chunk: Uint8Array): WriterFrame[]`. Every `WriterFrame` has `version: 1`, `requestId: string` and `kind`: `init` carries `workspace` and plain `policy: { base, denyRules, allowedTools }`; `execute` carries `tool`/`input`; `stop` carries no model payload; replies are `ready`, `result` (fields `reply` and optional controller-observed `command`), `stopped` (only after drain), or `error` (fields `code` and safe `message`). Request IDs are controller-owned UUIDs. Validate the decoded policy again; never serialize its brand or accept a JSON trust flag. Inputs/outputs exclude credentials, raw history, and model-supplied runtime evidence.
- `WriterCommandEvidence { command: string; cwd: string; startedAt: number; endedAt: number; exitCode: number | null; signal?: string; cancelled: boolean; truncated: boolean }` belongs to the protocol. It records observed execution, not semantic test success.
- `buildWriterSandboxConfig(snapshot: WriterPolicySnapshot, workspace: WriterWorkspace, runtimeReadPaths: readonly string[]): SandboxRuntimeConfig` in `writer-policy.ts` uses only trusted fixed runtime paths and validated policy; neither tool arguments nor definitions may widen them.
- `startWriterExecution(options: { workspace: WriterWorkspace; policy: WriterPolicySnapshot; signal: AbortSignal }): Promise<WriterExecutionClient>` in `writer-client.ts`. The client exposes `execute(tool: WriterToolName, input: Record<string, unknown>, signal?: AbortSignal): Promise<WriterToolReply>`, `stopAndDrain(): Promise<void>`, and `commandEvidence(): readonly WriterCommandEvidence[]`.
- `WriterToolReply { content: Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>; details?: unknown; isError: boolean }` is independently validated and JSON-safe; it never supplies SDK usage, verification, ownership, or integration fields. Count the complete serialized exposed result against its output cap; do not truncate binary/image content into invalid data.
- `createWriterToolDefinitions(client: WriterExecutionClient, workspace: WriterWorkspace, policy: WriterPolicySnapshot): ToolDefinition[]` returns only permitted gateway tools, never local fallback implementations.

- [ ] **Step 1: Write failing unit and real-execution tests.** Frame parsing must survive split multibyte UTF-8 and multiple frames per chunk, but reject unknown/version-mismatched/oversized/truncated frames, wrong IDs, extra control operations and forged usage/evidence. Assert 256 KiB wire, 32 KiB input/output limits, bounded raw-output termination, `isError`, and control-sequence stripping. Run the complete read/search/write/edit path under the sandbox, not just a mocked operations hook. A shell printing valid-looking JSON must remain output data; actual nonzero exit must remain nonzero evidence. Assert no inherited credentials, `NODE_OPTIONS`, startup hooks, Git overrides, or external networking. Include worker boot/crash/EOF, parent loss, cancellation and daemon cleanup from Task 0.
```ts
it("rejects a raw frame larger than 256 KiB before unbounded buffering", () => {
  const decoder = new WriterFrameDecoder();
  expect(() => decoder.push(Buffer.alloc(256 * 1024 + 1, 0x78))).toThrow(/frame|limit/i);
});
```

- [ ] **Step 2: Run red.** `npm test -- test/subagents-writer-protocol.test.ts test/subagents-writer-execution.test.ts`.
- [ ] **Step 3: Implement the protocol/controller/client.** Use private stdio pipes, bounded byte buffers and independently validated schemas. Resolve a compatible existing Node executable; missing/incompatible runtime refuses launch. Initialize the worker's own sandbox once, never the parent's. Run complete file/search tools in a fixed sandboxed helper using public factories. Execute Bash in the controller through sandbox wrapping and the public local operations API so its real exit is observed outside model-selected code. Encode raw stdout/stderr as data. Serialize operations within one writer and cap pending requests by the existing 40-call ceiling. Clamp requested shell timeout to the remaining run deadline. On stop, abort, then bounded TERM/KILL escalation (one second cooperative, one second TERM grace); do not resolve drain merely because escalation was sent or a pipe closed. Never manufacture settlement for an escaped process.
- [ ] **Step 4: Verify.** Run both new suites and Task 0's proof against the actual production execution path. Reuse the adversarial scenarios without retaining the test prototype as a second product backend. If the production path cannot meet the proof, stop before Task 3. Confirm the parent's concurrent commands and configuration remain unchanged.
- [ ] **Step 5: Review the diff and request authorization for:** `feat: execute writer tools through an isolated controller`.

## Task 3: Explicit Writer Capability, SDK Lifecycle and Admission

**Files:** Create `ext/subagents/session.ts`, `ext/subagents/writer-runner.ts`, `ext/subagents/agents/writer.md`, `test/subagents-writer-tool.test.ts`, `test/subagents-writer-lifecycle.test.ts`; modify `definitions.ts`, `runner.ts`, `runs.ts`, `index.ts`, `test/subagents-definitions.test.ts`, `test/subagents-runs.test.ts`, and `test/subagents-runner.test.ts`. Update only the runner's affected typed definition fixtures, not unrelated test formatting.

**Interfaces:**
- Consumes: Tasks 1–2, existing `SubagentRunScheduler`, native provider inheritance and SDK settlement proof.
- Produces internal `WRITER_RELEASE_ENABLED = false` in `writer-runner.ts`; `index.ts` refuses production writer dispatch until Task 6 changes it. This is a development release guard, not a configurable permission override.
- `AgentDefinition` gains a discriminated capability with omission normalized to `read-only`; its tools are `AllowedSubagentTool[]` for read-only and `WriterToolName[]` for writer. Frontmatter key is exactly `capability`. Invalid capability/tool combinations fail closed; leave all existing definition bounds/precedence intact.
- `AdmitSubagentRunRequest` and `SubagentRunRecord` gain `capability?: "read-only" | "writer"`, treating legacy omission as read-only. Writer records gain `writer?: { workspace?: WriterWorkspace; commands: WriterCommandEvidence[] }`; later tasks extend only this metadata.
- Move common SDK session execution and model/snapshot/diagnostic helpers into `session.ts`; preserve existing imports by re-exporting `resolveChildModelAndRuntime`, `captureWorkspaceSnapshot`, and `sanitizeDiagnosticText` from `runner.ts`.
- `RunPreparedSubagentSessionOptions = Omit<RunRestrictedSubagentOptions, "definition" | "policySnapshot"> & { definition: AgentDefinition; executionCwd: string; approvedTools: readonly ToolDefinition[]; policyExtension: ExtensionFactory }`. `runPreparedSubagentSession(options: RunPreparedSubagentSessionOptions): Promise<SubagentRunnerOutcome>` in `session.ts` owns the existing SDK settings/resources/usage/settlement logic. Snapshot drift still compares the parent `record.cwd`, not the worker's own modifications.
- Keep `runRestrictedSubagent(options)` as the validating read-only wrapper; its native tools and branded read policy are unchanged and it rejects writer definitions. `RunWriterSubagentOptions = Omit<RunRestrictedSubagentOptions, "definition" | "policySnapshot"> & { definition: Extract<AgentDefinition, { capability: "writer" }>; policySnapshot: WriterPolicySnapshot; base: WriterBase }`. `runWriterSubagent(options: RunWriterSubagentOptions): Promise<SubagentRunnerOutcome>` in `writer-runner.ts` creates the actual workspace, starts the client, invokes the prepared SDK session with gateway tools, and drains execution before returning.

- [ ] **Step 1: Write failing parser/admission and real-SDK faux-provider tests.** Legacy roles remain read-only; writer needs explicit capability, trusted project, valid policy/backend/base/model. A second queued/running/stopping writer is rejected atomically without disturbing reader FIFO or consuming an invalid request's admission budget. Assert the existing two/four limits and per-turn budgets, cancellation during auth/queue/setup, nested cwd mapping, global instructions, physical model/provider/thinking inheritance, and native errors. A held fake drain must keep the slot/lease visibly `stopping` even after the model finishes. No writer tool executes on the parent filesystem; no indirect tool appears. Current-session ownership checks must safely return false for stale SDK contexts after every async gap.
```ts
it("rejects write tools without explicit writer capability", () => {
  const dir = join(f.parentCwd, ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "local-writer.md"), "---\nname: local-writer\ndescription: Local writer\ntools: [write]\n---\nImplement a bounded task.\n");
  const catalog = discoverAgentDefinitions({ cwd: f.parentCwd, agentDir: f.runDir, projectTrusted: true });
  expect(resolveAgentDefinition(catalog, "local-writer").ok).toBe(false);
});
```

- [ ] **Step 2: Run red.** `npm test -- test/subagents-writer-tool.test.ts test/subagents-writer-lifecycle.test.ts` plus new cases in `subagents-definitions`/`subagents-runs`.
- [ ] **Step 3: Implement the wrappers and capability.** Share only proven SDK lifecycle code, not the parent tool set. Keep fresh context, disabled compaction/cache warming/templates/extensions and usage single-counting. Derive the SDK tool exclusions from the approved capability: writer gateways must not be accidentally excluded by the old read-only Bash/Edit/Write bans, and indirect/native fallback tools must remain absent. Preserve parent cwd in the record; use workspace execution cwd for the child. Create worktrees only on scheduler start, revalidating pinned base/owner/deadline. Hold the writer reservation until genuine terminal settlement; return failed setup with a retained workspace reference where one exists. Update routing/conflict detection and conservatively mark the mixed `subagent` tool as potentially mutating (`readOnlyHint: false`); keep model-only exposure and existing parallel dispatch under scheduler limits. Bundled writer instructions forbid approval/test claims and explain missing dependencies/network/Git metadata limits. Only proven backends permit dispatch.
- [ ] **Step 4: Verify.** Run both new suites and `npm test -- test/subagents-sdk.test.ts test/subagents-runner.test.ts test/subagents-definitions.test.ts test/subagents-runs.test.ts test/subagents-tool.test.ts test/subagents-lifecycle.test.ts test/subagents-background.test.ts test/subagents-stop.test.ts`. Require foreground/background ownership and usage behavior to remain intact; use lifecycle conditions/fake clocks rather than fixed sleeps.
- [ ] **Step 5: Review the diff and request authorization for:** `feat: admit explicit writers through the existing subagent lifecycle`.

## Task 4: Safe Patch Artifacts and Runtime-Owned Evidence

**Files:** Create `ext/subagents/artifacts.ts`, `test/subagents-writer-artifacts.test.ts`; modify `writer-runner.ts`, `runs.ts`, `storage.ts`, `results.ts`, and their focused tests.

**Interfaces:**
- Consumes: settled workspace/client evidence from Task 3, pinned repository identity, and existing private atomic storage/report envelopes.
- `MAX_WRITER_PATCH_BYTES = 1024 * 1024` and `MAX_WRITER_CHANGED_FILES = 100` are named constants in `artifacts.ts`, not model-overridable settings.
- `WriterArtifact { path: string; sha256: string; baseCommit: string; bytes: number; files: Array<{ path: string; action: "add" | "modify" | "delete" }>; collectedAt: number }` belongs to `artifacts.ts`; paths in `files` are repository-relative.
- `collectWriterArtifact(options: { agentDir: string; record: Readonly<SubagentRunRecord>; workspace: WriterWorkspace; policy: WriterPolicySnapshot; exec: ExtensionAPI["exec"]; signal: AbortSignal }): Promise<WriterArtifact | undefined>` returns undefined for no changes, otherwise inspects eligible paths first and writes the bounded patch to the fixed private `changes.patch` path through storage's atomic writer. It includes allowed nonignored untracked files without staging the real index.
- `verifyWriterArtifact(artifact: WriterArtifact, workspace: WriterWorkspace): Promise<void>` validates pinned location, bytes/digest, metadata, allowed format and paths. It never accepts a model-provided arbitrary artifact path.
- Extend `record.writer` with optional `artifact: WriterArtifact`; commands remain trusted observations. Persisted legacy records remain readable.

- [ ] **Step 1: Write failing tests.** Pin exact 1 MiB/100-file boundaries; verify modified/new/deleted UTF-8 files are complete and unstaged, while binary, mode, symlink, submodule, path traversal and denied-content changes are refused before blob collection. An empty change set returns no artifact and an honest no-changes summary, not a usable empty patch. Cover malformed UTF-8, unusual/quoted filenames, tampered `.git` identity, artifact digest/metadata tampering, ignored generated files, cancellation during collection, and interrupted writes. Permissions are 0700 directories/0600 artifacts where supported; no overwrite through a substituted artifact symlink. Untrusted report/JSON text cannot forge `Workspace`, `Artifact`, `Integration`, `Verification`, or `Usage` fields.
```ts
it("pins patch limits independently from report or character limits", () => {
  expect(MAX_WRITER_PATCH_BYTES).toBe(1024 * 1024);
  expect(MAX_WRITER_CHANGED_FILES).toBe(100);
});
```

The required collection boundary tests above must also exercise accepted/rejected artifacts at these limits; constant assertions alone are not sufficient.

- [ ] **Step 2: Run red.** `npm test -- test/subagents-writer-artifacts.test.ts test/subagents-results.test.ts test/subagents-storage.test.ts`.
- [ ] **Step 3: Implement bounded collection and reporting.** Collect only after execution drains. Use safe Git diff flags and root-relative validated paths; include new files without a real-index `git add`. Reject whole artifacts on cap/format/policy failures, retain the workspace, and report incomplete/failed collection rather than a usable partial patch. Do not issue new collection operations with an already-aborted signal. Add actual command/cwd/exit/signal/cancellation/truncation metadata and separate worker completion, artifact availability, and not-applied status. Apply existing secret/diagnostic redaction to persisted/exposed command text; never log raw control frames. Unknown costs stay unknown; helper replies cannot add usage. Never label worktree evidence as parent-tree verification.
- [ ] **Step 4: Verify.** Run the three suites and `npm test -- test/subagents-writer-tool.test.ts test/subagents-writer-lifecycle.test.ts test/subagents-remote.test.ts`; assert failure/cancel paths retain workspace/evidence without publishing an unsafe artifact.
- [ ] **Step 5: Review the diff and request authorization for:** `feat: retain validated writer patches and observed command evidence`.

## Task 5: Explicit Apply and Checkpoint-Safe Mutation Guards

**Files:** Create `ext/_shared/writer-mutations.ts`, `ext/subagents/apply.ts`, `test/writer-mutations.test.ts`, `test/subagents-writer-apply.test.ts`, `test/subagents-writer-checkpoints.test.ts`; modify `workspace.ts`, `index.ts`, `runs.ts`, `ext/checkpoints/index.ts`, `test/registration.test.ts`, and `test/remote-http.test.ts` for registration/phone authorization coverage.

**Interfaces:**
- Consumes: Tasks 1–4, public command/UI APIs, `captureCheckpoint`, `restoreCheckpoint`, and existing `checkpoint-created` metadata.
- `WriterMutationOwner { cwd: string; sessionId: string; isCurrent(): boolean }` and `registerWriterMutationOwner(options: { cwd: string; sessionId: string; runId: string; stopAndDrain(): Promise<void> }): () => void` belong to the shared module. Its registry uses `sharedRef` across separately loaded extension module graphs, not one module-local variable.
- `withWriterRepositoryMutation<T>(owner: WriterMutationOwner, exec: ExtensionAPI["exec"], operation: () => Promise<T>): Promise<T>` acquires the checkout mutation lease, blocks new writer admission, drains only that owner's registered writers, rechecks ownership, runs the mutation, and releases only its own lease. Register each admitted writer using its scheduler handle; `stopAndDrain` requests cancellation and awaits `handle.completion`, not `cancelRun()`'s boolean.
- `assertWriterRepositoryAvailable(repository: WriterRepository): void` is used immediately before synchronous writer admission/start checks. Per-checkout lease identity derives from canonical checkout and common-Git paths.
- Serialize across cooperating Pi processes with an exclusive private lease directory under `<commonGitDir>/bluclawd/mutations/<sha256(checkoutRoot)>/`. Busy or stale leases refuse rather than wait indefinitely or automatically delete another holder's lock. A lease contains a random owner identity, not raw policy; normal release removes only the current operation's ephemeral lease. No PID-based takeover/kill. This is an implementation choice, not a claim of OS-wide locking against editors.
- `applyWriterArtifact(options: { pi: ExtensionAPI; ctx: ExtensionCommandContext; record: Readonly<SubagentRunRecord>; artifact: WriterArtifact; workspace: WriterWorkspace; isCurrent(): boolean }): Promise<WriterIntegrationOutcome>` in `apply.ts`; `WriterIntegrationOutcome { status: "not_applied" | "applied" | "failed"; safetyCheckpoint?: string; errorMessage?: string; parentVerification: "not_run" }` records the operation outcome without changing previously applied state on a refused repeated request. Extend `record.writer.integration` with that outcome.
- Extend `restoreCheckpoint` with an optional final owner argument while preserving existing positional arguments. Command callers supply current owner/context. Low-level ownerless calls cannot silently bypass an active writer/mutation guard; refuse when a safe owner cannot be established. Route the actual restore writes through the shared guard exactly once, not nested apply/restore locks.

- [ ] **Step 1: Write failing guard and integration tests.** Assert separate module graphs/processes contend on the same checkout lease; unrelated checkouts do not. Busy/stale locks never cause PID killing or forced takeover; substituted lease-directory symlinks are refused. Pause `stopAndDrain`: neither apply nor any code-only/pre-fork/rewind restore write may occur until it resolves. Do not stop another session's isolated writer. Aborted/throwing mutations release only their own ephemeral lease, not artifacts/worktrees. Refuse noninteractive/phone/model apply, wrong owner/origin/generation, already applied/incomplete/unsettled runs, missing/digest-changed artifacts, dirty/staged/base-drifted parents, denied paths, conflicts, ignored existing targets, and case-folding/symlink aliases. Confirmation cancellation must leave parent files/index untouched; session/base changes during confirmation must invalidate it. Checkpoint failure prevents `git apply` entirely.
```ts
it("does not expose artifact application to phone commands", () => {
  expect(phoneMayRun({ name: "subagent-apply", source: "extension" })).toBe(false);
});
```

- [ ] **Step 2: Run red.** `npm test -- test/writer-mutations.test.ts test/subagents-writer-apply.test.ts test/subagents-writer-checkpoints.test.ts`.
- [ ] **Step 3: Implement the guard and one user command.** Register `/subagent-apply <run-id>` once, TUI-confirmed only, never a model tool or remote command exception. Resolve artifact via the current owner's run references, not a caller path. Follow the spec's order: validate → preview/confirm → revalidate → acquire lease/drain → safety checkpoint → revalidate/check/apply. Call checkpoint capture with the safe Git executor, preserving only its trusted temp-index and fixed author/committer assignments. Use plain unstaged `git apply --check` and `git apply`; never `--3way`, `--reject`, force, commit, or reset. Derive attributable new artifact paths from actual before/after state, append `checkpoint-created`, and persist integration status. Do not attribute unrelated user-created files; preserve/report ambiguous new files after partial failure rather than claiming ownership and deleting them on recovery. Return explicit parent verification `not_run`.

Keep the existing checkpoint UI/user-file preservation logic; guard the actual restoring filesystem operations for all call paths, including code-only and pre-fork. Do not add a second dialog or an automatic restore after apply failure. On possible partial I/O failure, retain checkpoint/artifact and report the condition. Release the mutation guard before any later explicit rewind so it cannot deadlock on itself. Recheck stale contexts after every await. State plainly that unrelated editors/processes do not honor this lease.

- [ ] **Step 4: Verify focused behavior and real integration.** Run the three new suites plus `npm test -- test/checkpoints.test.ts test/checkpoints-double-escape.test.ts test/subagents-lifecycle.test.ts test/remote-http.test.ts test/registration.test.ts`. A real temporary repository scenario must apply modified/new/deleted files unstaged, run focused and regression local tests in the integrated parent tree, rewind, remove only agent-created files, and preserve user-created/ignored files, including a file independently created during an injected partial failure. Inject mid-application failure and verify no automatic rollback/reset/deletion. Existing non-writer checkpoint behavior and phone prohibition must stay green.
- [ ] **Step 5: Review the diff and request authorization for:** `feat: apply writer artifacts with user confirmation and checkpoint guards`.

## Task 6: End-to-End Acceptance and Honest Release Documentation

**Files:** Create `test/subagents-writer-acceptance.test.ts`; update `ext/subagents/writer-runner.ts` for final activation, `README.md`, this plan/predecessor status, `test/registration.test.ts`, `test/subagents-remote.test.ts`, and existing task/usage tests only where behavior changed. Change production task/remote renderers only if required to expose the new runtime-owned summary safely; do not add another UI or protocol surface speculatively.

**Interfaces:** Consumes all prior tasks; produces recorded release evidence and a documented supported/unsupported platform matrix. No new runtime abstraction.

- [ ] **Step 1: Write failing acceptance tests.** Use a deterministic public-SDK faux provider plus the real supported execution backend: write code/test fixtures, execute a test, preserve a patch, confirm application, test the integrated parent, and rewind. Cover background batching/holds, local and remote stop/output ownership, SDK disposal/session replacement, report escaping, unknown pricing, foreground single-counting, and separate background ledger. Assert one `subagent` tool, one new `subagent-apply` user command, and unchanged extension count; planned probe total is 12 extensions/11 commands. Prove unsupported backends cannot activate writer, even through custom definitions or mocked dependency-success checks. An entirely skipped real backend is not acceptance success.
```ts
it("keeps delegation unique and exposes apply only as a user command", () => {
  const registered = recordExtensions();
  expect(registered.subagents.tools).toEqual(["subagent"]);
  expect(registered.subagents.commands).toEqual(["subagent-apply"]);
  expect(Object.keys(registered)).toHaveLength(12);
});
```

- [ ] **Step 2: Run red.** `npm test -- test/subagents-writer-acceptance.test.ts test/registration.test.ts test/subagents-remote.test.ts`; diagnose substantive failures rather than weakening old assertions.
- [ ] **Step 3: Complete only required integration/docs.** Document capability frontmatter, clean/trusted/exact-base rules, missing dependencies and Git/network limits, artifact/workspace retention, human-only apply, checkpoint recovery, lease contention/stale-lock refusal, and separate worktree vs parent verification. Record actual OS/Node/sandbox evidence and every unrun platform/physical-phone/manual UI check. Keep M0–M2 live evaluation results historical; do not present faux-provider acceptance as new model-quality evidence. No additional live-model spend is required for these safety checks. If no reviewer tool is available, label the final review self-review, not independent.
- [ ] **Step 4: Run fresh release checks and read full outcomes.** `npm run typecheck`; `npm run lint`; `npm test`; `node --experimental-strip-types scripts/probe-extensions.ts`; `git diff --check`. Require zero failures/unhandled errors, unchanged read-only behavior, and all intended platform gates actually executed. Separately run named real backend/cleanup tests on every platform claimed as supported. Record counts/exit codes and disclose any skipped/manual checks rather than inferring success from silence.
- [ ] **Step 5: Enable only proven production backends.** After Steps 1–4 and all prior gates actually pass, change `WRITER_RELEASE_ENABLED` to true in `writer-runner.ts`; retain runtime backend/policy/base checks and explicit unsupported-platform refusal. Do not expose a user-configurable override or enable platforms whose proof skipped/failed.
- [ ] **Step 6: Re-run release verification on the enabled tree.** Repeat all Step 4 commands plus the real writer acceptance/backend suites without mocking the release constant for the supported end-to-end route. Record final counts/exit codes; any failure blocks release and requires a fix/recheck, not a completion claim. Update documentation with actual results and run diff checks again.
- [ ] **Step 7: Review the complete branch and request authorization for the final local commit:** `test: validate writer integration and document supported backends`. Retain the feature branch/workspaces; no push, merge, deployment, or destructive cleanup is included.

## Plan Self-Review and Handoff

- Spec coverage: backend/credentials/filesystem/process proof → Tasks 0/2; policy/workspace/Git restrictions → Task 1; capability/provider/admission/budgets → Task 3; truthful artifacts/evidence/accounting → Task 4; user authorization/checkpoints/concurrency → Task 5; acceptance/remote/regressions/documentation → Task 6.
- Dependency scan: shared SDK lifecycle is introduced only when both runners need it. Writer tool names are defined before policy/protocol/parser consumers. Artifact/integration types extend run metadata only in their owning tasks. No provider serialization, second runner backend, auto cleanup, or model apply endpoint is introduced.
- Type scan: existing public imports from `runner.ts` stay valid via re-exports; old definitions/records default to read-only; parent `record.cwd` remains distinct from `workspace.executionCwd`; all later references use the exact interface names above.
- Review Focus: each of the five cases is assigned concrete tests in its owning task. Lease/refusal and unsupported backend outcomes are intentional, not excuses to mark unexecuted safety proofs complete.
- Builder calls: refuse sparse/index-suppressed/filter/LFS cases initially; use a private cross-process lease with no automatic stale takeover; keep apply TUI-only initially; choose native execution as preserved by the approved design. These do not relax the approved boundaries.
- Current verification is documentation-only. Test commands above are planned commands, not claims that M3 has been implemented or tested.

After the user reviews this plan, execute natively with `executing-plans` in an isolated workspace prepared through `using-git-worktrees`. Preserve/carry the approved spec and this plan together; do not discard the current documentation changes. Stop at Task 0's safety gate if proof fails, even if later tasks are otherwise implementable. Obtain authorization before planned local commits. Re-check availability of an independent reviewer before final release; never fabricate a reviewer when no tool exists.
