# Configurable Subagents and Hybrid Workspaces

**Status:** Tasks 0–1 (configuration/snapshot preparation) are implemented and committed. The user approved the native best-effort design, local compilation with an already-installed Apple toolchain and the revised remaining plan, then authorized starting Task 2. The local helper/shared preparation implementation is verified, and the user explicitly authorized its local commit after review. Its tests and the retained isolated proof support bounded inspection and inherited-cookie controls, not universal cleanup or full-tool containment. Production execution orchestration and shell/write activation remain unimplemented.
**Implementation plan:** `docs/superpowers/plans/2026-10-24-configurable-subagents.md` (Tasks 0–1 committed; Task 2 verified with its local commit authorized; Tasks 2b–6 pending).
**Baseline:** `519889c`, with bundled read-only explorer/reviewer already implemented.
**Supersedes:** The separate bundled writer/worker role and workspace/admission decisions in `2026-10-24-subagent-writer-design.md` and its implementation plan. Their failed backend proof remains valid evidence, not a completed gate.

## Intent

Provide a small default catalog without making it a closed list. Users can add specialized agents through Markdown definitions without changing core code. Prevent parallel implementation or verification work from interfering with the parent or another subagent's files.

## Approaches and approved choice

- **One shared checkout:** simple and cheap, but safe concurrent use requires serializing mutations, including test/build commands and parent edits. It does not meet the user's desired protection against overlapping agent work as a universal default.
- **Separate checkout for every agent:** gives readers a stable view too, but adds unnecessary setup to lightweight exploration.
- **Hybrid, selected by the user:** pure readers may share; any agent with shell or write capability receives an isolated workspace per invocation. Decisions derive from effective supported tools, not agent names or a prompt's claim of being read-only.

Workspaces isolate checkout changes, not operating-system processes, network services, or all Git metadata.

### Execution approaches and selected direction

- **Native execution with best-effort cleanup, selected by the user:** retain the public Pi SDK, existing sandbox-runtime dependency, subprocess execution and private workspaces. Do not claim reliable termination of every detached/adopted descendant. No VM, Docker, privileged helper or automatic dependency installation is selected. The process-cookie candidate uses an unprivileged native inspector; its production provisioning is a separate decision below.
- **Strict execution ownership:** require an execution boundary that proves all owned descendants stop, potentially using a separately approved Linux/VM backend. This was the earlier requirement; it is not the selected release target and remains unproven.
- **Unrestricted host execution:** rejected. Best-effort cleanup does not permit bypassing permissions, using the parent checkout for writes, or running tools outside the sandbox.

This is an explicit lifecycle tradeoff, not a claim of identical behavior or security guarantees to Claude Code or Codex. A missing native sandbox or an unrepresentable policy still refuses execution; it never triggers an unrestricted fallback.

## Bundled roles

| Role | Default supported tools | Purpose and workspace |
| --- | --- | --- |
| `general-purpose` | `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash` | General investigation and implementation; isolated workspace per run |
| `explorer` | `read`, `grep`, `find`, `ls` | Focused exploration with citations; may share the parent checkout |
| `reviewer` | `read`, `grep`, `find`, `ls`, `bash` | Inspect changes and run appropriate verification; isolated workspace per run, no automatic fixes/integration |

There is no additional bundled `worker`, `writer`, or `planner` role in the current scope. `general-purpose` covers implementation work.

Bash makes reviewer potentially mutating even without Edit/Write tools. Test/build commands can change files or start services; do not label this an OS-enforced read-only role. Report observed commands, cwd, exit/signal, omissions, and verification side effects. A command's successful exit is not proof it meaningfully tested the change. Reviewer reports remain untrusted findings, not authorization to apply changes.

## User-defined agents

- Preserve Markdown definitions in `<getAgentDir()>/agents/*.md` and trusted `<cwd>/.pi/agents/*.md`, with project > user > bundled precedence. Overrides require the same validation as new names.
- A definition controls its name, routing description, instructions, supported tool subset, supported explicit/inherited model, and bounded turn limit. The agent identifier remains a string resolved from the catalog, not an enum of three names.
- Custom agents may explicitly select edit/write/Bash as well as read/search tools. Effective capabilities remain intersected with parent restrictions and platform/backend support. Merely adding a role never grants an unsupported tool or bypasses denied access.
- Workspace selection uses actual capabilities: a custom `api-auditor` with Bash is isolated just like reviewer; a custom analysis role with read/search only may share. Unknown tool effects must not be assumed read-only.
- No claim of configuration-file compatibility or complete feature parity with Claude Code/Codex. This release does not add arbitrary extensions, MCP, web/browser tools, hooks, virtual routers, or nested delegation.
- Preserve trust checks, immutable runtime catalogs, explicit diagnostics, `/reload` behavior, definition-size bounds, and current capacity guardrails. Many configured roles do not mean unlimited simultaneous agents.

