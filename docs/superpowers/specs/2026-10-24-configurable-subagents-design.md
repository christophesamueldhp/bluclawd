# Configurable Subagents and Hybrid Workspaces

**Status:** The user approved this written design and requested the implementation plan. No new product capability is enabled.
**Implementation plan:** `docs/superpowers/plans/2026-10-24-configurable-subagents.md` (awaiting plan review; native execution preserved).
**Baseline:** `519889c`, with bundled read-only explorer/reviewer already implemented.
**Supersedes:** The separate bundled writer/worker role and workspace/admission decisions in `2026-10-24-subagent-writer-design.md` and its implementation plan. Their failed backend proof remains valid evidence, not a completed gate.

## Intent

Provide a small default catalog without making it a closed list. Users can add specialized agents through Markdown definitions without changing core code. Prevent parallel implementation or verification work from interfering with the parent or another subagent's files.

## Approaches and approved choice

- **One shared checkout:** simple and cheap, but safe concurrent use requires serializing mutations, including test/build commands and parent edits. It does not meet the user's desired protection against overlapping agent work as a universal default.
- **Separate checkout for every agent:** gives readers a stable view too, but adds unnecessary setup to lightweight exploration.
- **Hybrid, selected by the user:** pure readers may share; any agent with shell or write capability receives an isolated workspace per invocation. Decisions derive from effective supported tools, not agent names or a prompt's claim of being read-only.

Workspaces isolate checkout changes, not operating-system processes, network services, or all Git metadata.

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

**Unresolved blocker:** on macOS 27.0.1 / Node v26.8.1 / Pi SDK 1.0.4 / sandbox-runtime 0.0.81, the earlier controller proof left detached/adopted processes writing after stop, sandbox reset, and controller exit. The three failing assertions remain retained under the isolated `feat/subagent-writer` checkout. This policy approval does not waive that result, authorize an untested backend, or prove shell execution ready on macOS/Linux. Do not activate general-purpose/reviewer Bash on a backend until the required ownership/containment proof passes, or the user explicitly approves a different lifecycle contract. Do not introduce a VM, dependency, privileged helper, or weaker guarantee silently.

## Acceptance requirements

- Discovery and overrides work for arbitrary valid custom names; legacy omitted-tool roles do not gain capabilities. Unsupported tools/fields fail clearly.
- General-purpose can edit and execute; reviewer can inspect Git and run verification without silently fixing/applying; explorer cannot access shell/write tools. These are executable contracts, not prompt-only labels.
- Two shell/write runs, including two instances of one role, cannot modify each other's checkout or the parent's. Reader drift is disclosed. Tests/build artifacts do not contaminate another run.
- The source snapshot includes the selected review state; stale/dirty/conflicting source and parent changes cannot be silently omitted or overwritten. Verify the integrated parent tree, not only an isolated workspace.
- All subprocess/descendant, timeout/owner-loss, permission, checkpoint/restore, remote ownership, lifecycle, usage and M0–M2 regressions pass on every enabled backend. Report unsupported/unrun platforms and physical/manual checks honestly.

## Builder review and next step

No subagent/reviewer tool was available for a fresh builder check; author self-review is not independent review. This amendment deliberately leaves backend feasibility unresolved rather than substituting another security contract. The compatibility default and fail-closed snapshot behavior originated as assistant proposals and were included in the written design approved by the user. Detailed materialization choices are identified separately in the implementation plan for review.

This design has been reviewed and approved. The role-neutral implementation plan replaces the obsolete writer task plan; its review precedes implementation. Preserve existing proof artifacts and all non-conflicting safety requirements. Do not resume the old plan as though changing the role name fixes its failed gate. No implementation, commit, push, cleanup, dependency addition, or release is authorized by this document alone.
