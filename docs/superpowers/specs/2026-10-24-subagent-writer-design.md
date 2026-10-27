# Subagent Writer (M3) Design

**Status:** Historical writer-role proposal, superseded as product scope by `docs/superpowers/specs/2026-10-24-configurable-subagents-design.md`. The user selected configurable general-purpose/explorer/reviewer and hybrid per-run workspaces, not a separate writer role. Task 0's detached/adopted-process failure remains unresolved. No new product capability is enabled.
**Historical implementation plan:** `docs/superpowers/plans/2026-10-24-subagent-writer.md` (superseded role scope; Task 0 blocker and evidence retained there).
**Predecessor:** `docs/superpowers/plans/2026-10-23-subagents.md`, especially section 12.
**Baseline:** `519889c` on `feat/read-only-subagents`.

## Intent

Let the parent delegate a bounded implementation task without giving a child access to the parent's checkout, credentials, global configuration, or sandbox lifecycle. A worker produces a reviewable patch and runtime-observed command results. It does not integrate its own work.

M0–M2 read-only behavior must remain intact. This is one cohesive follow-on: isolated execution, workspace ownership, result artifacts, and checkpoint-safe human-authorized integration must work together before release.

## Approaches and decision

1. **In-process file tools and per-command sandbox overrides.** Least plumbing, but native file tools execute outside shell restrictions and the sandbox manager is process-wide. The existing two macOS tests only establish shell filesystem feasibility. Rejected as the writer architecture.
2. **Put the entire SDK/model session in a subprocess.** Stronger session separation, but parent-registered JavaScript providers cannot simply be serialized, and passing credentials adds another exposure path. Not selected for the first writer.
3. **Subprocess-backed execution with the SDK session on the parent side.** Keep the existing fresh SDK conversation, provider/thinking inheritance, budgets, and usage attribution. Route every child file/search/shell operation through a dedicated execution worker with its own sandbox manager. Selected as the implementation proposal.

The user first approved the subprocess direction and subsequently approved this detailed design, including the parent-side SDK/execution-worker split in option 3. The trusted execution worker is a controller: model-selected code runs only in its sandboxed descendants, never in the controller itself. A subprocess alone is not a security boundary.

## Scope and explicit exclusions

- Add a bundled `writer` role and explicit definition capability `read-only | writer`; omission preserves today's read-only ceiling. Custom roles cannot obtain writes merely by listing write tools.
- Writer requires a trusted project, validated parent-policy snapshot, eligible clean Git checkout, supported public SDK/provider, and a proven sandbox/process-ownership backend.
- Use the existing `subagent({ agent, task, background? })` API, reports, `/tasks`, `task_stop`, remote output/stop authorization, and usage accounting. Do not add a daemon, task dashboard, or nested delegation.
- Writer tools are `read`, `grep`, `find`, `ls`, `write`, `edit`, and gated `bash`, intersected with the role and parent restrictions. No MCP, codemode, monitor, arbitrary extensions, or background-service transfer.
- No automatic integration, commit, stash, reset, push, deployment, migration against external state, or worktree deletion. No network access from model-selected commands. Provider requests remain parent-side.
- Initial patch support is regular UTF-8 text files, including new/deleted files. Reject binary changes, symlink changes, submodule changes, executable-mode changes, and unsupported filter/LFS repositories rather than silently weakening validation.
- Do not add dependencies or change manifests without asking. Reuse installed sandbox-runtime `0.0.81` and public Pi APIs.

## Execution and trust boundaries

### Parent-side SDK session

Reuse the model-resolution and lifecycle behavior already proven by M0–M2, without copying parent history. Keep global instructions and trusted project instructions under the existing rules. Add writer-specific instructions describing its workspace, exact base, allowed operations, and required evidence.

The SDK sees tool definitions, not raw parent filesystem operations. A writer-specific runner routes complete tool executions across the worker boundary; no SDK tool may fall back to local operations. In particular, grep's public operations override does not replace its ripgrep spawn, so merely overriding that interface is insufficient.

### Execution worker

One private controller subprocess per admitted writer owns sandbox initialization, command execution, cancellation, and cleanup. It does not import project code, load user startup hooks, or accept arbitrary JavaScript for execution in the controller. It never receives provider secrets or raw parent conversation history.

Each filesystem/search operation runs in a sandboxed tool helper using public Pi tool factories where safe. Bash runs in the same enforced filesystem/network boundary. A fixed runtime/helper path and required public dependencies may be read-only; no repository-selected entry point or loader is used. Check availability of an existing compatible Node executable; do not install one or silently choose another backend.