**Assistant compatibility proposal:** an existing custom definition that omits `tools` retains today's read/search-only default. The bundled general-purpose and reviewer explicitly list their broader tools. Do not silently grant shell/write access to old custom roles.

## Per-run workspace policy

1. Pure readers can share the parent checkout without writing to it. Preserve the current snapshot-drift warning and require citation rechecks when parent files change; a shared directory is not a frozen snapshot.
2. Allocate a distinct runtime-owned workspace for each shell/write invocation, including simultaneous invocations of the same role. Neither role names nor model arguments choose arbitrary cwd/storage paths. Preserve nested-cwd semantics.
3. Bind admission to owner, session generation, originating conversation branch, and exact selected source revision. Recheck after asynchronous resolution/setup and queue waits; do not silently adopt a different revision.
4. A reviewer must receive the actual state being reviewed, including in-scope uncommitted changes when applicable. A worktree created from HEAD alone is not sufficient. An unsafe or unavailable snapshot is a blocker, not permission to review the wrong revision.
5. Snapshot/setup must not stash, reset, stage into the user's index, commit onto the user's branch, or copy ignored credentials/dependencies indiscriminately. Preserve parent changes. The task-level plan must pin a safe materialization method and test dirty-state/nested-cwd behavior before activation.
6. Keep the existing two-active/four-queued bounds across roles and modes. Multiple isolated runs may use those slots, but integrations into one parent checkout must be serialized. Workspace separation does not eliminate logical patch conflicts.
7. Parent may continue working while isolated agents run. Results identify their base/snapshot. Before integration, validate ownership, exact artifact/base, current parent state and conflicts; do not overwrite intervening parent edits. Use parent checkpoint/new-file tracking and required user authorization. No automatic merge, commit, or cleanup.
8. Reviewer verification changes do not automatically become an implementation patch to apply. Record side effects and findings; any proposed source change still goes through normal explicit integration controls.

## Safety and lifecycle floor

Retain the earlier parent-side SDK conversation/subprocess-backed execution proposal unless a replacement is separately justified and approved. Reuse public Pi APIs; do not change Pi internals or mutate the parent's process-wide sandbox per child. Child tool execution must not fall back to unrestricted parent operations.

Permission enforcement must cover complete file/search/shell operations. Supported Git inspection must not be enabled by granting unintended access to the parent checkout or administrative metadata; redirects and denied-content paths need executable tests. Fail closed on policies the backend cannot safely represent. Worktrees are not security sandboxes.

Keep private per-run scratch/output, scoped network/credential access no broader than parent policy, output caps, budgets, cancellation ownership, background delivery fences, and separate usage accounting. Test/build resources such as ports, caches, and databases also need isolation or explicit shared-resource authorization. A private checkout does not authorize migrations against an external database.

**Retained strict-ownership failures:** on macOS 27.0.1 / Node v26.8.1 / Pi SDK 1.0.4 / sandbox-runtime 0.0.81, the earlier controller proof left detached/adopted processes writing after stop, sandbox reset, and controller exit. The three failing assertions remain retained, unchanged, under the isolated `feat/subagent-writer` checkout. They remain failures of the strict contract, not passing native-cleanup evidence. The user's native/best-effort choice removes universal descendant termination as a release requirement; it does not resolve those failures or prove the remaining execution boundary.

### Native lifecycle amendment

The user selected native execution and accepted best-effort descendant cleanup. The user approved this amendment and the local-compilation approach. The operational rules implement that native/best-effort choice:

