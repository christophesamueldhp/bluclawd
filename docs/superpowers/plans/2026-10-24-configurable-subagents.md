# Configurable Subagents and Hybrid Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, natively in the current session. Use checkbox steps for tracking; obtain plan review before implementation.

**Goal:** Deliver configurable general-purpose/explorer/reviewer roles with capability-based workspace isolation, real verification evidence, and safe parent integration.

**Architecture:** Pure readers retain the existing shared read-only runner. Shell/write agents use a fresh parent-side SDK conversation whose tools execute through a sandbox-owning subprocess in a unique workspace. Build each workspace from a pinned, policy-filtered source snapshot, not an implicit branch or HEAD-only checkout; integrate only the agent's delta with checkpoint protection.

**Tech Stack:** Existing TypeScript/ES modules, public Pi SDK, Node processes/private pipes, Git, sandbox-runtime `0.0.81`, Vitest, and existing npm scripts/lockfile. No new dependencies or manifests.

**Spec:** `docs/superpowers/specs/2026-10-24-configurable-subagents-design.md` — approved by the user.

**Baseline:** M0–M2 commit `519889c`. The old `2026-10-24-subagent-writer.md` plan is superseded, not a second implementation track.

**Status:** The user approved the plan and authorized execution of Tasks 0–1 only. Their configuration/snapshot implementation is verified in the isolated `feat/configurable-subagents` checkout, and the user authorized the two local development commits. The macOS execution backend remains blocked. Passing Tasks 0–1 does not authorize Bash/write activation; Task 2 remains a hard gate before Task 3.

## Global Constraints

- Built-ins are exactly `general-purpose`, `explorer`, and `reviewer` after activation; no separate bundled writer/worker/planner. Role names never determine privilege.
- General-purpose explicitly selects `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`; explorer selects the four read/search tools; reviewer selects the four plus Bash. Reviewer verifies and reports, not automatically fixes/integrates.
- Markdown custom names, descriptions, instructions, supported tool subsets, models, and lower turn limits remain extensible without core changes. Omitted tools preserve legacy read/search-only behavior.
- Preserve trusted project > user > bundled precedence, frozen catalogs, `/reload`, unsupported-field diagnostics, and existing bounds: 32 custom definitions, 32 KiB definition, 512-character description, 32 KiB task input.
- No new `capability`, `permissionMode`, or isolation override field is needed for this scope. Derive shared/isolated execution from actual supported tools; unknown tools fail closed. Do not advertise format/feature parity with other harnesses.
- Isolated shell/write dispatch requires a trusted project; recheck this before source capture and execution. Shared read-only runs retain existing untrusted-project behavior and global instructions.
- Effective capability never exceeds parent policy/backend support. No arbitrary extensions, MCP, web/browser tools, hooks, virtual routers, or nested delegation are added.
- Each shell/write invocation has its own workspace, including two instances of the same role. Shared readers retain drift warnings; shared does not mean frozen.
- Preserve nested cwd, owner/session/generation/origin-branch fences, private storage, foreground usage single-counting, separate background ledger, and authorized task/remote controls.
- Keep two active/four queued runs, five-minute deadline from admission including queueing, 12 turns/40 calls/100k reported tokens per run, and six runs/300k reported child tokens per parent turn. Multiple isolated runs may occupy the two slots; do not revive the old one-writer reservation.
- Retain 32 KiB tool output, 8 KiB parent report, and 256 KiB transport-frame bounds. Preserve the earlier conservative artifact bounds: 1 MiB patch and 100 changed files; reject unsupported binary/symlink/submodule/mode changes instead of publishing an incomplete patch.
- Snapshots include the selected review state, including in-scope staged/unstaged/untracked changes. Never silently substitute HEAD, ignore parent edits, modify the user's index, or commit onto the user's branch.
- Workspaces are not OS sandboxes. Protect the parent, other runs, original Git metadata, credentials and external services; arbitrary test code must stay within the execution boundary. Full tool execution, including search subprocesses, must not fall back to parent filesystem operations.
- No automatic merge, user-branch commit, stash, reset, push, deployment or workspace deletion. Runtime-only private snapshot commits are storage metadata, not source-branch history changes. Parent application requires explicit authorization, ownership/artifact/preimage checks, serialization and safety checkpoints. No automatic rollback over concurrent user work.
- The retained macOS detached/double-fork/owner-EOF failures are unresolved. Do not skip/xfail them, infer support from dependency checks, or enable a new backend, VM, privileged helper, dependency, or weaker lifecycle contract without user approval.
- Keep production extended dispatch disabled through Task 5. A test-only release-gate mock is not backend proof. Unsupported execution must fail explicitly, never masquerade as successful static verification.
- English artifacts; public Pi APIs only; do not alter Pi internals or `strict: false`. Every task runs its named tests plus typecheck, lint, diff checks, and the full project suite before completion. Report any separately retained red gate as red. Ask before planned local commits; no push/merge/cleanup is included.

## Review Focus

1. **Partial staging and dirty targets:** reviewer must see the actual index/working files, and integration must not reapply the parent's pre-existing changes. Tasks 1/4/5 pin all three views.
2. **Hidden authority through names/tools:** arbitrary custom names, overrides, missing tools and unknown effects cannot widen capabilities or select a shared workspace for Bash. Tasks 0/3 pin behavior rather than role-name strings.
3. **Source and Git leakage:** denied files/history, executable Git configuration, symlink substitutions and nested cwd must not leak into a private snapshot or redirect execution to the parent. Tasks 1/2 cover actual contents and effects.
4. **Verification that changes state:** tests can modify source, caches, ports and databases, and exit zero before later edits. Tasks 2/4/6 distinguish command evidence, snapshot revision, side effects and parent verification.
5. **Concurrent capture/apply/rewind/cancellation:** ownership changes, same-role parallel runs, stale locks, ignored-file collisions and partial failure must not overwrite user work or release live resources. Tasks 1/3/5/6 cover them.

