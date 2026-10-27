# Shared-Workspace Subagents

**Status:** Requested architecture, pending approval of this written design and implementation. The user selected shared execution, inherited parent authority without escalation, orchestrator-selected roles/models/thinking levels, no child-specific usage limits, and two-way communication. Local preservation commits, consolidation into `main`, and deletion of merged local branches were explicitly authorized and completed. This document does not claim that the new runtime is implemented.

**Supersedes:** The runtime direction in `2026-10-24-configurable-subagents-design.md`, the separate writer design, and their isolated-execution/private-runtime implementation plans. Preserve their code, tests, artifacts, and failures as historical work; do not continue their pending tasks as the new implementation plan.

## Intent

Delegate distinct tasks to independent conversations working in the same project as the orchestrator. The orchestrator decides whether delegation is useful, how many agents to start, what each owns, and which role/model/thinking level fits. Coordination replaces mandatory workspace separation, not the parent's permissions or the need to verify results.

## Approaches and User Selection

1. **Separate workspace for every writing/shell agent:** reduces checkout interference but requires snapshot, tool-host, artifact, and integration machinery. Previously selected, now explicitly rejected as a mandatory subagent architecture.
2. **Hybrid reader/shared and writer/isolated execution:** retains the same integration machinery and imposes different environments according to tool capability. Also superseded by the user's latest request.
3. **Shared workspace and inherited parent execution, selected by the user:** every child works against the same live checkout and effective parent policy. It is simpler, but concurrent changes, test/build side effects, and shared services can interfere. The orchestrator owns decomposition and conflict resolution; there is no promise of isolated or transactional execution.

Separate SDK conversations and private transcript storage remain useful context/accounting boundaries. They are not separate filesystems or security sandboxes. Retain the parent's sandbox when enabled; do not create a stricter child sandbox or disable the parent's sandbox.

## Required Behavior

### Scheduling and Usage

- No hardcoded maximum active/queued agents, role count, per-parent-turn delegations, turns, tool calls, tokens, cost, or total run duration. No capacity-based agent admission queue, including hidden preparation queues.
- Start requested independent work without waiting for a bluclawd concurrency slot. The orchestrator may intentionally wait for a dependency; this is task ordering, not a runtime capacity quota.
- Remove child-only automatic termination for repeated calls or repeated policy denials. Denied operations remain denied; report problems to the orchestrator rather than interpreting a counter as completion.
- Keep cancellation, session invalidation, truthful failure reporting, usage/cost accounting, and normal provider/context/OS limits. Parent tool timeouts and normal result/transport behavior still apply equally to children, not as extra subagent restrictions.
- Do not replace removed quotas with very large constants, undocumented caps, or a parallel limiter elsewhere. A failure to allocate a resource is a real error, not permission to pretend the agent was started.

### Roles

- Keep bundled `explorer` and `reviewer` and add the previously planned `general-purpose` preset. Roles describe responsibilities, not separate authority ceilings.
- Let the orchestrator select a bundled/saved role or supply an inline custom role with its own name, description, and instructions at spawn time. Inline roles are run-local; do not silently write agent definition files.
- Preserve trusted project > user > bundled precedence for saved Markdown roles. Explicit spawn choices override role preferences.
- The new default is inherited parent capabilities, not the old omitted-`tools` read-only ceiling. Existing explicit saved tool restrictions must not be silently discarded: retain them as explicit opt-in restrictions or return a clear migration diagnostic before running. Do not retain hardcoded role-specific ceilings.

### Models and Thinking Levels

- Expose a discoverable subagent model catalog from the parent's configured SDK/model registry. This is discovery, not a separate static allowlist or a curated subset.
- Include stable `provider/model` identity, display name, known availability/authentication status, and supported thinking levels where the provider/SDK exposes them. Never include credentials. Distinguish unknown capability/availability from unsupported.
- The orchestrator can choose model and thinking level independently for each spawn; it is not forced to inherit either or use a role-fixed model.
- Precedence: explicit spawn selection, then optional saved/inline role preference, then parent value. Inheritance is a fallback, not an enforced model choice.
- Validate the selected combination. Report unavailable credentials/models and unsupported thinking levels clearly; do not silently select a different model or downgrade thinking. Do not invent thinking levels or claim API-key presence proves live provider access.
- Do not impose a physical-model-only restriction merely because the previous runner did. Use configured routers/aliases when public SDK support can preserve their behavior; disclose unsupported cases instead of recreating private provider state or claiming catalog/execution parity.
- Refresh discovery through existing model configuration/runtime mechanisms; there is no need for a new configuration file or provider dependency.

### Inherited Authority Without Escalation