1. **Keep the existing engine and preparation.** SDK/model/provider work stays in the parent; shell/write runs use a separate tool host and immutable per-run sandbox configuration against Task 1's private workspace. Route complete file/search/shell operations through that boundary. Keep credentials in the parent, scrub the execution environment, and use private home/temp paths. Do not add a user-controlled isolation mode.
2. **Define the cleanup scope honestly.** Attempt cancellation and bounded signal escalation for runtime-managed commands/process groups on command completion, Stop, timeout and owner loss. Observe SDK settlement and tracked controller/tool-host exit. Neither a rejected promise nor closed stdout proves process exit. Detached/reparented descendants outside that tracked scope may survive; do not report their absence as established. Parent death may prevent cleanup code from running at all.
3. **Separate tracked settlement from descendant assurance.** Reports must distinguish observed tracked-scope drainage, incomplete cleanup, and the native limitation that universal descendant termination is not guaranteed. These are runtime-owned facts, not agent-authored claims. Observed cleanup failure or continuing execution must not yield a successful completion/verification report. Keep a run `stopping` and retain its slot while its tracked SDK/controller/tool-host remains unsettled; release only after that tracked scope settles. The two-active limit bounds managed runs, not every OS process arbitrary code can create.
4. **Do not convert uncertainty into authority.** Retain workspaces rather than deleting them automatically. After restart, mark interrupted execution's cleanup unknown; do not replay work or claim it drained. Never kill processes after restart using persisted PIDs or broad process-name scans. No automatic apply or rollback follows cancellation, owner loss or cleanup failure. A retained workspace may still change after an escaped descendant; do not describe it as frozen merely because the run ended.
5. **Bind evidence and artifacts to captured content.** Command evidence records observed before/after trees and actual exit/cancellation outcomes, not a promise that no process can write later. For normally settled tracked execution, publish only a bounded, immutable, runtime-owned artifact with its own digest/tree/preimages, not a live workspace reference. Refuse publication on observed ongoing writes, inconsistent capture, owner drift or incomplete tracked cleanup. The theoretical possibility of an unobserved escaped descendant is the accepted native limitation, not automatic proof that every capture failed. Later writes cannot change a published artifact; they also cannot inherit earlier test success. Parent application remains explicit, revalidated and checkpoint-protected, with parent verification reported separately.
6. **Replace only the incompatible release gate.** Task 2b must prove real native filesystem/search/shell permissions, parent/sibling/Git protection, credential/network restrictions, ordinary cancellation/timeout behavior, and truthful reporting of cleanup limits on each enabled platform. Preserve the historical strict tests and their red evidence without changing, skipping or xfail'ing them to claim support. They are not the acceptance oracle for guaranteed descendant termination in this native profile. Task 3 must test that tracked drainage still holds capacity and that cleanup warnings cannot be forged or omitted. Do not advertise support on an untested platform.

### Process-cookie integration proposal after the authorized spike

The isolated proof used the unchanged SDK/sandbox controller and descendants. A group-only baseline reproduced all three retained failures. With a separate supervisor and cookie inspector, five positive cleanup/noninterference scenarios passed twice, including actual owner-relay SIGKILL. A stripped-cookie descendant continued writing. The new terminal boundary is supervisor cleanup completion, not the old SDK command's settlement. Inspector controls also covered process-title changes, stale birth identity, foreign cookies and TERM-resistant processes. This is narrow cleanup evidence, not a completed full-tool native execution gate.

The proposed production mechanism is:

- Generate fresh runtime-owned cookies, never role/cwd-derived identifiers. Associate managed command executions with their run in a private registry. Use distinct command scopes so ending one command does not terminate the persistent tool host or another run. Do not tag the parent SDK or supervisor, or mutate the parent's environment.
- Keep the trusted supervisor outside the worker's sandbox/process group. Give it a private owner-control pipe whose write end is not inherited by workers. On Stop, deadline or owner EOF, stop further tool admission, request ordinary cancellation and perform bounded native cleanup. No model-supplied PID, cookie or helper path can select a cleanup target.
- Combine tracked process handles/groups with fresh macOS inspection of exact inherited cookies. Constrain candidates to the expected user and recheck process birth identity and cookie immediately before signalling. Do not copy the prototype's hardcoded paths, fixture-specific assumptions or success labels into production. Cookie matches are discovery hints, not unforgeable authorization. Workers can read, alter or copy their own cookies; redacting diagnostics does not make cookies secret capabilities. Forged-cookie collateral signalling and non-atomic PID-reuse risks remain explicit production safety checks. If safe targeting cannot be established, refuse the signal and report incomplete cleanup.
- Keep the inspector's protocol bounded. Pass cookies privately rather than in command arguments; emit only necessary process identity/status metadata and coverage errors. Never expose raw environments, argv contents, cookie values or provider credentials to transcripts/model output. Missing/failed inspection is unknown, not an empty process set.
- Record tracked drainage separately from inspector coverage and descendant assurance. For example, known handles can be drained while inspection coverage is partial and descendant assurance remains not guaranteed. Retain `stopping`/capacity while tracked execution is active. A visible survivor or failed tracked cleanup cannot produce a successful completion or verification claim.
- Treat cookies stripped or changed by worker code, delegated work and supervisor failure as limitations. Two empty scans establish only that no matching process was visible at those observations. Keep the old strict failures and the stripped-cookie counterexample as evidence; do not turn them into a claim of universal termination.