---

## File Map and Execution Order

| Task | Production files | Tests |
| --- | --- | --- |
| 0 | Modify `ext/subagents/definitions.ts`, `ext/subagents/index.ts`; create `ext/subagents/execution-policy.ts` | Extend `test/subagents-definitions.test.ts`, `test/subagents-tool.test.ts`; create `test/subagents-execution-policy.test.ts` |
| 1 | Create `ext/subagents/source-snapshot.ts`, `ext/subagents/workspace.ts` | Create `test/helpers/subagent-fixture.ts`, `test/subagents-source-snapshot.test.ts`, `test/subagents-workspaces.test.ts` |
| 2 | Test-only feasibility; no production activation | Port the retained controller/descendant proof into `test/subagents-execution-backend.test.ts` and `test/fixtures/subagent-execution/`; add complete tool-boundary probes only after cleanup is proven |
| 3 | Create `ext/subagents/{session,execution-protocol,execution-controller,execution-tool-host,execution-client,isolated-runner}.ts`; modify runner/policy/runs/index | Create `test/subagents-execution-protocol.test.ts`, `test/subagents-isolated-runner.test.ts`, `test/subagents-hybrid-lifecycle.test.ts`; retain M0–M2 regressions |
| 4 | Create `ext/subagents/artifacts.ts`; modify isolated runner, runs, results, storage | Create `test/subagents-artifacts.test.ts`; extend results/storage/remote tests |
| 5 | Create `ext/_shared/subagent-mutations.ts`, `ext/subagents/apply.ts`; modify workspace/index/runs/checkpoints | Create `test/subagent-mutations.test.ts`, `test/subagents-apply.test.ts`, `test/subagents-hybrid-checkpoints.test.ts`; extend checkpoint/phone/registration tests |
| 6 | Add `ext/subagents/agents/general-purpose.md`; update reviewer prompt, release gate, README/status docs | Create `test/subagents-hybrid-acceptance.test.ts`; finalize registration/task/usage/remote coverage |

Tasks 0–1 are safe foundations, not a partially released shell agent. Existing bundled reviewer remains read-only until final activation; do not silently remove its working functionality during staging. Do not modify/delete the historical failed proof in its retained checkout. At Task 2, bring the real counterexamples into this plan's gate explicitly; a green metadata/snapshot suite does not supersede them.

## Task 0: Extensible Definitions and Capability-Derived Policy

**Files:** Modify `ext/subagents/definitions.ts`, `ext/subagents/index.ts`, `test/subagents-definitions.test.ts`, `test/subagents-tool.test.ts`; create `ext/subagents/execution-policy.ts`, `test/subagents-execution-policy.test.ts`.

**Interfaces:**
- Preserve `ALLOWED_SUBAGENT_TOOLS` and `AllowedSubagentTool` as the existing four-tool ceiling for the read-only policy/runner.
- Add `SUPPORTED_SUBAGENT_TOOLS` (the seven tools in Global Constraints), `SupportedSubagentTool`, `SubagentWorkspaceMode = "shared" | "isolated"`, and `workspaceModeForTools(tools: readonly SupportedSubagentTool[]): SubagentWorkspaceMode` in `definitions.ts`. Validate at runtime, including callers with malformed values.
- Extend parsed `AgentDefinition` with derived `workspaceMode` and broader `tools`; no user-controlled mode field. Default omitted tools to the legacy four. Preserve string-based catalog resolution and all existing frontmatter bounds.
- Add internal `EXTENDED_SUBAGENTS_RELEASED = false` in `definitions.ts`, not settings/environment. `index.ts` rejects isolated dispatch before auth/model/capture/admission while false. Do not change bundled role files yet.
- `execution-policy.ts` owns branded/frozen `IsolatedSubagentPolicySnapshot { cwd: string; denyRules: readonly string[]; allowedTools: readonly SupportedSubagentTool[] }`, `createIsolatedSubagentPolicySnapshot(options: { cwd: string; denyRules: readonly string[]; allowedTools: readonly SupportedSubagentTool[] }): { ok: boolean; snapshot?: IsolatedSubagentPolicySnapshot; error?: string }`, and its `isValidIsolatedSubagentPolicySnapshot(value: unknown): value is IsolatedSubagentPolicySnapshot` predicate. Reject invalid/shared-only inputs; retain execution-time deny checks and read-denied output filtering. Keep the existing read policy's ceiling unchanged.

- [x] **Step 1: Write failing behavior tests.** Cover arbitrary custom names and trusted overrides with seven-tool subsets; omitted tools, invalid tools/fields/models, frozen policy copies and parent delegation denies. Assert Bash/Edit/Write always require isolated mode regardless of name. The staged release gate refuses before a child/model/run is created. Existing reviewer/explorer remain usable.

```ts
it("isolates Bash even without edit tools", () => {
  expect(workspaceModeForTools(["read", "bash"])).toBe("isolated");
  expect(workspaceModeForTools(["read", "grep"])).toBe("shared");
});
```