- Use the parent's working directory, live checkout, effective tools/integrations, trust decisions, permissions, and enabled sandbox. No per-agent worktree, filtered repository copy, private tool-host filesystem, patch export/apply phase, or special isolated-backend/compiler prerequisite is required.
- Inherit tools actually available to the parent, including MCP, web/browser, codemode, and custom tools when configured. Do not equate full inheritance with reloading arbitrary extensions and duplicating servers/timers; reuse parent execution where public APIs support it.
- Enforce parent deny and approval checks on actual execution, including nested tool calls. A role, task prompt, selected model, peer message, or orchestrator-generated approval claim cannot grant authority the user did not grant.
- Parent policy changes and session/branch invalidation must not leave a child executing against a stale, more permissive grant. Recheck policy through the parent's normal execution path.
- Children cannot spawn/manage new child agents through bluclawd's delegation entry points. Guard the runtime boundary and nested dispatch lineage, not just the visible tool list. Only the orchestrator creates agents.
- **Boundary limitation:** with the same arbitrary shell/MCP authority as the parent and no separate sandbox, bluclawd cannot prove that a child never launches an external agent process or calls an external agent service. Enforce the managed-delegation prohibition and the inherited parent rules; do not claim OS-enforced prevention or silently add shell blacklists to manufacture it. An absolute external-delegation prohibition would require a separately agreed restriction and conflicts with unrestricted authority parity.
- Background work must preserve the same checks after the launch tool returns. A stale tool context or unavailable public executor is an implementation blocker to resolve explicitly, never a reason to bypass hooks or run a raw unrestricted tool.

### Two-Way Communication

- Support orchestrator -> child, child -> orchestrator, and direct child -> sibling messaging while tasks are in progress. Do not limit communication to final completion reports.
- Address messages by runtime-owned run identity, scoped to the same parent session/generation/origin branch. Resolve aliases through that registry; never accept a model-supplied owner identity as authorization.
- Record sender/recipient identity and message ordering. A delivery result distinguishes accepted for processing from actually handled; stopped, invalidated, or unavailable recipients return explicit outcomes.
- Deliver messages through SDK-safe steering/follow-up boundaries without re-entrant prompting or interrupting a file operation halfway through. An ordered message inbox is not an agent concurrency queue.
- Do not silently resurrect a completed/cancelled child or start an unbounded conversational ping-pong loop. Starting another work turn for a completed child is an explicit orchestrator action. Idle orchestrator notifications must be deliverable without falsely claiming user approval.
- Messages are agent-authored data, not higher-priority user instructions. Preserve the existing untrusted-report boundary and do not expose another session's conversation or credentials.

## Orchestrator Responsibilities and Shared-State Tradeoffs

The user explicitly assigns task overlap and redundant delegation to the orchestrator, rather than asking the runtime to prevent every possible conflict.

**Assistant proposal for orchestration guidance:** before spawning, describe each task's goal, deliverable, owned files/symbols or subsystem, dependencies, and relevant sibling run IDs. Prefer one implementation owner per change. A reviewer examining the same code is complementary work only when its deliverable is explicitly different; it should not independently implement the same fix.

- Agents communicate blockers, failed commands, unexpected file changes, and newly discovered shared dependencies early. Include command/cwd/exit or relevant file/symbol evidence rather than only saying that something failed.
- If tasks need the same interface or file, the orchestrator assigns an owner and coordinates an explicit handoff/dependency. It may revise or cancel a task. There is no automatic global mutation lock, path reservation system, or forced serialization of all writing agents.
- Communication reduces interference but does not prevent simultaneous writes, stale reads, or unrelated tasks editing shared infrastructure. The orchestrator must inspect the actual resulting code and run final verification on the shared tree.
- No automatic stash, reset, revert, merge, workspace deletion, or rollback over sibling/user edits. Use the existing checkpoint/permission workflow for any explicitly authorized repair. Avoid reflexively attributing every shell failure to task overlap: failures also come from code, tooling, provider, and environment issues.
- Shared files, Git state, ports, caches, databases, and services are genuinely shared. A successful test is evidence for the observed tree/time, not a guarantee that a concurrent later edit remains valid.

## Existing Work to Reuse or Retain

- Reuse the run registry, isolated conversation/context handling, cancellation, session/branch ownership, `/tasks`/remote controls, report/transcript storage, and usage accounting after removing incompatible limits and read-only claims.
- Extend role resolution and model resolution for inline roles, explicit thinking/model overrides, and model discovery.
- Add runtime-scoped messaging and shared-parent tool execution. The current SDK exposes `ExtensionToolContext.executeTool`, nested call lineage, tool metadata, and session steering/follow-up; prove their lifetime/exposure/accounting behavior before relying on them for long-lived background children. Model-only tools are not automatically callable through the nested executor.
- Keep snapshot/workspace/native-inspector/isolated-policy code and their tests as preserved historical work for now, not prerequisites on the new runtime path. Do not delete that work as part of this design revision.
- Keep the vendored runtime artifact/provenance and parent sandbox behavior unchanged during this consolidation. Whether the private fork is still worth maintaining is separate from enabling shared-workspace subagents.
- Leave old dispatch/release flags honest: merging source and approving direction do not activate broad child execution by themselves. Replace the obsolete release path only under the new implementation plan and tests.