Use a scrubbed environment: private HOME/TMPDIR, required executable paths and locale only. Remove inherited provider tokens, Git overrides, `NODE_OPTIONS`, shell startup configuration, and unrelated user environment. Parent policy snapshots travel in memory and are not logged or persisted as raw IPC.

Control messages are bounded, validated, versioned NDJSON over private pipes, with controller-owned request IDs. Maximum wire frame: 256 KiB; maximum model tool input: 32 KiB. Raw helper/shell output is always encoded as data, never forwarded onto the control stream as frames. Preserve `isError`. Malformed/oversized frames, unexpected closure, or unknown operations fail closed and start cleanup. Do not print rejected payloads into diagnostics.

Public tool output remains bounded to 32 KiB and parent-facing reports to 8 KiB. Strip terminal control sequences from exposed text and preserve HTML escaping at renderers. Keep draining output safely; terminate an operation that exceeds its raw transport allowance rather than retaining an unbounded buffer. Command evidence comes from the trusted controller's spawn/exit observations, not output text.

### Sandbox policy

Allow writes only to the assigned worktree and private per-run scratch space, apart from narrowly necessary device/runtime operations. Deny parent checkout writes, shared Git metadata, `.git` redirection, other run directories, global Pi state, and credential locations. Model-selected operations cannot read the parent checkout or credentials; only the worktree and necessary public runtime files are exposed.

Preserve applicable deny rules at tool admission and in the OS filesystem boundary. Re-anchor repository-relative restrictions to the worker. Also protect corresponding worker files for absolute restrictions inside the source checkout, while retaining original absolute restrictions. Read-denied files must not leak through search, shell, Git objects, or generated patches. Runtime allowlists must never override an applicable user deny to make a helper start. An unrepresentable/incompatible policy makes writer unavailable.

Test actual path resolution, symlink/rename races, traversal, Git directory overrides, encoded paths, default temporary-directory allowances, and writes to a sibling location outside the explicitly denied parent. Tests must establish the effective OS boundary, not merely inspect a configuration object.

The model does not receive access to shared Git objects/configuration. Git-dependent worker commands may consequently fail; the trusted parent controller supplies base/diff metadata instead of granting broad Git access.

## Workspace and lifecycle

- Select and record the parent's exact HEAD commit, canonical checkout/common-Git identities, session, generation, originating branch, and owner at admission. No implicit main/default branch.
- Require no staged, unstaged, or nonignored untracked changes. Do not copy ignored files, credentials, dependencies, or dirty state into the worker. Existing projects needing setup outside these limits are refused or report blockers.
- Create a detached worktree under the private run-storage directory only when the run starts. Recheck captured ownership, clean state, and exact base after asynchronous work and immediately before creation. A queued run never silently adopts a newer base.
- Setup and artifact generation must disable Git hooks, fsmonitor, external diffs/textconv, checkout filters, and submodule recursion as applicable. Refuse unsupported repositories rather than executing repository-defined setup code outside the sandbox.
- At most one writer may be admitted (queued or active) per parent runtime; reject a second writer rather than adding a separate queue. Writers share the existing two-active/four-queued scheduler with read-only runs.
- Keep existing five-minute admission deadline, 12-turn ceiling, 40-call ceiling, per-run 100k reported tokens, and parent-turn six-run/300k reported-token limits. Definitions may lower but never raise them.
- Preserve workspace and available artifacts on failure, cancellation, timeout, or restart. Do not auto-replay or delete work. Failed setup may leave a clearly identified incomplete workspace for explicit cleanup.

Stopping must abort the SDK operation, stop the controller and all model-command descendants, and await observed settlement. Use cooperative cancellation followed by bounded termination/escalation, but never release the scheduler slot or writer lease while execution may still be alive. If cleanup cannot be established, retain `stopping` and report the condition; a restart records interruption, not successful cancellation. Never kill a process solely because a persisted PID matches.

**Platform gate:** prove cooperative cleanup, inherited-stdio background jobs, detached/new-session and double-fork descendants, command timeout, and loss of the owning parent process. Linux's installed sandbox implementation requests a PID namespace; that is evidence to test, not proof of deployment support. The macOS filesystem tests do not establish equivalent process containment. If full ownership cannot be proven with the existing public APIs, do not enable shell writer on that platform. Stop and ask about a narrower writer or an additional backend; neither is silently substituted.

## Artifacts and truthful verification

The trusted controller collects changes only after execution settles, verifies workspace/base identity and eligible changed paths, and creates a bounded patch outside the model-writable area. Inspect changed paths before collecting content; refuse changes involving denied files. Do not allow an untrusted patch header, symlink, or Git override to choose artifact paths.