- [x] **Step 2: Observe red.** `npm test -- test/subagents-definitions.test.ts test/subagents-execution-policy.test.ts test/subagents-tool.test.ts`. Expected: missing new behavior/exports, not test syntax/setup failures.
- [x] **Step 3: Implement the named interfaces and admission guard.** Do not widen `SubagentReadPolicySnapshot`, register a general-purpose role, or expose isolated tools yet. Adapt only affected read-only call sites/types with runtime narrowing; do not use broad casts to bypass the old ceiling.
- [x] **Step 4: Verify.** Re-run the three suites, then `test/subagents-policy.test.ts`/`test/subagents-runner.test.ts`, full `npm test`, typecheck/lint/diff checks. The current external macOS proof remains explicitly red and blocks isolated execution.
- [x] **Step 5: Review and request authorization for:** `feat: classify configurable subagents by supported capabilities`. Authorization received; commit recorded in the execution ledger.

## Task 1: Exact Source Views and Independent Per-Run Git Workspaces

**Files:** Create `ext/subagents/source-snapshot.ts`, `ext/subagents/workspace.ts`, `test/helpers/subagent-fixture.ts`, `test/subagents-source-snapshot.test.ts`, `test/subagents-workspaces.test.ts`.

**Interfaces:**
- Consumes Task 0 policy and public argument-vector Git execution. Follow existing checkpoint temporary-index patterns where applicable, but do not assume `captureCheckpoint()` already filters denied content or preserves staging as a separate view.
- `RepositoryIdentity { cwd: string; root: string; commonGitDir: string }` and `resolveRepositoryIdentity(cwd: string, exec: ExtensionAPI["exec"], signal?: AbortSignal): Promise<RepositoryIdentity>` in `workspace.ts`; resolution alone does not require a clean tree.
- `createSafeGitExec(exec: ExtensionAPI["exec"], repository: RepositoryIdentity): ExtensionAPI["exec"]` preserves a validated caller cwd within that repository, disables executable Git features, scrubs Git overrides, and preserves only trusted temporary-index/fixed-identity assignments used by checkpoint calls. Source enumeration must still honor ignore rules without copying user configuration into child Git.
- `SourceSnapshot { snapshotId: string; parentSessionId: string; runtimeGeneration: number; originEntryId?: string; repository: RepositoryIdentity; sourceHead: string; sourceFingerprint: string; baseTree: string; indexTree: string; worktreeTree: string; repoDir: string }` in `source-snapshot.ts`. Trees belong to the private filtered repository, not the source object store.
- `captureSourceSnapshot(options: { agentDir: string; parentSessionId: string; runtimeGeneration: number; originEntryId?: string; policy: IsolatedSubagentPolicySnapshot; exec: ExtensionAPI["exec"]; signal: AbortSignal; isCurrent(): boolean }): Promise<SourceSnapshot>` captures before admission, under a runtime UUID/private snapshot directory. Bound pre-admission preparation per parent runtime to two active captures/four waiting requests and 30 seconds including waiting; reject overflow before Git/file work. Recheck ownership after awaits. These bounded trusted preparation jobs do not create child SDK sessions or consume a run slot on failure.
- `SourceSnapshotRef` is the persisted subset: snapshot ID, source HEAD/fingerprint and three tree IDs. `readSourceSnapshot(agentDir: string, owner: string, snapshotId: string): SourceSnapshot` resolves validated fixed storage, never a model path.
- `IsolatedWorkspace { runId: string; root: string; gitDir: string; scratchDir: string; executionCwd: string; source: SourceSnapshotRef }` and `createIsolatedWorkspace(options: { runId: string; runDir: string; source: SourceSnapshot; exec: ExtensionAPI["exec"]; signal: AbortSignal; isCurrent(): boolean }): Promise<IsolatedWorkspace>` in `workspace.ts`.
- `captureWorkspaceTree(options: { workspace: IsolatedWorkspace; policy: IsolatedSubagentPolicySnapshot; exec: ExtensionAPI["exec"]; signal: AbortSignal }): Promise<string>` in `source-snapshot.ts` records an eligible private working tree through a trusted temporary index; Tasks 3/4 reuse it for command/final-tree observations.
- Test helper `createSubagentFixture()` returns `{ parentCwd, stateDir, exec: ExtensionAPI["exec"], cleanup(): Promise<void> }` for a temporary committed Git repository; tear it down in `afterEach`, never touching user repositories/artifacts.

**Pinned materialization method (assistant implementation choice):** use a standalone private Git workspace rather than expose the original linked worktree's common object store. This costs extra snapshot/storage work but permits local `git diff` without giving arbitrary shell access to parent history or denied blobs. It is filesystem preparation, not a new execution backend. Original branch history/blame/remote refs are not present: review targets requiring those need an explicitly supplied diff/context or a clear missing-base blocker. An empty local diff must not be reported as a clean review of an unavailable branch/PR target.

1. Resolve canonical repository/nested cwd and validate source Git state/configuration without running hooks, fsmonitor, filters, external diffs/textconv or submodule commands. Honor source ignore semantics; do not import its config into the private repository. Refuse unmerged, sparse/index-suppressed, intent-to-add, symlink inputs, active filter/LFS or submodule cases initially rather than misrepresent them.
2. Enumerate HEAD, index, and working files using NUL-safe paths. Evaluate read policy and node types before collecting bytes. Include eligible nonignored untracked files; exclude ignored credentials/dependencies and denied paths from **all three views**. Do not copy the original `.git`, history, remotes, alternates, hooks, hardlinks or user configuration.
3. Build a runtime-owned private Git object store with exact permitted file bytes/modes for base/index/current-working trees. Use raw blob insertion without filters; keep binary files that are unchanged input resources, while later binary modifications remain unsupported artifacts. Validate file identity and source fingerprint before/after capture; source changes mid-capture cause a clear refusal, not a mixed snapshot.
4. Copy only that private Git data into each run's own `.git`, with a runtime snapshot commit for the filtered HEAD/base tree. This does not commit onto the user's branch. Materialize working-tree bytes directly from `worktreeTree`, then set only the private index to `indexTree`. `git diff` and `git diff --cached` must reflect the selected source state, including partial staging.
5. Set `root = <runDir>/workspace`; preserve the source cwd relative to its repository root in `executionCwd`. Keep scratch/home/temp separate from snapshot/transcript/artifact state. On macOS use a runtime-owned short private temp root so sandbox Unix socket paths fit; store its identity and never silently use shared writable `/tmp` as the whole policy.
6. The execution sandbox later permits reading this private Git data for inspection but denies its mutation, source checkout/admin metadata access, and other runs. Retain immutable snapshot data outside model-writable directories. Initialization/storage errors preserve identified partial state and never reset/delete parent work.