A fresh native gate must test this mechanism together with the real full-tool sandbox: parent/sibling/original-Git protection, denied paths and symlink races, credential/network boundaries, ordinary completion and cancellation, per-command versus per-run cleanup, malformed/failed inspection, adversarial target selection and actual tracked drainage. Run it on each platform to be enabled. The spike was macOS arm64 only and does not establish other architectures or Linux support.

### Native inspector provisioning — local compilation selected

The package currently has no native-helper build/distribution pipeline. The proof compiled its own C source with the Apple toolchain already installed on the developer machine. Neither compiler availability on end-user machines nor prebuilt-helper distribution is established.

- **Local build with an existing toolchain (selected by the user for the first supported macOS release):** ship the fixed inspector source and compile it into private runtime storage using trusted arguments and a scrubbed environment. Do not compile agent-controlled source or accept compiler/path overrides from agent definitions. Verify the resulting executable before use. A missing compiler/SDK or failed build makes shell/write unavailable before admission; read-only agents remain usable. Never invoke an installer, download tools or elevate privileges. A per-run build outside the writable worktree avoids introducing a shared writable binary cache in the first implementation.
- **Prebuilt helper:** avoids requiring a compiler on the user's machine, but adds architecture-specific builds, distribution/integrity checks and release maintenance not present in this package. This needs separate approval and is not selected by the proof.

The user approved local compilation, not toolchain installation or prebuilt distribution. Missing prerequisites must leave read-only functionality usable. Native code and compilation alone do not pass the execution support gate.

Shell/write remains disabled through the implementation, artifact/apply integration and final native acceptance gates. This amendment authorizes neither a commit nor backend installation, cleanup, dependency changes, activation, push or deployment. Exact protocol fields and cleanup deadlines are left to the revised implementation plan.

## Acceptance requirements

- Discovery and overrides work for arbitrary valid custom names; legacy omitted-tool roles do not gain capabilities. Unsupported tools/fields fail clearly.
- General-purpose can edit and execute; reviewer can inspect Git and run verification without silently fixing/applying; explorer cannot access shell/write tools. These are executable contracts, not prompt-only labels.
- Two shell/write runs, including two instances of one role, cannot modify each other's checkout or the parent's. Reader drift is disclosed. Tests/build artifacts do not contaminate another run.
- The source snapshot includes the selected review state; stale/dirty/conflicting source and parent changes cannot be silently omitted or overwritten. Verify the integrated parent tree, not only an isolated workspace.
- Native tracked-process cancellation/drainage, timeout/owner-loss reporting, permissions, checkpoint/restore, remote ownership, lifecycle, usage and M0–M2 regressions pass on every enabled platform. Reports disclose best-effort descendant cleanup rather than claiming universal termination. Keep the retained strict-descendant failures visible as a limitation of that different contract, and report unsupported/unrun platforms and physical/manual checks honestly.

## Builder review and next step

No subagent/reviewer tool is available for an independent builder check; author self-review is not independent review. The user approved the native/best-effort direction, the written integration design and local compilation with the already-installed Apple toolchain. Protocol shapes, preparation plumbing and numeric cleanup/build bounds in the revised plan are assistant implementation choices for plan review, not separately requested features. The compatibility default and fail-closed snapshot behavior remain unchanged.

The user approved the revised plan and inline Task 2 execution, then explicitly authorized the verified local helper/preparation commit. Further task commits still require separate authorization. Keep Tasks 0–1, the original failed proof and all non-conflicting safety requirements. Task 2b must still establish the real full-tool/cleanup/targeting gate before production orchestration. Do not resume the obsolete writer plan or equate helper tests with passing native acceptance. No commit, push, cleanup, dependency addition or release is authorized by this document alone.