Initial artifact caps: 1 MiB patch and 100 changed files. Record a digest, base, owner, changed paths, workspace, and collection status. Exceeding a cap preserves work and returns a clear blocker, not a partial patch presented as complete.

The run report distinguishes **worker completed**, **patch available**, and **patch applied**. Include runtime-observed command, requested cwd, exit/signal, cancellation, and output truncation. Exit zero is command evidence, not an assertion that the command meaningfully tested the change. Worker prose cannot forge `Verification`, usage, or integration status. Tests in a worktree do not establish verification of the integrated parent tree.

Use existing private transcript/report storage and bounded authorized task output. Remote output may show safe summaries and artifact identity, never arbitrary file access, raw credentials, or an automatic apply operation. Foreground usage remains counted once; background usage remains a separate disclosed ledger.

## Human-authorized integration and checkpoints

Add one user command, `/subagent-apply <run-id>`, not a model-callable apply tool. Initial application requires interactive confirmation; noninteractive invocations refuse. Resolve only a completed, settled, unapplied artifact owned by the current session and originating branch. Do not accept arbitrary patch paths or infer authorization from worker text.

1. Validate ownership, generation, artifact digest, exact parent HEAD/base, clean tree, allowed patch format/paths, and all parent write restrictions. Newly created targets must not already exist, including ignored files and case-folding/symlink aliases.
2. Show a bounded change preview, including additions/deletions, and obtain explicit confirmation. Revalidate after the UI wait.
3. Serialize cooperating apply/restore operations for that checkout and drain the current owner's writers before any parent filesystem mutation. A guard failure aborts without restoring/applying anything.
4. Capture a parent safety checkpoint using existing checkpoint machinery; if capture fails, refuse apply. Recheck base/ownership before mutation.
5. Run guarded `git apply --check` followed by ordinary unstaged application. Never use automatic three-way merge, reject files, force/reset, or implicit staging. Pin the artifact being applied and disable external Git execution paths.
6. Record actual new files with the parent's existing `checkpoint-created` metadata and append integration outcome/checkpoint identity. Return that parent verification is still required through normal parent tools and permissions.

The checkpoint extension must use the same drain/mutation guard on every restore path, including code-only rewind and pre-fork restoration. Keep the existing non-writer behavior and user-file preservation semantics unchanged. Do not automatically stop another session's unrelated isolated worker.

A cooperating runtime lock cannot prevent a human/editor or unrelated process from changing files. Recheck immediately before application and rely on Git's application checks; do not claim an OS-wide atomic transaction. On I/O failure, report possible partial changes and the retained safety checkpoint; never automatically roll back/reset/delete concurrent user work. Focused and regression tests must run on the integrated tree in acceptance tests and release verification. Product reports do not label later parent testing as done merely because application succeeded.

## Acceptance and implementation gate

Before product activation, establish these checks in order:

1. Real backend proof: direct file tools, search and Bash cannot escape filesystem/network bounds; parent sandbox configuration and concurrent parent writes remain unaffected; cleanup includes daemonization and parent loss. Unsupported platforms remain explicitly unavailable.
2. Workspace/admission: clean exact-base creation, unsafe Git configuration refusal, queued drift, trust/definition/policy restrictions, private retention, and ownership races.
3. Worker protocol/lifecycle: framing/output caps, malformed/spoofed output, crashes, stops, deadlines, budgets, no slot release before settlement, and restart without replay.
4. Artifact/integration: new/deleted text files, denied content, oversized/unsupported patches, tampering, parent drift/conflicts, ignored-file collisions, confirmation cancellation, stale sessions, checkpoint failure, partial-apply failure, and new-file rewind.
5. Existing M0–M2 tests, remote ownership/escaping, usage accounting, and checkpoint regressions remain green. Run typecheck, lint, full tests, extension probe, and diff checks. Document actual platform/manual limitations; obtain independent review if a reviewer tool becomes available.

Do not enable a writer simply because mocks pass. No new live evaluation spend is necessary to establish filesystem/process safety; use deterministic public-SDK and real local sandbox/process tests first.

## Builder review and remaining choices

No subagent/reviewer tool was available when checked. The author performed the builder check against the predecessor plan and public tool interfaces; this is not independent review. The design explicitly resolves provider inheritance without credential IPC, whole-tool execution rather than incomplete grep overrides, unsupported patch formats, apply authorization, and platform fail-closed behavior.

The user approved this design and requested the task-level implementation plan. After plan review, execute natively unless a reviewer/implementer tool becomes available. The builder may choose internal module names, request type names, exact cooperative/escalation intervals, and minimal fixed runtime read paths, subject to executable safety proofs. They may not relax the process-ownership gate, widen permissions, change the integration approval boundary, add dependencies, or enable unsupported platforms without returning to the user.