- [x] **Step 1: Write failing real-Git tests.** Cover dirty staged/unstaged/untracked state, partial staging, nested cwd, deleted/new files, unusual names, unchanged binary resources, CRLF bytes and denied content hidden in source history. Assert parent branch/index/files remain unchanged; private Git has no source remotes/history/alternates. Two runs of one role get independent files/Git/scratch. Test unsafe Git hooks/filters, symlink substitution, disk/capture interruption, preparation overflow/timeouts and ownership changes during capture/setup. A seventh simultaneous preparation must fail before spawning Git/file work, rather than bypass the agent bounds with unbounded preflight copies.

```ts
it("keeps staged and unstaged review views distinct", async () => {
  expect(privateCachedDiff).toContain("staged change");
  expect(privateWorkingDiff).toContain("unstaged change");
  expect(parentIndexAfter).toEqual(parentIndexBefore);
});
```

The diff/index variables above must come from real Git commands and literal fixture contents, not a snapshot helper computing its own expected result.

- [x] **Step 2: Observe red.** `npm test -- test/subagents-source-snapshot.test.ts test/subagents-workspaces.test.ts`. Expected: missing snapshot/workspace behavior.
- [x] **Step 3: Implement the named interfaces and materialization algorithm.** Stream bounded operations under deadlines/abort signals; fail safely on insufficient storage. Capture before admission so queueing cannot change the selected state. Generate paths from trusted IDs only; preserve 0700 directories/0600 manifests where supported. Do not register executable tools or copy secrets/dependencies to make tests pass.
- [x] **Step 4: Verify.** Run both suites and `test/checkpoints.test.ts`, full project tests and static/diff checks. Demonstrate a reviewable dirty source without a user-branch commit/stash/index change. This is preparation proof, not shell containment proof.
- [x] **Step 5: Review and request authorization for:** `feat: prepare pinned private source views for isolated subagents`. Authorization received; commit recorded in the execution ledger.

## Task 2: Resolve the Execution Backend Feasibility Gate

**Files:** Create `test/subagents-execution-backend.test.ts`, `test/fixtures/subagent-execution/{probe-controller,descendants,tool-host}.mjs` as needed. Use Task 1's fixture helper. Preserve the historical proof unchanged in the old isolated checkout.

**Interfaces:**
- Consumes: real installed SDK/sandbox APIs and the historical counterexamples at `.superpowers/sdd/2026-10-24-subagent-writer/checkout/test/subagents-writer-backend.test.ts` and its fixture sources.
- Produces: a supported/unsupported matrix with exact OS/Node/SDK/sandbox versions and observed outcomes. No JSON flag or mocked dependency-success result is proof of support.

- [ ] **Step 1: Port the real failing boundary assertions without weakening them.** Assert no owned descendant executes after cancellation, timeout, command completion or owner loss, including inherited stdio, new-session/detached and double-fork cases. Use finite fixture lifetimes and observed identity/heartbeat evidence, not unsafe kills based only on stored PIDs.

```ts
it("does not declare settlement while an adopted child is still writing", async () => {
  expect(writesObservedAfterControllerExit).toEqual([]);
});
```

- [ ] **Step 2: Reconcile red with retained evidence.** Run `npm test -- test/subagents-execution-backend.test.ts`. Expected on the unchanged tested macOS composition: the three retained detached/adopted assertions fail. Recognize that result as a blocker, not a reason to xfail, skip, or repeatedly rerun for green.
- [ ] **Step 3: Evaluate the smallest supported correction.** Inspect public backend mechanisms; test a real correction only if available without a new dependency/backend/privilege contract. Do not substitute process-name scanning, prompt prohibitions or group-kill heuristics for reliable ownership. If no admissible correction exists, record Task 2 blocked and ask for the specific new backend or changed lifecycle authorization before Task 3. Neither metadata/snapshot approval nor role renaming grants that authorization.
- [ ] **Step 4: Require the complete real gate before proceeding.** After cleanup is genuinely proven, run complete public file/search helpers plus Bash under the candidate boundary. Test parent/sibling writes, original Git redirects/objects, denied reads, runtime carve-outs, symlink races, private temp allowances, malicious-looking control output, and fixture-owned loopback/Unix-socket network endpoints. Parent sandbox/configuration and concurrent parent activity must remain unchanged. Run this on every platform to be enabled; a fully skipped platform is unsupported. Read actual full-suite/static outcomes; no new live model spending is needed.
- [ ] **Step 5: Only after a passing gate, review evidence and request authorization for:** `test: establish isolated subagent execution support`. If blocked, keep the red evidence and stop; do not mark this task complete or create a pretend success commit.

## Task 3: Subprocess Execution and the Existing SDK/Scheduler Lifecycle

**Files:** Create `ext/subagents/{session,execution-protocol,execution-controller,execution-tool-host,execution-client,isolated-runner}.ts`; modify `runner.ts`, `execution-policy.ts`, `runs.ts`, `index.ts`; create `test/subagents-execution-protocol.test.ts`, `test/subagents-isolated-runner.test.ts`, `test/subagents-hybrid-lifecycle.test.ts`; adapt only affected typed fixtures in `test/subagents-runner.test.ts`.