## Verification and Evaluation Requirements

1. **No artificial capacity/usage ceiling:** deterministic tests start more runs than the previous 2/4 and 6-per-turn limits, cross prior turn/tool/token/repetition limits, and prove no hidden preparation queue/deadline terminates them. Test with controlled fake providers rather than resource exhaustion.
2. **Role/model discovery:** bundled, saved, and inline roles; explicit model/thinking precedence; catalog changes; invalid/unavailable combinations; and honest router/alias support without credential disclosure.
3. **Authority parity:** actual file/shell/MCP/custom/codemode operations use the parent's rules and approval flow in both modes. Test parent denies, live policy tightening, nested calls, managed-delegation rejection, executor lifetime after background launch, and no duplicate nested usage attribution. Do not claim an OS boundary against arbitrary same-authority shell code.
4. **Shared workspace:** children and parent see each other's real edits and do not allocate private workspaces. Exercise distinct tasks, an intentional overlapping-edit scenario, conflict/blocker messages, explicit reassignment/handoff, and final parent verification. Demonstrate recoverability through coordination, not guaranteed collision prevention.
5. **Messaging/lifecycle:** bidirectional parent/child and sibling delivery during work, concurrent sender ordering, invalid recipients, cancellation/disposal/branch changes, blocked approval, and no message-derived authorization or accidental child resurrection. Add deterministic coverage for the observed background-disposal/teardown race instead of hiding it with a retry.
6. **Shell failures:** actual nonzero exit, cancellation, detached-process limitations, and accurate cleanup reporting. Never equate a completed tool promise with proof that every descendant stopped.
7. **Quality evaluation:** compare single-agent and orchestrated shared-workspace runs on real small implementation/review/debugging fixtures. Measure correctness, nonredundant decomposition, conflict detection/recovery, communication usefulness, final-tree test results, elapsed time, total tokens/cost, and repeated-run reliability. Include autonomous routing instead of only forced delegation and regex grading.
8. **Honest outcomes:** deterministic/offline verification does not spend paid model quota. Live evaluation is opt-in, with its separate test-harness spend agreement; it does not install production usage quotas. Report model/sample/platform coverage and failures, not unsupported general quality claims.

Historical strict-isolation tests retain their original assertions and red outcomes. Do not delete, skip, weaken, or mark them expected-success to claim a green release. A future explicit separation of historical proofs from current acceptance may be proposed with clear commands and reporting; it is not silently performed here.

## Consolidation Evidence (Not New-Runtime Acceptance)

- Preservation commits: `244e32b` (plans/designs), `e106523` (strict writer proof), `8b39800` (private runtime and native boundary work).
- Integration commits: `cf9da7d` (configurable foundations) and `6313d7d` (writer evidence). All three former feature tips are ancestors of `main`; their local branch names were deleted only after ancestry and clean-worktree checks. Detached worktrees remain intact to preserve ignored/private development evidence. No remote was changed.
- Root dependency synchronization changed one installed package to the already pinned `0.0.81-bluclawd.1`; `package-lock.json` SHA-256 stayed `c30817c9811565730ee9161dfc4310c687c6756b6bfb2e26a3871520f1d11b34`.
- Full merged `npm test`: 1,335 passed / 3 failed across 111 files. The failures are the retained detached, double-fork, and owner-pipe-loss strict cleanup assertions. The suite is not green. Configurable-only pre-merge verification was 1,333/1,333; that is not a substitute for the merged result.
- Root `npm run typecheck` passed; `npm run lint` passed across 232 files. Hashed vendor patch context lines trigger ordinary whitespace checking and were preserved byte-for-byte; source/document diff checks exclude those two patch artifacts explicitly.
- No live model evaluation, new shared-agent implementation, or feature activation was performed as part of consolidation.

## Builder Review and Next Step

Author self-review only; no independent subagent tool is available in this session. Review identified and made explicit the same-authority external-delegation limitation, model-only/background execution feasibility, live policy inheritance, saved-role migration, completion/message semantics, and historical red tests.

The user's architectural choices are recorded above. Proposed orchestration guidance and detailed public-SDK wiring are assistant recommendations, not additional user mandates. Obtain approval of this written design, then write a fresh implementation plan; do not resume the superseded isolated-backend plan. No push, remote branch deletion, deployment, evidence-worktree deletion, or global Pi installation change is included.