**Interfaces:**
- Consumes Tasks 0–2. No production execution support before Task 2 passes.
- `execution-protocol.ts` owns protocol version 1 and 256 KiB frame/32 KiB input limits. `ExecutionFrame` uses controller-owned request IDs and validated `init`, `execute`, `stop`, `ready`, `result`, `stopped`, `error` unions. Init carries only workspace identity and plain policy values; never credentials/history/JSON trust flags. Raw subprocess output stays encoded data, not control frames.
- `CommandEvidence { command: string; cwd: string; sourceSnapshotId: string; beforeTree: string | null; afterTree: string | null; startedAt: number; endedAt: number; exitCode: number | null; signal?: string; cancelled: boolean; truncated: boolean }` belongs to that module. Trees are trusted policy-filtered observations before/after command settlement; null means unknown, never verified.
- `buildExecutionSandboxConfig(policy: IsolatedSubagentPolicySnapshot, workspace: IsolatedWorkspace, runtimeReadPaths: readonly string[]): SandboxRuntimeConfig` in `execution-policy.ts` compiles scoped OS restrictions from trusted fixed runtime paths and frozen policy; definitions/arguments cannot widen them. Default child command networking is disabled; missing dependency/setup is a blocker, not permission to copy credentials/dependencies or fetch/install them silently.
- `checkExecutionBackendSupport(): Promise<{ status: "ready" | "unavailable"; platform: NodeJS.Platform; reason?: string }>` in `execution-client.ts` checks the actual runtime against the proven backend matrix plus public dependency/initialization checks. A user/config JSON flag cannot add a proven platform.
- `startIsolatedExecution(options: { workspace: IsolatedWorkspace; policy: IsolatedSubagentPolicySnapshot; signal: AbortSignal }): Promise<ExecutionClient>`. The client exposes `execute(tool: SupportedSubagentTool, input: Record<string, unknown>, signal?: AbortSignal): Promise<ExecutionToolResult>`, `stopAndDrain(): Promise<void>`, and `commandEvidence(): readonly CommandEvidence[]`.
- `ExecutionToolResult` preserves JSON-safe text/image content, optional tool details, and `isError`; it cannot supply SDK usage, verification, owner or integration fields. Bound the complete exposed result, not just one text block; do not truncate an image into invalid data.
- `createIsolatedToolDefinitions(client: ExecutionClient, workspace: IsolatedWorkspace, policy: IsolatedSubagentPolicySnapshot): ToolDefinition[]` returns gateways only. `createIsolatedPolicyExtension(policy: IsolatedSubagentPolicySnapshot, workspace: IsolatedWorkspace): ExtensionFactory` enforces allowed names/denies/rebased paths and filtering at execution.
- Move shared SDK execution/model/snapshot/diagnostic helpers into `session.ts`; preserve imports from `runner.ts` through re-exports. `RunPreparedSubagentSessionOptions = Omit<RunRestrictedSubagentOptions, "definition" | "policySnapshot"> & { definition: AgentDefinition; executionCwd: string; approvedTools: readonly ToolDefinition[]; policyExtension: ExtensionFactory }`; `runPreparedSubagentSession(options: RunPreparedSubagentSessionOptions): Promise<SubagentRunnerOutcome>` owns existing SDK settlement/usage logic.
- `RunIsolatedSubagentOptions = Omit<RunRestrictedSubagentOptions, "policySnapshot"> & { policySnapshot: IsolatedSubagentPolicySnapshot; source: SourceSnapshot; exec: ExtensionAPI["exec"] }`; `runIsolatedSubagent(options: RunIsolatedSubagentOptions): Promise<SubagentRunnerOutcome>` prepares the per-run workspace, invokes the shared SDK with gateways, then drains execution before returning. The read-only wrapper still rejects shell/write tools.
- Add optional `workspaceMode` to admission/records (legacy omission means shared). `record.isolation` holds source ref, optional workspace, and commands. `SubagentRunController.recordIsolation(update: { source?: SourceSnapshotRef; workspace?: IsolatedWorkspace; commands?: readonly CommandEvidence[] }): void` publishes trusted metadata; later tasks extend that record only with their owned artifact/integration types.

- [ ] **Step 1: Write failing protocol and real-SDK faux-provider tests.** Cover fragmented UTF-8/oversized frames, wrong IDs/versions, spoofed evidence/usage, raw-output termination, `isError`, stdout/stderr sanitization and no secret environment inheritance. Execute complete read/search/write/edit operations in the sandboxed helper; grep's operations override alone does not wrap its ripgrep spawn. Exercise two same-role isolated runs concurrently, shared-reader denial, trusted-project checks, auth/capture/queue/setup/session races and a held drain that keeps `stopping` and both run ownership/slot intact.

```ts
it("does not free a run slot before execution is drained", async () => {
  expect(runDuringHeldDrain.status).toBe("stopping");
  expect(activeSlotsDuringHeldDrain).toBe(2);
  expect(parentTrackedText).toBe("original\n");
});
```

- [ ] **Step 2: Observe red.** `npm test -- test/subagents-execution-protocol.test.ts test/subagents-isolated-runner.test.ts test/subagents-hybrid-lifecycle.test.ts`.
- [ ] **Step 3: Implement the named controller/gateway/session interfaces.** One controller and immutable sandbox configuration per run; never reconfigure the parent's singleton. Scrub credentials, Git overrides, Node/shell startup settings; use private home/temp. Set trusted Git inspection defaults (`GIT_OPTIONAL_LOCKS=0`, no global/system config or prompts, fixed pager) against the private repository, without importing source config. Execute Bash through the proven wrapper/local operations so command exit is observed outside model-selected code; run file/search helpers inside the same OS boundary. Serialize a run's operations within the existing 40-call bound; clamp tool timeouts to the remaining deadline. Record trusted before/after source trees for each Bash operation; later edits invalidate applicability of earlier successful command evidence. Revalidate policy/workspace/frame input, not just parent SDK arguments. Cooperative abort plus bounded escalation is not settlement until observed. Keep fresh contexts, inherited supported model/thinking, disabled compaction/cache warming/arbitrary resources, global instructions and SDK single-counted usage.

Wire source capture before atomic admission, then carry its exact ref through queue/start. Keep parent `record.cwd` separate from isolated `executionCwd` so a run's own writes are not mislabeled parent drift. Do not add a one-writer global reservation. Update mixed-tool annotations conservatively and route by derived mode; maintain the false release guard for real users. Tests may mock only that staging guard, not substitute mocks for backend proof.

- [ ] **Step 4: Verify.** Run the three suites, Task 2's real gate, and existing SDK/runner/runs/tool/lifecycle/background/stop/policy suites; run full tests/static checks. Require known backend counterexamples and parent/checkpoint boundaries to remain covered. Use readiness/terminal conditions, not fixed sleeps.
- [ ] **Step 5: Review and request authorization for:** `feat: run isolated subagents through owned execution subprocesses`.

## Task 4: Agent-Only Deltas and Truthful Verification Reports

**Files:** Create `ext/subagents/artifacts.ts`, `test/subagents-artifacts.test.ts`; modify isolated runner/runs/results/storage; extend `test/subagents-results.test.ts`, `test/subagents-storage.test.ts`, `test/subagents-remote.test.ts`.

**Interfaces:**
- Consumes immutable source/workspace/evidence from Tasks 1/3 and existing private storage/envelopes.
- `SubagentArtifact { runId: string; parentSessionId: string; path: string; sha256: string; source: SourceSnapshotRef; finalTree: string; bytes: number; files: Array<{ path: string; action: "add" | "modify" | "delete"; beforeHash: string | null; beforeMode: string | null }>; collectedAt: number }` in `artifacts.ts`; paths are repository-relative.
- `collectSubagentArtifact(options: { agentDir: string; record: Readonly<SubagentRunRecord>; source: SourceSnapshot; workspace: IsolatedWorkspace; policy: IsolatedSubagentPolicySnapshot; exec: ExtensionAPI["exec"]; signal: AbortSignal }): Promise<SubagentArtifact | undefined>` returns no artifact for no changes; stores a complete bounded patch at the fixed private `changes.patch` path otherwise.
- `verifySubagentArtifact(artifact: SubagentArtifact, source: SourceSnapshot, record: Readonly<SubagentRunRecord>): Promise<void>` verifies artifact run/owner/source against the record, fixed owner/run-derived location, format, bytes/digest and metadata. Add optional artifact to `record.isolation`; reuse storage's private atomic writes, not a second persistence framework.

- [ ] **Step 1: Write failing real-Git/report tests.** With a pre-existing dirty parent change plus a child change, assert the patch includes only the latter. Cover new/deleted files, exact byte/file limits (1 MiB/100), empty deltas, untracked/ignored artifacts, binary/mode/symlink/submodule refusal, denied paths before blob collection, corruption/tampering and cancellation/storage failures. Shell output/worker prose cannot forge snapshot, command result, artifact, integration or usage. A reviewer test that generates source changes must be reported, not silently merged or described as no changes. A successful command followed by another edit must not mark the final artifact tree verified.

```ts
it("does not reapply the parent's pre-existing dirty changes", async () => {
  expect(addedPatchLines).toEqual(["+child-only change"]);
  expect(parentTrackedTextAfterCollection).toBe(parentTrackedTextBeforeCollection);
});
```

Use a literal one-line dirty parent fixture and an appended child line; derive `addedPatchLines` from raw patch added lines, excluding file headers. Unchanged parent text may legitimately appear as diff context and must not be rejected merely for appearing in the patch.

- [ ] **Step 2: Observe red.** `npm test -- test/subagents-artifacts.test.ts test/subagents-results.test.ts test/subagents-storage.test.ts`.
- [ ] **Step 3: Implement complete collection and runtime-owned reporting.** Compare final eligible child files against **source.worktreeTree**, not private HEAD/baseTree/indexTree, to compute the agent's delta. Use a trusted temporary index outside model-writable directories; collect only after SDK/tools/descendants drain. Inspect allowed changed names before content, include permitted nonignored new files without staging parent files, refuse whole artifacts on unsupported/over-limit changes, and preserve work on failure. Reports distinguish worker execution, verification commands/side effects, artifact availability and unapplied integration. Redact stored/exposed command diagnostics; never log raw control frames. Compare command tree observations to the final artifact tree, disclose source changes during/after verification, and mark stale/unknown evidence rather than claiming final-tree success. Command exit zero and agreement between agents are not proof of final or integrated correctness. Keep foreground/background accounting unchanged; unknown prices remain unknown.
- [ ] **Step 4: Verify.** Run the three suites, isolated runner/lifecycle tests and remote tests, then full/static checks. Inspect actual artifact content, private permissions and failure retention; never count an unsafe partial patch as complete.
- [ ] **Step 5: Review and request authorization for:** `feat: retain isolated deltas and runtime verification evidence`.

## Task 5: Concurrent Parent Integration and Checkpoint Guards

**Files:** Create `ext/_shared/subagent-mutations.ts`, `ext/subagents/apply.ts`, `test/subagent-mutations.test.ts`, `test/subagents-apply.test.ts`, `test/subagents-hybrid-checkpoints.test.ts`; modify `workspace.ts`, `index.ts`, `runs.ts`, `ext/checkpoints/index.ts`, `test/registration.test.ts`, `test/remote-http.test.ts`.

**Interfaces:**
- Consumes Tasks 1/3/4, `captureCheckpoint`, `restoreCheckpoint`, `checkpoint-created`, and public command contexts.
- `MutationOwner { cwd: string; sessionId: string; isCurrent(): boolean }`, `registerIsolatedRun(options: { repository: RepositoryIdentity; sessionId: string; runId: string; stopAndDrain(): Promise<void> }): () => void`, and `withSubagentRepositoryMutation<T>(owner: MutationOwner, exec: ExtensionAPI["exec"], operation: () => Promise<T>): Promise<T>` belong to the shared module. Use `sharedRef` across extension module graphs; drain callbacks request stop and await the scheduler handle's completion, not its cancellation boolean.
- Acquire an exclusive 0700 per-checkout lease under `<commonGitDir>/bluclawd/mutations/<sha256(root)>/`, validating directory identity/no symlink substitution. Busy/stale leases refuse; never auto-take over or kill by PID. Release only the current operation's ephemeral owned lease. This serializes cooperating processes, not arbitrary editors.
- `assertSubagentMutationAvailable(repository: RepositoryIdentity): void` fences admission/start. A mutation drains only the current owner's runs and never cancels another session's unrelated isolated worker; snapshot preparation is rechecked against this lease before admission.
- `IntegrationOutcome { status: "not_applied" | "applied" | "failed"; safetyCheckpoint?: string; errorMessage?: string; parentVerification: "not_run" }` and `applySubagentArtifact(options: { pi: ExtensionAPI; ctx: ExtensionCommandContext; record: Readonly<SubagentRunRecord>; source: SourceSnapshot; artifact: SubagentArtifact; isCurrent(): boolean }): Promise<IntegrationOutcome>` belong to `apply.ts`. Add optional integration metadata; a refused repeat does not erase an already-applied outcome.
- Add optional final mutation-owner context to `restoreCheckpoint`, preserving existing positional arguments. Route all actual restoring writes through the guard once, including code-only and pre-fork paths; unsafe ownerless calls cannot bypass an active guard.

- [ ] **Step 1: Write failing authorization/real-integration tests.** Cover interactive confirmation cancellation, stale owner/origin/generation, parent permission changes after dispatch, missing/tampered/already-applied artifacts, parent HEAD change, affected-file preimage conflicts, ignored-file/case-folding/symlink collisions and unsafe patch paths. Permit unrelated parent edits while preserving index/staging. Capture failure prevents apply. Two separate processes/module graphs must contend on one checkout lease, not unrelated checkouts; new admissions cannot race a mutation. Hold drain and assert neither apply nor restore writes execute. Inject partial application and preserve concurrent user-created files/ambiguous ownership without automatic reset/rollback.

```ts
it("keeps an unrelated parent edit while applying an isolated delta", async () => {
  expect(parentUnrelatedText).toBe("new parent work\n");
  expect(parentTargetText).toBe("verified child change\n");
  expect(parentIndexAfter).toEqual(parentIndexBefore);
});
```

- [ ] **Step 2: Observe red.** `npm test -- test/subagent-mutations.test.ts test/subagents-apply.test.ts test/subagents-hybrid-checkpoints.test.ts`.
- [ ] **Step 3: Implement one user command and guarded mutations.** Register `/subagent-apply <run-id>` once, initially TUI-confirmed only; no model tool/phone exception/arbitrary file path. Validate current owner/branch/generation, source HEAD, pinned artifact, freshly read parent denies and affected file hashes/modes/existence; do not require globally clean parent or reapply its baseline dirty state. Preview → confirm → revalidate → lease/drain → safety checkpoint → revalidate/check → ordinary unstaged `git apply`. No three-way merge, reject files, commit, force or reset. Parent checkpoint capture needs a narrowly safe Git executor preserving trusted temporary-index/fixed identity assignments; do not run source-defined filters/hooks to capture/apply. Record attributable actual new artifact paths as `checkpoint-created`; on ambiguous partial failure preserve files and report the retained checkpoint. Parent verification remains not_run until normal parent tools actually verify the integrated revision.

Protect every checkpoint restore path with the same owner/drain/lease behavior, without nested locking or changing existing user-file preservation/prompts. No automatic rollback or worktree deletion. Recheck ownership after each await. Document that an unrelated editor can still race; do not claim an OS-wide atomic transaction.

- [ ] **Step 4: Verify.** Run the three suites plus checkpoint/double-Escape/lifecycle/remote-http/registration suites and full/static checks. In a real temporary repository, apply modified/new/deleted files over pre-existing unrelated dirty work, run focused/regression checks in the parent, rewind, and preserve user files/staging semantics. Phone apply remains forbidden and source verification artifacts never silently apply.
- [ ] **Step 5: Review and request authorization for:** `feat: integrate isolated subagent changes with checkpoint protection`.

## Task 6: Three Default Roles, Acceptance and Controlled Activation

**Files:** Create `ext/subagents/agents/general-purpose.md`, `test/subagents-hybrid-acceptance.test.ts`; modify `ext/subagents/agents/reviewer.md`, `definitions.ts` release guard, `README.md`, this plan/spec status and targeted registration/task/usage/remote tests only as needed. Explorer remains read/search-only.

**Interfaces:** Consumes all earlier tasks and produces the final tested role catalog/support matrix. No new runtime framework or unrelated UI/protocol surface.

- [ ] **Step 1: Write failing end-to-end acceptance.** Use a public-SDK faux provider plus the real supported execution backend. Verify default general-purpose edit/Bash, reviewer Bash actual command/exit evidence without automatic fixes/integration, explorer denials, and arbitrary custom read/write/execute role names. Two invocations of one shell role must write the same relative filename independently without changing parent/each other. Review a dirty source with partially staged changes; exercise verification side effects, parent divergence, background holds/stops/disposal/restart, authorized remote output, exact usage attribution and unsupported pricing. Unsupported platforms must refuse regardless of successful dependency mocks.

```ts
it("keeps same-role concurrent workspaces independent", async () => {
  expect(firstRunFile).toBe("first agent\n");
  expect(secondRunFile).toBe("second agent\n");
  expect(parentFile).toBe("original\n");
});
```

- [ ] **Step 2: Observe red.** `npm test -- test/subagents-hybrid-acceptance.test.ts test/registration.test.ts test/subagents-remote.test.ts`. Missing final catalog/behavior is expected; diagnose failures rather than weaken old tests.
- [ ] **Step 3: Finish role prompts/docs and non-activation wiring.** Explicitly list the approved tools in each bundled role. General-purpose owns bounded implementation work; reviewer reports actionable findings, actual verification, omissions and side effects, not automatic repairs or invented success. Document custom-file precedence, legacy omission behavior, capability-derived isolation, private Git snapshots/history limits, unsupported repository cases, per-run resources, source/parent verification difference, retention and explicit apply. Keep the release guard false. Record platform/manual limitations and request an independent final reviewer if available; author self-review is weaker, not a substitute claim.
- [ ] **Step 4: Run pre-activation checks.** `npm run typecheck`; `npm run lint`; `npm test`; `node --experimental-strip-types scripts/probe-extensions.ts`; `git diff --check`. Require all intended real platform gates executed, no unhandled errors and no M0–M2 regressions. Expected registration is still 12 extensions, one `subagent` tool, and 11 commands after adding only `subagent-apply`; no duplicate role tools. These commands are requirements, not results already obtained.
- [ ] **Step 5: Enable only actually proven support.** Once Tasks 0–5 and pre-activation acceptance pass, set `EXTENDED_SUBAGENTS_RELEASED` true. Retain real per-platform/backend/policy/snapshot checks; no config/env/model flag can force unsupported execution. Do not enable current macOS behavior just because role metadata tests passed. On an unsupported backend, explain why Bash/write dispatch is unavailable; never quietly downgrade a requested verification run into a purportedly verified read-only review.
- [ ] **Step 6: Reverify the enabled tree.** Repeat Step 4 plus actual backend/hybrid acceptance suites without mocking the release gate for supported end-to-end cases. Record command exit codes, test counts, skips and remaining manual checks. Validate focused and regression tests on integrated parent changes, not only isolated trees. Failures block release; no new paid model evaluation is needed for safety validation.
- [ ] **Step 7: Review the full branch and request authorization for:** `feat: release configurable hybrid subagent roles`. Retain all unmerged work/proof artifacts; no automatic push/merge/deployment/worktree cleanup.

## Self-Review and Handoff

- **Coverage:** configurable role/tool policy → Task 0; precise staged/working views and workspace isolation → Task 1; backend safety → Task 2; owned SDK/tool/process lifecycle → Task 3; true agent deltas/evidence → Task 4; concurrent integration/checkpoints → Task 5; actual default roles/end-to-end release → Task 6.
- **Type/dependency scan:** read-only tool types remain narrow. Snapshot/workspace types precede controller/client use; command evidence is defined before record updates; artifacts/integration extend metadata only in their owning tasks. Existing public runner exports remain usable. No role-name enum, one-writer reservation, provider-function serialization or native fallback path is introduced.
- **Review Focus:** all five failure classes are assigned real tests above, including partial staging, source object leakage, reviewer side effects, same-role collisions and uncertain termination. Literal fixture outcomes are independent of the code computing snapshots/artifacts; prose/documents do not get tautological unit tests.
- **Assistant implementation choices for plan review:** standalone filtered private Git instead of exposing source common metadata; no source history/remotes; private HEAD/index/current-working views; delta against the captured working tree; preserve unrelated parent edits but reject affected-file conflicts; bounded pre-admission capture; no new unsafe repository compatibility or resource-service provisioning. These choices implement the approved workspace/safety requirements and should be reviewed for their setup/storage tradeoff.
- **Known limitation:** the current macOS proof already failed. Tasks 0–1 can provide independently tested preparation, but cannot make Bash/write ready. Task 2 may require a separately approved backend/lifecycle decision and halt this execution; do not promise unconditional completion on the current stack.
- **Current checks:** Tasks 0–1 have 104 passing test files / 1,225 passing tests, clean typecheck/lint, and a 12-extension/10-command registration probe. Source snapshot smoke capture on the actual checkout succeeded (1,913 ms / 44 subprocess calls after batched I/O). This is macOS preparation evidence, not OS containment, Linux execution, live UI/phone or paid model-quality proof. No new backend or shell/write activation is implemented.

Preserve native execution as previously selected. After plan review, use `using-git-worktrees`/`executing-plans`, carry this approved spec and plan together, and keep this plan's ledger separate from the old writer ledger. A fresh M0–M2-based execution checkout may test Tasks 0–1 without copying the old uncommitted proof into its default test include; the known red gate remains disclosed and must be imported/executed at Task 2 before any activation. Never delete, skip or xfail that evidence to claim a green release. Ask before planned commits, new dependencies/backends or a changed security contract.
