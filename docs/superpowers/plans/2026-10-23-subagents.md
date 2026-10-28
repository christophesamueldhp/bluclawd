# Subagent Implementation Plan

> **Historical scope (2026-10-27):** The user selected shared-workspace subagents with inherited parent authority, orchestrator-selected roles/models/thinking, no child-specific quotas, and two-way messaging. See the [replacement design](../specs/2026-10-27-shared-workspace-subagents-design.md), pending written-design approval and implementation. Earlier status/approval statements below describe that historical work, not current runtime requirements. All source/proof work is committed and consolidated into local `main`; failures remain failures. Do not resume this plan's superseded isolation gates.

**Status:** M0–M2 implementation and local release checks complete, with the evaluation/manual limitations recorded below. The current follow-on is `docs/superpowers/specs/2026-10-24-configurable-subagents-design.md`: configurable general-purpose/explorer/reviewer with hybrid per-run workspaces. The separate writer-role proposal is superseded; the current implementation plan is `docs/superpowers/plans/2026-10-24-configurable-subagents.md`. Shell/write capabilities remain unimplemented and cleanup safety is unresolved.
**Date:** 2026-10-23
**Project:** bluclawd, a feature package for Pi Coding Agent, not a Pi fork.
**Goal:** Delegate bounded coding-related tasks to independently managed child conversations without weakening permissions, leaking results across conversations, or misrepresenting task completion.

## 1. Execution rules

- Implement this plan only after an explicit implementation request. Writing this plan does not authorize code changes.
- Work in milestone order. A later milestone must not bypass an earlier release gate.
- Write failing tests for each new behavior, implement the smallest change, then run the named checks.
- Use public Pi APIs. Do not modify Pi-owned files, import private source paths, cast into private runtime fields, or copy Pi's agent loop.
- Use the repository's npm scripts and existing `package-lock.json`. Ask before adding dependencies or changing package manifests; do not copy outdated dependency instructions from older plans.
- Ask before commits, pushes, history changes, destructive cleanup, or deployment. This plan contains no automatic commit steps.
- Keep code, tests, comments, configuration, and documentation in English. Follow existing TypeScript formatting and `.ts` import conventions.
- Do not implement unrelated agent teams, a generic workflow engine, a new daemon, or a second task dashboard.
- Report actual command output. Expected results below are acceptance criteria, not claims that implementation tests have already passed.

## 2. Product decisions

### 2.1 What a subagent is

A subagent is a child conversation owned by one parent session and one originating delegation. It has its own prompt, transcript, model execution, tool access, limits, and lifecycle. It reports findings to its parent through a bounded result.

A subagent is not an independent Agent View session. Do not allocate a tmux pane, register another remote session, or add another daemon row for each child.

### 2.2 Release sequence

| Milestone | Deliverable | Release gate |
| --- | --- | --- |
| M0 | Public-API compatibility and lifecycle proof | Supported Pi/provider matrix, policy initialization, completion and cancellation tests |
| M1 | Foreground read-only subagents | Explorer/reviewer, bounded concurrency, isolated transcripts, enforced read restrictions, foreground cost/quality evaluation gate |
| M2 | Background read-only subagents | Correct ownership, result delivery, task controls, remote parity, accounting disclosure |
| M3 | Optional write-capable worker | Separate approval to implement; workspace, checkpoint, sandbox, and process-cleanup gates |

M1 and M2 are independently useful releases. M3 must not delay a reliable read-only release or be silently enabled through custom definitions.

### 2.3 Initial defaults

These are conservative starting values to evaluate, not claims of optimal settings:

| Setting | Initial decision |
| --- | --- |
| Context | Fresh child context; no parent conversation copy |
| Roles | `explorer` and `reviewer` |
| Model | Inherit the dispatching parent model and supported thinking level |
| Execution | Foreground in M1; explicit `background: true` opt-in in M2 |
| Active children | At most 2 per parent runtime, across all roles and modes |
| Waiting children | At most 4; reject further admission with a clear error |
| Nesting | Disabled; children have no delegation tool |
| Tools | Only approved `read`, `grep`, `find`, and `ls` implementations |
| Shell, monitor, MCP, codemode | Not available to M1/M2 children |
| Deadline | 5 minutes from admission, including queue time |
| Agentic turns | At most 12; a definition may lower, never raise, the ceiling |
| Child tool calls | At most 40, enforced before execution, plus early stop on repeated identical calls/denials |
| Provider retries | Bounded using supported Pi settings; no additional retry loop around a whole run |
| Reported token threshold | Stop at the next safe boundary after 100,000 accumulated reported tokens per run |
| Parent delegation budget | At most 6 child runs or 300,000 cumulative reported child tokens per parent turn (soft-stopped before admission) |
| Parent-facing result | At most 8 KiB of UTF-8 text, with structure-preserving truncation and a full-report reference |
| Automatic compaction | Disabled for these short-lived children; an exhausted context returns a partial/error outcome |
| Idle cache warming | Disabled for child sessions through supported settings |
| Restart behavior | No replay or auto-resume; unfinished persisted runs become `interrupted` |

Do not add a general settings UI for these limits initially. Keep named constants and test overrides. If evaluation demonstrates a need for user configuration, add only the settings that are justified.

Token and cost thresholds are not exact billing caps: in-flight requests, provider-internal retries, and missing usage data can exceed or obscure a threshold. Never display unknown usage or pricing as zero.

## 3. Current repository constraints

The following were verified during review and must be accounted for:

| Existing component | Consequence for implementation |
| --- | --- |
| `package.json` pins Pi development packages to `1.0.4`; the reviewed harness is `1.3.0` | Establish a supported API/version range before claiming compatibility |
| `ext/_shared/agent-tasks.ts` exposes `list()` and `stop()` but has no publisher | Reuse and extend this integration; it is not a completed runner |
| `agentTasksChanged()` is private and currently runs on publication/unpublication | Add an explicit source-change signal before relying on event-driven UI updates |
| `ext/background-bash/index.ts` rejects non-shell IDs in `task_stop` | Add agent dispatch to the existing tool, not another tool with the same name |
| `ext/background-bash/main-session.ts` forwards to the currently active main session | Do not use that sink for child reports |
| `ext/background-bash/tasks-dialog.ts` maps agent rows to `running` and has no agent output source | Add actual states and bounded agent details |
| `ext/remote/report.ts` already subscribes to agent task changes | Extend the existing report path, preserving shell behavior |
| `ext/permissions/index.ts` stores deny rules in an extension instance | A new SDK session needs its own initialized enforcement |
| `defaultProjectTrust` governs project configuration trust | It is not a general per-tool approval mode |
| `ext/sandbox/runtime.ts` owns one sandbox engine/configuration per process | Children must not independently reinitialize or stop it |
| `ext/background-bash/bash-tool.ts` detaches background commands from the caller signal | Child cancellation alone does not clean up detached processes |
| `endsWithFinalResponse` changes the shell result's explanatory text | It does not implement process cleanup |
| `ext/checkpoints/index.ts` attributes created files through parent tool events | Child writes require explicit checkpoint integration |
| `ExtensionContext` exposes `ModelRegistry`; SDK construction accepts `ModelRuntime` | Provider inheritance is not an automatic object substitution |

## 4. Architecture

```text
Parent Pi session
  |
  +-- subagent tool / extension lifecycle
        |
        +-- one parent-owned run manager
              +-- admission, queue, limits, cancellation
              +-- definition and policy snapshot
              +-- child SDK session with restricted resources
              +-- transcript / run record / usage ledger
              +-- bounded foreground result
              +-- session-bound background delivery (M2)
              +-- task source -> /tasks -> remote report (M2)
```

### 4.1 Runtime choice

Use the in-process Pi SDK first, subject to M0 proving the public-API contracts. It matches the existing process-local integration and avoids introducing IPC prematurely.

In-process isolation separates conversations, not operating-system permissions or process failure. A faulty trusted extension can still affect the host. State this limitation in user documentation.

If M0 cannot support the required provider or lifecycle behavior through public APIs, stop and present the specific incompatibility. Choose either a justified minimum Pi version or a subprocess design in a separate decision. Do not implement two runner backends speculatively or quietly reduce security.

### 4.2 Child resources

Construct each child with an explicit working directory, separate `SessionManager`, in-memory settings where appropriate, and a deliberately restricted resource loader.

Load only:

- The selected role's instructions.
- Applicable trusted project/user instructions, with the same trust decision as the parent.
- The delegated task and explicitly supplied context.
- Approved read/search tool implementations with bounded per-call output and narrowing hints (so a single broad search cannot exhaust the uncompacted child context window).
- Child-specific policy and lifecycle hooks.

Do not automatically load parent conversation history, all skills, prompt templates, MCP servers, arbitrary extensions, themes, branding, remote control, agent view, checkpoint UI, or sandbox lifecycle code.

An agent definition can specialize behavior but cannot remove mandatory project instructions or enforcement. Treat delegated task text as literal task input; disable command/template expansion for it through the supported prompt options.

Call the required extension binding API before prompting so child policy initialization has completed. Subscribe to events before starting a run. Do not call `process.chdir()`.

### 4.3 Provider inheritance

M0 must prove inheritance, not merely pass a model object into `createAgentSession()`.

- Resolve the dispatching model and thinking level once per run.
- Preserve provider endpoints, required headers, and request-time authentication through supported APIs.
- For registered providers, investigate the public configuration/native-provider accessors and registration APIs.
- Never persist or log provider credentials, copy access tokens into a transcript, or read private runtime fields.
- Do not implement a parallel OAuth refresh mechanism.
- A model change in the parent affects future children only.
- A missing or unsupported model/provider fails before starting work; no silent fallback.
- Virtual models require an explicit tested policy. Either preserve supported routing or reject them with an actionable message; never silently replace a virtual selection with an unrelated physical model.
- Do not reload arbitrary extensions just to recover a provider registration.

## 5. Public behavior and configuration

### 5.1 Delegation tool

M1 exposes:

```text
subagent({ agent: "explorer" | "reviewer" | customName, task: string })
```

M2 adds one optional field:

```text
subagent({ agent: customName, task: string, background: true })
```

Rules:

- The role must resolve to a valid, authorized definition.
- The task must be nonempty and bounded; reject oversized input rather than silently removing constraints. Start with a 32 KiB UTF-8 input ceiling.
- Use `model-only` exposure initially: this is an orchestration tool, not a tool to nest inside a codemode script.
- Register read-only delegation with Pi's parallel execution mode; independent foreground calls run under the manager's shared limit. Admission must remain atomic even when sibling tools execute concurrently.
- Do not add `tasks`, `chain`, `resume`, `send`, `fork`, or arbitrary `cwd` parameters in M1/M2.
- Do not let model-generated arguments raise limits or permissions.
- Validate before admission; an invalid call must not create a child session or consume a concurrency slot.
- A background acknowledgement reports `queued` or `running`, not successful task completion.
- Headless print/JSON invocations must not launch a background child that dies with the one-shot parent process. Reject `background: true` with guidance to use foreground execution. Prove RPC lifecycle before enabling background there.

The tool description should explain when delegation helps and when to work directly. Include the need for objective, relevant paths/context, scope, constraints, expected output, and stopping condition in the task. Do not force every task through an explorer/reviewer pipeline. Specifically:

- Prefer direct parent tool use (`grep`, `find`, `read`) for single-symbol lookups, known-file inspections, or tightly coupled sequential steps that take only a few local calls; multi-agent coordination adds latency and token overhead when the single agent can already solve the step directly.
- Reserve delegation for broad or parallelizable repository exploration that would pollute parent context, or independent review of a non-trivial diff/module.
- If the delegated task omits required inputs (such as an empty diff or nonexistent target path), the child must stop early and report the missing input in `Blockers` rather than guessing across the repository.

### 5.2 Agent definitions

Reuse Pi's exported frontmatter parser; do not add a YAML dependency.

Discovery precedence:

1. Project definitions from `<parent cwd>/.pi/agents/*.md`, only when the project is trusted.
2. User definitions from `<getAgentDir()>/agents/*.md`.
3. Bundled defaults.

For M1/M2, scan these directories only, without recursive traversal, ancestor search, or symlink traversal outside the selected directory. Honor `getAgentDir()` rather than hardcoding `~/.pi/agent`. Display the source of an overriding definition. Duplicate names within a scope are an error, not filesystem-order precedence.

Supported frontmatter:

| Field | Contract |
| --- | --- |
| `name` | Required bounded identifier; reject path separators and reserved task-ID syntax |
| `description` | Required short routing description |
| `tools` | Optional subset of the four read/search tools; omission uses the read-only set |
| `model` | Optional `inherit` or explicit `provider/model`; no unverified model aliases |
| `maxTurns` | Optional positive integer no larger than the runtime ceiling |

The Markdown body supplies role instructions. Unsupported capability fields such as `permissionMode`, `hooks`, `mcpServers`, or `isolation` must produce a clear unsupported-field diagnostic, not silently appear to work. Invalid selected definitions fail closed. Invalid unrelated definitions are reported but do not disable valid built-ins.

Bound file size and routing metadata: initially 32 KiB per definition, 512 characters per description, and 32 discovered custom definitions. On aggregate overflow, expose bundled defaults and a diagnostic rather than arbitrarily choosing a filesystem-order subset.

Discover on `session_start`/reload and freeze the resulting definitions for that runtime. Editing a definition requires `/reload` in the initial release. Running workers never change behavior mid-run.

### 5.3 Bundled prompts

`explorer`:

- Answer a focused codebase question.
- Return exact `path:line` citations, component relationships, inspected scope (files/directories checked vs. omitted), and remaining uncertainty.
- Stop when the question is answered or when required target paths are missing; do not scan unrelated modules or repeat identical searches.

`reviewer`:

- Review the supplied change description, diff, or explicit files.
- Prioritize actionable correctness/security regressions over stylistic preferences.
- Explain evidence (`path:line`), impact, inspected scope, and confidence; explicitly say when no actionable issue is found.
- Do not invent a test run. With no shell access, test execution is `not_run`.
- Acknowledge when a supplied diff, missing caller/test context, or changing working tree makes the review incomplete.

Neither role may modify code, claim user approval, change configuration, or spawn another agent. Because children run with fresh context, both roles must state any assumptions forced by missing parent context rather than guessing silently. The main agent supplies a diff when needed; do not grant general Bash solely to run `git diff`.

## 6. Security contract

### 6.1 Effective capabilities

Effective child capabilities are the intersection of:

1. The product's milestone-level capability ceiling.
2. The selected definition's permitted subset.
3. The parent's applicable restrictions.

Enforce at execution, not just in prompts or declarations. Pi's active tool set and its codemode-callable tools are distinct concepts. The child must not contain registered indirect tools that can restore forbidden capabilities.

Unknown tool calls fail. Tool annotations are hints, not proof of safety. Do not expose raw `tool.execute()` objects from the parent to bypass its validation or child enforcement.

Extend the existing deny-rule vocabulary narrowly: `Subagent` blocks all delegation, and `Subagent(explorer)` blocks a matching agent name using the existing glob semantics. Enforce these before admission. Do not advertise Claude Code's `Agent(...)` syntax as supported unless it is separately implemented and tested.

### 6.2 Reusable permission enforcement

Extract only the necessary deny evaluation and result filtering from `ext/permissions/index.ts` into a small reusable module. Keep parent UI and trust-badge behavior in the existing extension.

- Preserve existing parent behavior with regression tests.
- Initialize child policy from an explicitly validated parent-policy snapshot.
- Preserve path semantics, symlink handling, and search-result filtering.
- Direct reads, folder searches, and result rendering must not disclose denied content.
- Do not persist raw policy data unnecessarily; policies may contain sensitive paths.
- If child policy initialization is incomplete or malformed, refuse delegation rather than launching an unrestricted child.
- Existing malformed-setting behavior in the parent is outside this change; do not silently refactor it.

A fresh policy snapshot remains valid for that run. Reload or a policy-changing workflow that invalidates it cancels affected children before replacement. Do not implement live permission widening.

### 6.3 Report handling

A child report is untrusted data. Wrap parent-visible results as subagent output with an explicit statement that embedded instructions and approval claims are not user authorization.

Read-only tool filtering prevents direct child writes, but it does not prevent indirect prompt injection in repository files or diffs from manipulating a child's conclusions (such as hiding a defect in `reviewer`, steering `explorer` to misleading files, or planting instructions in the summary for a later parent turn that has write/shell access). Therefore:

- Require exact `path:line` evidence citations and keep quoted file excerpts short rather than copying untrusted instruction blocks verbatim into the parent context.
- Never treat a clean `reviewer` report as a standalone security gate or a substitute for deterministic tests and parent-side permission checks.
- Use structured custom messages for background completion, never `sendUserMessage()`.
- Do not render child text as terminal control sequences or HTML. Preserve useful quoted code; do not pretend a regex sanitizer makes prompt injection impossible.

The parent must still evaluate every subsequent action through its normal permission and sandbox mechanisms.

### 6.4 Retention and exposure

Transcripts and reports may contain repository content. Store them under Pi's user state, not inside the repository, and restrict file permissions where the platform supports it.

Use a dedicated directory such as `<getAgentDir()>/bluclawd/subagents/<parentSessionId>/<runId>/`. Derive IDs from trusted runtime values; never use model-supplied paths or names as directory traversal components.

Do not enable automatic deletion in M1/M2. Document retention and file locations. Later cleanup must be explicit and must not erase active or unreviewed work.

Remote task endpoints must resolve authorized task IDs to approved bounded output, not accept arbitrary filesystem paths or expose raw internal session transcripts.

## 7. Run lifecycle and ownership

### 7.1 Minimal run record

Keep a plain serializable record containing:

- Run ID, parent session ID, runtime generation, originating tool-call ID and originating entry ID.
- Child session ID and internal transcript/report locations.
- Agent name, definition source, effective provider/model and thinking level.
- Parent turn ID (for per-turn delegation budget tracking), parent working directory, and start/end workspace snapshot state (HEAD commit, dirty status, and drift flag).
- Admission/start/end timestamps and deadline.
- Delivery mode and lifecycle status.
- Tool-call count, repeated-call/denial loop counters, stop reason, bounded error information, result completeness, and reported usage.
- Whether foreground usage was already attributed to Pi and whether background delivery was attempted.

Keep process handles, `AbortController`s, callbacks, credentials, and live Pi contexts in memory only. Do not persist raw SDK objects. Diagnostics must omit authentication headers and credential objects; sanitize provider errors before storing or rendering them, with tests using synthetic secret markers.

### 7.2 State transitions

```text
queued -> starting -> running -> completed
   |          |          |
   +----------+----------+-> stopping -> cancelled | timed_out | budget_exceeded
              |          |
              +----------+-> failed

Persisted nonterminal state found without a live owner -> interrupted
```

Definitions:

- `completed`: execution ended normally, not necessarily that the requested task was solved.
- `failed`: initialization, provider, tool-runtime, or output failure prevented normal completion.
- `cancelled`: explicit cancellation finished cleanup.
- `timed_out` / `budget_exceeded`: a runtime limit ended execution; partial findings remain available.
- `interrupted`: the owning process/runtime is gone and successful completion cannot be established.
- `stopping`: cancellation was requested but cleanup is not yet confirmed.

Do not add `waiting_permission` before there is a genuine approval mechanism. M1/M2 read tools either run or are denied. M3 can extend the state machine when it implements parent-mediated approvals.

Only one finalization path may choose the terminal outcome. Late stream events cannot overwrite a terminal state or cause a second notification.

### 7.3 Scheduler

- Reserve admission synchronously before asynchronous setup to avoid oversubscription.
- Enforce per-turn/per-session parent delegation budgets before admission so a parent loop cannot serially spawn unbounded children that individually stay under per-run limits.
- Use one FIFO queue for both roles and modes; maximum 2 active and 4 queued.
- Expired or cancelled queued work never starts.
- Queue time counts against the deadline.
- Hold an active slot until work has actually stopped, not merely until abort was requested.
- Guard against within-run step repetition: if a child issues repeated identical `(tool, canonicalArgs)` calls or repeated policy denials without progress, terminate the run early with `budget_exceeded` and partial findings rather than burning the full 40-call limit.
- Release subscriptions, timers, and slots through one idempotent cleanup path.
- Do not retry an entire child run automatically after it may have performed work.
- Return overload promptly with advice to wait for existing results; do not encourage a spawn-retry loop.

### 7.4 Completion and cancellation

Subscribe before calling `prompt()`. Use Pi's documented settled boundary, and inspect the final response/error state. Do not finalize on `agent_end` alone or assume a resolved prompt always means a successful answer.

Classify provider errors, aborts, and output-length termination. An incomplete answer must carry `complete: false` even if useful text exists.

Foreground work is owned by the invoking tool's cancellation signal. Background work, once admitted, is owned by its run manager rather than the completed launch call. All work remains subject to session invalidation and explicit task stop.

Do not await `child.abort()` from a child callback if that would wait for the same callback to finish. Route cancellation through the manager and test the relevant event ordering.

`dispose()` is cleanup, not proof that every operation has settled. Search tools can also spawn processes; test their cancellation even without Bash. If an operation ignores cancellation, keep the run visibly `stopping` and do not release its slot as if it had ended. A genuine hard-kill requirement is a reason to reconsider subprocess isolation, not to fabricate a cancelled state.

### 7.5 Parent lifecycle policy

| Event | Required behavior |
| --- | --- |
| Foreground parent tool aborted | Cancel that call's child whether queued, starting, or active |
| Parent completes its ordinary response | Keep admitted M2 background children alive |
| Stop through `/tasks`, remote, or `task_stop` | Cancel the named owned child; no automatic resumption |
| `/clear` or `/new` | Invalidate generation, cancel all owned children, suppress stale delivery |
| `/resume` or session replacement | Same; no result routed to the destination session |
| `/reload` | Cancel and drain old children before the new publisher becomes authoritative |
| `/fork` that replaces the parent session | Cancel old children; do not clone live runs |
| Tree navigation/rewind away from origin | Cancel runs whose originating entry is no longer on the active branch |
| Parent model switch | Existing children keep their captured model; future runs inherit the new selection |
| Process quit | Cancel/drain within the host's shutdown contract; persist unfinished state for recovery |
| Process crash | Next startup classifies orphaned nonterminal runs as interrupted, without replay |

Do not compare the current leaf ID for equality with the original leaf: ordinary new messages change the leaf. Check ancestry/origin membership in the active branch and runtime generation.

In M3, code restore must stop and drain writers before any restoring filesystem operation, including restore-code-only paths that do not navigate the conversation tree.

## 8. Results, persistence, and accounting

### 8.1 Result envelope

The runtime owns identity, status, model, usage, timing, workspace `Snapshot`, `Verification` status, truncation, and artifact references. The worker writes only the `Scope`, `Summary`, `Evidence`, and `Blockers` sections. Never let worker prose forge `Verification` (`not_run` in M1/M2 where shell execution is disabled, and runtime-observed command/exit metadata in M3) or `Snapshot`.

A result should communicate:

```text
Run: <id>
Execution: <terminal state>
Complete: <true | false>
Snapshot: <HEAD commit / dirty state at start, plus drift warning if repo changed before completion>
Scope: <inspected files/paths and omitted or unverified areas>
Summary: <bounded worker report>
Evidence: <file locations or supplied source references>
Verification: <observed commands/results, or not_run>
Blockers: <known blockers, missing context, or uncertainties>
Full report: <authorized artifact reference>
```

Do not require a second LLM to turn every answer into JSON. Use a stable runtime envelope and a simple report template. Use `details` for bounded machine-readable runtime data. If an `outputSchema` is declared, return matching `structuredContent` on every relevant path.

Save the full report before truncating parent-visible text. Use structure-preserving truncation so `Snapshot`, `Scope`, `Evidence`, `Verification`, and `Blockers` survive even when narrative prose is trimmed; do not slice raw tail bytes that drop citations or uncertainty notes. Because the persisted `Full report` lives under Pi user state outside the repository, `Evidence` must retain actionable repository `path:line` citations that the parent can inspect directly with `read`, while `/tasks` and remote task-output endpoints expose bounded authorized views of the stored report. Do not add all child tool output or intermediate reasoning to the parent context.

### 8.2 Foreground return

Return only after the child is finalized. Follow the supported Pi tool-error contract established in M0 so failures are actually marked as errors, rather than only mentioning an error in a successful-looking text result.

Preserve structured failure diagnostics where supported. Empty final text after a failed model call must not be treated as a successful empty report.

### 8.3 Background delivery

- Return an acknowledgement with the run ID after admission.
- Persist the final result before attempting notification.
- Use a session-bound delivery function, not `mainSession.sendMessage`.
- Recheck parent session, generation, origin-branch membership, and stop/invalidation state immediately before sending.
- If the tasks panel holds notifications, recheck all of these when the hold is released.
- Deliver a completion custom message through the supported queueing API, normally as a follow-up with a triggered turn.
- Do not interrupt an already accepted user cancellation merely to announce that the cancellation succeeded. Match existing user-stop notification semantics and avoid an unsolicited new turn for user-stop acknowledgements.
- Batch closely arriving completion notices into one parent wake-up when possible, without losing individual run IDs and outcomes.
- Never claim exactly-once delivery across a crash without an atomic host persistence mechanism. Guarantee one terminal record and at-most-once delivery attempt per live runtime; retain undelivered results for explicit inspection after restart.

### 8.4 Persistence

Use Pi session storage for the child transcript. Maintain only a small companion run record and final report; do not duplicate every stream delta in a new event database.

Persist admission and terminal transitions atomically where possible. Check storage availability before launching. If report persistence fails, report that failure and preserve available output in memory; do not return a fictitious file path.

Record a bounded run reference in the parent through `appendEntry()` so it survives compaction. Reconstruct branch-sensitive visibility from the active branch, not all abandoned entries.

On restart, reconcile the current parent's referenced runs. Do not scan unrelated projects or resume arbitrary historical children. Keep interrupted reports available without triggering new work automatically.

### 8.5 Usage

- Sum finalized child usage, including reported retries and any supported non-message usage entries.
- Do not sum streaming deltas and finalized messages twice.
- M1 returns child usage in the outer tool result using Pi's documented `usage` contract.
- M2's launch result cannot contain future usage. If the supported public API cannot append native parent usage later, maintain a separate child ledger and label it clearly.
- Never cast the parent's read-only session manager into a mutable manager or rewrite its JSONL file directly to insert usage.
- Distinguish child totals already included in foreground tool results from background totals that are not included. Do not add both again when building a combined display.
- Do not promise Pi's native `/session` includes background child costs unless an integration test proves it.
- Display unknown price as unknown and subscription usage as usage, not a fabricated cash invoice.
- Account for failed, cancelled, and interrupted requests when usage is available; indicate incomplete accounting otherwise.

## 9. Task UI and remote integration

Extend the existing `AgentTaskSource`; do not replace the shell registry.

Required source capabilities in M2:

- List owned active runs, with their actual state and timestamps.
- Find a run by ID within the owning parent runtime.
- Request stop with caller/source metadata.
- Announce admission, progress, stopping, and terminal transitions.
- Supply a bounded display/report excerpt without exposing a raw SDK session.

Keep the shared source published only by the parent. Cleanup from an old runtime must not unpublish a newer source.

`task_stop` dispatches shell IDs to the existing shell path and agent IDs to the parent-owned source. Choose a distinct agent-ID prefix; do not change existing shell-ID validation. A missing or unauthorized ID fails without revealing another parent's task content.

Preserve `/tasks` as an active-work view: show queued, starting, running, and stopping agent rows. Terminal results are persisted and surfaced through the parent transcript; do not expand this milestone into a historical task browser. If a detail view is already open when a child ends, allow it to show the final report until dismissed.

Use `STATUS_KEYS.subagents` for a compact child status indicator if needed; do not create another footer implementation or mix child counts into Agent View's independent-session count.

Remote requirements:

- Extend `PaneTask` with backward-compatible optional agent state/model fields.
- Stop targets the same run as local `/tasks`.
- State changes produce event-driven reports, not another polling loop.
- If output is exposed, serve only an authorized bounded report/progress view. Raw transcript files, credentials, and hidden reasoning are not phone task-output content.
- Missing new fields from an older report must retain current behavior.
- Cap remote payloads using the existing task/report bounds.

## 10. File organization

Create modules when the corresponding milestone needs them; do not add empty future scaffolding.

| File | Responsibility |
| --- | --- |
| `ext/subagents/index.ts` | Tool registration, lifecycle binding, parent-owned manager and publication |
| `ext/subagents/definitions.ts` | Bundled/user/project discovery, validation, precedence |
| `ext/subagents/agents/explorer.md` | Bundled explorer instructions |
| `ext/subagents/agents/reviewer.md` | Bundled reviewer instructions |
| `ext/subagents/runner.ts` | Public Pi SDK child construction, provider compatibility, policy binding, stream observation |
| `ext/subagents/runs.ts` | Scheduler, identity, limits, cancellation, terminal transition |
| `ext/subagents/results.ts` | Bounded envelopes, safe display, usage aggregation, session-bound delivery |
| `ext/subagents/storage.ts` | Run records, report artifacts, recovery reconciliation |
| `ext/permissions/policy.ts` | Minimal shared deny checking/result filtering extracted from existing behavior |
| `ext/_shared/agent-tasks.ts` | Task-source contract and explicit change notifications |

M2 modifies the existing task tool/dialog, remote report/protocol, and remote task display only where needed. M3 may add `workspace.ts` after its design gate. Keep types near the owning module instead of building a generic event-bus/framework layer.

Register the extension after `background-bash` and before consumers such as remote reporting in both `package.json` and `ext/index.ts`. Keep `permissions` and `sandbox` first. Update the manifest only with approval to make implementation changes.

## 11. Implementation tasks

Each task follows: write tests -> observe failure -> implement -> run focused checks -> inspect the diff. Checkboxes remain unchecked until completed with evidence.

### Task 0 — Establish baseline and Pi compatibility (M0)

**Files:** existing package metadata; new `test/subagents-sdk.test.ts` and minimal test helpers as needed.

- [x] Read the installed Pi `docs/sdk.md` and `docs/extensions.md` completely, then relevant linked lifecycle/storage docs and examples `06-extensions.ts`, `11-sessions.ts`, `12-full-control.ts`, and `14-codemode-mcp.ts`.
- [x] Compare the locally installed `1.0.4` declarations with the supported deployment version; do not assume documentation from another version is identical.
- [x] Record the clean/dirty working-tree baseline and run existing typecheck and focused integration tests.
- [x] Build an offline scripted-provider SDK test using public registration APIs. Do not contact real providers or read the developer's credentials.
- [x] Prove event subscription before prompt, required `bindExtensions()` initialization, settled completion, provider failure, output-length termination, cancellation during initialization/retry, and disposal.
- [x] Prove model/thinking inheritance for built-in, configured, and extension-registered providers using fixtures. Test virtual-model behavior explicitly.
- [x] Prove child usage can be returned through the outer tool contract without duplication.
- [x] Verify the foreground error-result contract for the chosen Pi versions.
- [x] Decide the supported Pi range. If a version/dependency change is necessary, ask before changing it. If public API support is insufficient, stop and present the exact gap.

**Verify:** `npm run typecheck`; `npm test -- test/subagents-sdk.test.ts`.
**Exit criterion:** no private API access, no real network calls, and no untested provider-inheritance claim.

### Task 1 — Agent definitions and bundled roles (M1)

**Files:** `ext/subagents/definitions.ts`, bundled role Markdown, `test/subagents-definitions.test.ts`.

- [x] Test valid frontmatter, required fields, invalid YAML, unknown capability fields, unsafe names, oversized files, duplicate names, precedence, and bounded routing descriptions.
- [x] Test trusted versus untrusted project definitions and overridden agent directories.
- [x] Test that custom definitions cannot add Bash/MCP/codemode/delegation or raise limits.
- [x] Implement discovery with deterministic ordering and actionable diagnostics using Pi's parser.
- [x] Add concise explorer/reviewer prompts requiring `path:line` evidence, inspected/omitted `Scope`, explicit assumptions under fresh context, and fast-stop into `Blockers` when required target paths or diffs are missing.
- [x] Freeze definitions for the runtime; test that reload, not a mid-run edit, changes the selected definition.

**Verify:** `npm test -- test/subagents-definitions.test.ts`.
**Exit criterion:** the parent sees only valid, bounded descriptions; selected invalid definitions never silently fall back.

### Task 2 — Reusable read policy (M1)

**Files:** `ext/permissions/policy.ts`, narrowly modify `ext/permissions/index.ts` and `ext/permissions/rules.ts`; `test/subagents-policy.test.ts`, existing permission tests.

- [x] Add regression tests for current parent deny matching and grep filtering before extracting code.
- [x] Extract UI-free evaluation/filtering while preserving behavior.
- [x] Add and test `Subagent` / `Subagent(agentName)` deny rules against the delegated agent name; rejection must happen before admission or model activity.
- [x] Test denied direct reads, relative/absolute paths, symlink escape, recursive search, and sanitized structured/text results where applicable.
- [x] Test child failure before execution if its policy is uninitialized or malformed.
- [x] Test that an allowed-looking tool declaration cannot reach an unregistered forbidden tool.
- [x] Test that role instructions and task text cannot grant permission or activate project configuration.

**Verify:** `npm test -- test/permissions-deny.test.ts test/subagents-policy.test.ts`.
**Exit criterion:** existing parent behavior is unchanged and every child access passes the new gate.

### Task 3 — Run state, admission, and limits (M1)

**Files:** `ext/subagents/runs.ts`; `test/subagents-runs.test.ts`.

- [x] Define the minimal run identity and lifecycle state types.
- [x] Test two active runs, four queued runs, overload rejection, FIFO admission, and simultaneous start requests.
- [x] Test cancellation/deadline before admission completes, while queued, during startup, while streaming, and during a tool call.
- [x] Test per-turn parent delegation budgets (6 child runs or 300,000 cumulative reported child tokens per parent turn) and verify the budget resets on a new parent turn.
- [x] Test per-run budget exhaustion, repetitive-call/repeated-denial loop termination (`budget_exceeded` with partial findings), abort-versus-completion races, late events, and duplicate finalization attempts.
- [x] Keep slots occupied until cleanup completes; test a non-cooperating runner remains visibly stopping.
- [x] Make timers/listeners/abort links idempotently disposable.

**Verify:** `npm test -- test/subagents-runs.test.ts`.
**Exit criterion:** no oversubscription, leaked timer, double terminal outcome, or queued run starting after invalidation.

### Task 4 — Restricted child runner (M1)

**Files:** `ext/subagents/runner.ts`; extend `test/subagents-sdk.test.ts`; add `test/subagents-runner.test.ts`.

- [x] Implement explicit model resolution and the M0-approved provider path.
- [x] Build the child SDK session with only selected resources and approved tools.
- [x] Bind policy/lifecycle hooks and subscribe before prompting.
- [x] Disable unintended template/command execution, auto-compaction, and idle warming.
- [x] Implement tested turn/tool/deadline enforcement and repetitive-call loop detection without a second autonomous retry loop.
- [x] Inspect final state after settled completion; preserve partial output and actual error cause.
- [x] Drain cooperative operations before disposal and retain visibility of unresponsive cancellation.
- [x] Assert no parent UI, main-session sink, sandbox reset, MCP connection, or agent-view registration is touched.

**Verify:** `npm test -- test/subagents-sdk.test.ts test/subagents-runner.test.ts`.
**Exit criterion:** child resource isolation works against the real SDK with an offline scripted provider, not just a mocked runner interface.

### Task 5 — Reports, storage, and usage (M1)

**Files:** `ext/subagents/results.ts`, `ext/subagents/storage.ts`; `test/subagents-results.test.ts`, `test/subagents-storage.test.ts`.

- [x] Test UTF-8 output limits, empty output, structure-preserving truncation (keeping `Snapshot`, `Scope`, `Evidence`, `Verification`, and `Blockers` intact when `Summary` prose is trimmed), terminal-control escaping, and runtime-owned metadata (`Execution`, `Complete`, `Snapshot`, `Verification`) that worker prose cannot spoof.
- [x] Test workspace snapshot capture at start and drift warning generation when `HEAD` or working-tree state changes before child completion.
- [x] Save full reports and child transcripts outside the repo; test restrictive permissions where supported.
- [x] Test atomic run-record updates, invalid paths, inaccessible storage, and report-write failure.
- [x] Test usage aggregation across successful/error responses without counting deltas twice.
- [x] Record parent references through supported custom entries, not direct parent JSONL writes.
- [x] Test interrupted-run reconciliation and ensure restart never replays work.
- [x] Test malicious report text (both fake user-approval claims and defect-suppression / instruction-planting payloads) stays marked as untrusted subagent data with bounded quotes.

**Verify:** `npm test -- test/subagents-results.test.ts test/subagents-storage.test.ts`.
**Exit criterion:** every reported artifact exists, partial results are labeled, and secrets are absent from diagnostic/configuration records.

### Task 6 — Foreground tool integration (M1)

**Files:** `ext/subagents/index.ts`, `package.json`, `ext/index.ts`, `README.md`; `test/subagents-tool.test.ts`, `test/registration.test.ts`.

- [x] Register the single model-only delegation tool and its bounded descriptions.
- [x] Wire one manager per parent runtime; do not start work in the extension factory.
- [x] Return foreground usage and the verified Pi error/result envelope.
- [x] Link foreground cancellation and test concurrent sibling tool calls through Pi's real dispatch path.
- [x] Bind session shutdown/reload and origin-branch invalidation without touching unrelated shell behavior.
- [x] Update both extension lists, registration assertions, and concise user documentation.
- [x] Test TUI-independent behavior in print/JSON and no duplicate registration with the installed extension set. Report a conflicting third-party `subagent` tool clearly; do not silently replace it.

**Verify:** `npm test -- test/subagents-tool.test.ts test/registration.test.ts test/subagents-sdk.test.ts`; `npm run typecheck`; `node --experimental-strip-types scripts/probe-extensions.ts`.
**M1 release gate:** all M1 acceptance tests pass, unsupported providers are documented explicitly, and the foreground evaluation subset in Task 10 demonstrates acceptable cost/quality parity before enabling M2 background or M3 write capabilities.

### Task 7 — Background execution and session-bound delivery (M2)

**Files:** extend `index.ts`, `runs.ts`, `results.ts`, `storage.ts`; `test/subagents-background.test.ts`, `test/subagents-lifecycle.test.ts`.

- [x] Add explicit background admission and early acknowledgement without inheriting the finished launch call's lifetime.
- [x] Reject unsupported one-shot modes and test RPC before enabling it.
- [x] Persist final outcomes before notification and guard every delivery with session/generation/branch checks.
- [x] Integrate notification holds with a second ownership check on release.
- [x] Test new/resume/reload/fork/tree navigation while starting, queued, running, stopping, and awaiting delivery.
- [x] Test a completed parent turn does not kill a valid background child, and that parent edits or commit changes while the background child runs surface a `Snapshot` drift warning on delivery.
- [x] Test failure and timeout notifications as thoroughly as success; user cancellation must not auto-resume the parent unexpectedly.
- [x] Test delayed completion batches do not reorder user input or trigger redundant turns.
- [x] Implement the separate background usage ledger if native parent attribution is unavailable; document the distinction.

**Verify:** `npm test -- test/subagents-background.test.ts test/subagents-lifecycle.test.ts test/main-session.test.ts test/notification-hold.test.ts`.
**Exit criterion:** no child completion can reach the wrong session or an abandoned branch; the shell main-session sink remains unchanged.

### Task 8 — Task source, stop, and local UI (M2)

**Files:** `ext/_shared/agent-tasks.ts`, `ext/background-bash/index.ts`, `ext/background-bash/tasks-dialog.ts`, subagent registration/rendering; `test/agent-tasks.test.ts`, `test/subagents-stop.test.ts`, existing task tests.

- [x] Extend the task-source contract with ownership, state, bounded details, and explicit change notification.
- [x] Test that cleanup from a stale publisher cannot remove its replacement.
- [x] Route agent IDs through the existing `task_stop`; preserve shell error/ownership behavior.
- [x] Track stop source and show stopping until cleanup actually finishes.
- [x] Add correct agent state/detail rendering and the optional subagent status indicator through existing UI APIs.
- [x] Test active rows, selected-row disappearance, completion while detail is open, output sanitization, and stop ownership.
- [x] Ensure UI render functions do not parse entire transcript files or initiate model work.

**Verify:** `npm test -- test/agent-tasks.test.ts test/subagents-stop.test.ts test/tasks-dialog.test.ts test/task-stop-shell.test.ts test/background-bash-render.test.ts`.
**Exit criterion:** one task-control path, no duplicate tool, no incorrect running/success display.

### Task 9 — Remote task parity (M2)

**Files:** `ext/remote/report.ts`, `daemon/ipc/protocol.ts`, relevant remote HTTP/output handling, `daemon/remote/web/statusbar.js`, `daemon/remote/web/app.js`; existing remote tests plus `test/subagents-remote.test.ts`.

- [x] Extend optional task metadata without breaking shell/monitor reports.
- [x] Test task-source events update reports promptly and remain bounded.
- [x] Route remote stop to the same owned agent run as local stop.
- [x] If exposing agent output, provide a bounded authorized report/progress source rather than a raw transcript path.
- [x] Test cross-session access denial, output path safety, HTML escaping, and missing legacy fields.
- [x] Display separate background usage accurately if added; avoid counting foreground usage twice.

**Verify:** `npm test -- test/remote-report.test.ts test/remote-http.test.ts test/remote-web-statusbar.test.ts test/subagents-remote.test.ts`; `npm run typecheck`.
**Exit criterion:** local and phone status/stop agree; no new remote filesystem-read capability is introduced.

### Task 10 — Evaluation and M1/M2 release checks

**Files:** new deterministic integration tests; small scenario fixtures under `test/fixtures/subagents/` only if needed; update `README.md`.

- [x] Add the acceptance matrix in section 13 as executable tests wherever possible.
- [x] Define approximately 20 representative quality scenarios split into a prompt-tuning development set and a held-out evaluation set: simple single-file lookups (to measure over-delegation), cross-module exploration, review with seeded bugs, clean diffs (to measure false-positive review noise), incomplete context, denied access, provider failure, cancellation, and indirect prompt injection (both approval-spoofing and defect-suppression payloads).
- [ ] Run the foreground subset at the M1 gate before starting M2, then add background/remote scenarios at the M2 gate. Deterministic foreground checks ran before M2, but live quality comparisons were deferred until after M2; this sequencing deviation cannot be retroactively satisfied.
- [x] Perform cost-controlled comparisons between single-agent and delegated runs on the same repository snapshot, model ID, thinking level, and matched total token/turn budget.
- [x] Measure multi-trial consistency (`pass^k`, where all `k` trials succeed, e.g. `k = 3`) rather than only `pass@k` (at least one success in `k` retries), keeping deterministic correctness tests separate.
- [x] Obtain permission before paid/networked model evaluations. Use scratch projects and no production secrets. The user's subsequent request to finish all remaining items authorized live evaluation and local commits, not pushes or deployment.
- [x] Document actual `pass^1`, `pass^k`, latency, total parent+child token cost, unnecessary delegation rate, unsupported cases, and any skipped validation. Do not assert a numerical quality win without measurements.
- [x] Run the full local verification commands in section 14.

**M2 release gate:** all safety/lifecycle tests pass, no regressions in existing task controls, and live quality results or explicitly disclosed evaluation limitations are available.

### Recorded M1/M2 release evidence

- `npm run typecheck`: exit 0 (`tsc --noEmit && tsc -p daemon/remote/web`).
- `npm run lint`: exit 0, `Checked 214 files`, no fixes applied.
- `npm test`: `101 passed (101)` files, `1174 passed (1174)` tests, no unhandled errors.
- Extension probe: `TOTAL: 12 extensions, 10 commands`; one `subagent` tool.
- `git diff --check`: exit 0. This working tree is retained on `feat/read-only-subagents`; no push, merge, deployment, or worktree deletion was authorized or performed.
- Author self-review (no independent reviewer tool available) found and fixed reload ID collisions, repeated-prompt admission budget reuse, missing private transcripts, lost global instructions in untrusted projects, admission after asynchronous session invalidation, undisclosed unknown/background costs, and stale SDK-disposal notification callbacks. Each behavior was reproduced by a failing regression test and then verified green. The batching test now controls its timer rather than assuming sibling cleanup finishes within 40 ms under load; lifecycle tests wait for persisted terminal states rather than sleeping for 80 ms. Both timing assumptions failed during full-suite verification before being corrected. Self-review is weaker than independent review.

Live evaluation used `scripts/eval-subagents.ts`, `openai-codex/gpt-6.1-sol`, thinking `off`, synthetic scratch repositories with no production secrets, and three trials for each strategy/scenario. Both strategies received the same combined parent+child allowance (10 requests, 100k token allowance per trial, 1,000 output tokens per request, 60-second deadline). A shared conservative reservation guard constrained estimated cost to US$10 and token usage to 2M. Known usage refunds unused reservations only after a request completes. Each baseline/delegation pair used the exact same fixture commit; development and holdout batches used commits `cdfb79449943fa85d0ff7d0d548ae06b90d18d06` and `6e7ae714ad35e2e7ccbae96194965e2c139a8233` respectively.

| Split / strategy | Trials | Marker pass^1 | Marker pass^3 | Mean latency | Total parent+child tokens | Estimated cost | Unnecessary lookup delegation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Dev / direct baseline | 24 | 100% | 100% | 6.652 s | 60,393 | $0.124679 | 0% |
| Dev / delegation | 24 | 100% | 100% | 15.193 s | 165,612 | $0.270978 | 0% |
| Holdout / direct baseline | 24 | 100% | 100% | 6.590 s | 59,322 | $0.110975 | 0% |
| Holdout / delegation | 24 | 100% | 100% | 14.699 s | 164,927 | $0.252784 | 0% |

These 96 completed quality trials cover 16 live scenarios (eight dev, eight holdout); the four provider-failure/cancellation catalog scenarios use deterministic SDK tests instead. Valid comparison trials total 450,254 reported tokens and approximately $0.7594 in price-table estimates, not a subscription invoice. On these small fixtures, forced delegation took longer and used more tokens/cost without improving marker success. No production quality advantage or parallel speedup is established.

Evaluation limitations and deviations:

- The initial routing pilot made no child delegations. The comparison protocol therefore explicitly requests one foreground delegation for non-lookup tasks; simple lookups remain autonomous controls. This measures forced delegation, not general routing quality. Holdout prompts were not tuned from outcomes.
- An initial holdout attempt exhausted the evaluator's unreleased worst-case reservations despite low actual usage. It is an infrastructure failure, not a model-quality failure. The reservation bug was reproduced/fixed/tested, and holdout was rerun with identical prompts; only the completed rerun contributes to the table. Pilot/interrupted-attempt usage is additional to the comparison cost above.
- An Anthropic probe failed with insufficient credit. The configured Codex model succeeded; other live providers were not validated.
- Fixtures and regex markers are deliberately limited. They do not establish production review precision, parent-context growth, or semantic prompt-injection resistance against an adaptive attacker. Clean-file review is a proxy, not a full production diff benchmark.
- The live batches predate some final lifecycle/persistence hardening; those changes were verified with real-SDK deterministic regression tests and the full suite, not another full paid evaluation.
- Live TUI interaction, a paired physical phone, Linux sandbox execution, and platform-specific writer cleanup were not run. Local/remote ownership, output authorization, HTML escaping, stopping, notification holds, restart reconciliation, and accounting have executable coverage instead. The M1-before-M2 live quality sequencing gate was missed and is left unchecked above rather than retroactively claimed.
- Raw local artifacts are retained in `.superpowers/sdd/2026-10-23-subagents/`: `routing-pilot.json`, `live-results.json` (use its dev rows only), and `holdout-results.json` (completed holdout rerun). This directory is ignored by Git; this plan records the durable results. No user settings were changed to make checks pass.

## 12. M3: optional write-capable worker

**Historical scope:** the separate writer role is no longer requested. See `docs/superpowers/specs/2026-10-24-configurable-subagents-design.md` for the selected role catalog and hybrid workspace policy. Preserve the safety evidence below; this section does not authorize resuming the old task plan.

M3 is a separately approved follow-on, not a hidden custom-definition capability. Do not simply add `bash`, `edit`, and `write` to the read-only allowlist.

### 12.1 Workspace decision

Prefer an isolated worktree based on the parent's exact selected commit, not an implicit default branch.

Initial writer policy:

- Require a Git repository with a clean parent working tree for isolated writer launch.
- If the parent is dirty, refuse isolated launch and offer normal parent-agent implementation. Do not silently commit, stash, reset, or copy a partial working tree.
- Record the exact base commit and workspace identity.
- Give each worker a separate working tree. Keep the default to one writer until conflict/integration tests justify more.
- Return a diff/artifact and test evidence; do not auto-merge, commit, push, or delete the worktree.
- Before applying a result, verify the parent still matches the expected integration base and obtain the required user authorization.
- Preserve unmerged changes and clearly report workspace location after cancellation/failure.

### 12.2 Writer policy and sandbox gate

Before implementation, prove how one process-wide sandbox safely supports a different workspace and policy. Never update its global configuration per child while parent commands are running.

Investigate supported per-command restriction APIs. If correct isolation cannot be achieved, stop and propose a subprocess writer or a narrower capability set. Do not claim worktree isolation alone is a security boundary.

Feasibility evidence: sandbox-runtime `0.0.81` exposes a public per-call `customConfig` argument to `wrapWithSandbox`. `test/subagents-writer-sandbox.test.ts` passed two real macOS sandbox tests: a worker-only allowlist and parent deny leave a concurrent parent command/configuration unchanged; parent writes through a symlink and Git's shared worktree directory are blocked. This proves only shell filesystem restriction feasibility on the tested platform. It does not prove safe direct file tools, complete process cleanup, Linux behavior, or checkpoint integration. No writer capability has been registered. Proposed next decision: a subprocess writer with its own sandbox lifecycle, a clean-parent exact-base worktree, and patch-only return without automatic integration. The user approved the subprocess direction and then the detailed design in `docs/superpowers/specs/2026-10-24-subagent-writer-design.md`. The task-level follow-on is `docs/superpowers/plans/2026-10-24-subagent-writer.md`; plan review and the real-backend safety gate precede implementation/activation.

Re-anchor repository-relative restrictions to the child workspace while retaining absolute restrictions and denying writes to the parent checkout. Test paths through symlinks and Git redirect mechanisms. Shell restrictions must apply to actual processes, not only a list of suggested allowed files.

### 12.3 Writer tasks

- [ ] Add an explicit writer definition/capability type after the workspace and sandbox decision is approved.
- [ ] Implement isolated workspace creation with recorded base identity and dirty-tree refusal.
- [ ] Implement direct file-tool and shell restrictions against the selected workspace.
- [ ] Keep commits, pushes, deployments, migrations, and destructive operations subject to explicit authorization.
- [ ] Attribute every child process to both its run and parent owner; test stop authorization and full process-tree cleanup.
- [ ] Prevent detached commands from outliving a terminal writer by default. If transferring a service is ever needed, make transfer an explicit future operation.
- [ ] Integrate patch application with the parent's checkpoint capture and created-file tracking. Do not treat the child conversation as the source of parent checkpoints.
- [ ] Stop and drain any shared-checkout writer before checkpoint restore; do not rely on parent idle state.
- [ ] Test parent changes while a worker runs, conflicting patches, base mismatches, new/deleted files, cancelled tests, and failure during integration.
- [ ] Record runtime-observed command execution and exit codes in `Verification` rather than trusting worker-written test claims; run focused and regression tests on the integrated parent tree, since a test that passed only in a worktree is not proof that integration passes.
- [ ] Require independent review where useful, but do not use reviewer agreement as a substitute for tests or user approval.

**Likely files:** `ext/subagents/workspace.ts`, runner/policy extensions, `ext/checkpoints/index.ts`, child shell adapters, and dedicated workspace/checkpoint/cleanup tests. Add only after M3's design gate; avoid prebuilding these abstractions in M1.

**M3 release gate:** demonstrable workspace isolation, honest test evidence, safe patch integration, complete process ownership, and no checkpoint/rewind regression.

## 13. Acceptance matrix

| Area | Required test or observation |
| --- | --- |
| Registration | Exactly one delegation tool; manifest and extension list agree; no factory starts resources |
| Discovery | Correct scope precedence; untrusted project definitions ignored; duplicate/invalid definitions diagnosed |
| Delegation control | `Subagent` and role-specific deny rules prevent admission and incur no child model usage |
| Tool isolation | Child cannot reach Bash, write/edit, MCP, codemode, or nested delegation in M1/M2 |
| Read restrictions | Denied direct reads and recursively searched content remain undisclosed |
| Context | Child receives intended rules/task but no parent history or unrelated skills/templates |
| Provider inheritance | Supported configured/registered providers work; unsupported selections fail explicitly |
| Scheduler | Concurrent starts never exceed two active/four waiting; per-turn parent delegation budget is enforced; overload is bounded |
| Cancellation | Queued and active runs stop correctly; cleanup is idempotent; no slot is released early |
| Completion | Low-level end followed by retry does not finalize; repetitive tool loops stop early as `budget_exceeded`; final errors/partial output remain failures/partial |
| Ownership | New/resume/reload/fork/tree changes cannot receive stale reports; background workspace drift is flagged in `Snapshot` |
| Notification holds | Releasing a held callback after a switch does not deliver into the new conversation |
| Persistence | Admission/terminal records survive; report references exist; orphaned runs become interrupted |
| Accounting | Foreground usage is counted once; background/native totals are distinguished; unknown cost is not zero |
| Task controls | Local, model-issued, and remote stop name the same owned run |
| Rendering | Terminal escapes/HTML cannot execute; structure-preserving truncation keeps `Snapshot`, `Scope`, `Evidence`, `Verification`, and `Blockers` intact |
| Prompt injection | Worker approval claims and defect-suppression/instruction-planting payloads remain untrusted data; they cannot widen capability, suppress parent verification, or impersonate the user |
| Headless modes | Foreground works without TUI; unsupported background modes fail explicitly |
| Resource cleanup | No leaked listener, timer, SDK session, or read/search subprocess after cooperative completion |
| Evaluation gate | Dev/holdout split, cost-controlled single-agent baseline comparison, and multi-trial `pass^1`/`pass^k` reliability reported |
| Writer isolation (M3) | Separate workspace, exact base, dirty-tree refusal, no writes to parent checkout |
| Checkpoints (M3) | Applied changes/new files participate in rewind; restoration cannot race with live writers |
| Integration (M3) | Integrated tree is tested; branch/worktree claims do not replace parent verification |

Quality metrics are task success rate, actionable-review precision, wall time, cost per successful task, parent-context growth, and unnecessary delegation rate. Safety and ownership tests are hard release gates; quality tradeoffs must be measured rather than assumed.

## 14. Verification commands and manual checks

### Automated checks

Run after each milestone, with failures investigated rather than hidden by output filters:

```bash
npm run typecheck
npm test
npm run lint
node --experimental-strip-types scripts/probe-extensions.ts
git diff --check
git status --short
```

Focused commands in each task refer to tests created by that task. Do not treat a command that matched no tests as a pass. Existing unrelated failures must be reported with the baseline comparison rather than silently fixed.

### Manual M1 check

In an authorized scratch repository:

1. Ask explorer a bounded question with known file locations.
2. Confirm fresh-context behavior, actual model, `Snapshot`/`Scope`/`Evidence` fields, structure-preserving bounded result, and separate transcript.
3. Ask explorer or reviewer with a missing target path or empty diff and confirm it stops early into `Blockers` rather than guessing across the repository.
4. Ask reviewer to inspect a supplied diff with a known defect, plus a clean diff to check false-positive restraint.
5. Confirm reviewer does not claim to run tests (`Verification: not_run`) and cannot modify files.
6. Cancel a deliberately slow run and verify it stops without orphaned search processes.
7. Repeat a denied-path request and verify no denied content appears in report or UI.
8. Verify the behavior in a non-interactive foreground invocation.

### Manual M2 check

1. Start a background explorer, modify a tracked file in the parent while it runs, and confirm the delivered report flags workspace drift in `Snapshot`.
2. Inspect an active background run through `/tasks` and authorized remote control.
3. Stop it locally, then in a separate run stop it remotely; confirm identical outcomes.
4. Start another child, hold task notifications, switch/clear the parent, then release the hold.
5. Confirm no old report wakes the replacement conversation.
6. Reload while a child runs and verify the old source cannot overwrite the new source.
7. Restart after an intentionally interrupted scratch run and confirm no work auto-resumes.
8. Compare displayed child usage with the persisted ledger and foreground attribution.

Paid model calls, provider-specific live tests, sandbox platform tests, and phone interaction must be explicitly authorized and reported as run or skipped. Never change the user's global configuration just to make a manual test pass without permission.

## 15. Non-goals and future decisions

Not part of M1/M2:

- Writing, arbitrary shell commands, or monitoring from children.
- Recursive delegation, agent teams, peer messaging, or shared autonomous task claiming.
- Forked parent context, automatic resume, or durable distributed execution.
- Automatic model selection, model voting, or an LLM supervisor for every worker.
- Persistent self-editing memory or self-modifying agent definitions.
- New MCP inheritance, arbitrary skills, or user-defined executable hooks.
- Automatic git integration, deployment, or scheduled background autonomy.
- A universal configuration framework or complete emulation of Claude Code.

Add a deferred capability only after a concrete task and an evaluation show that it improves outcomes enough to justify its lifecycle, cost, and security complexity.

## 16. References and evidence

Implementation references, to be checked against the supported installed Pi version:

- Pi SDK: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- Pi extensions: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- Pi subagent example: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Agent SDK subagents: https://platform.claude.com/docs/en/agent-sdk/subagents
- Anthropic, Building effective agents: https://www.anthropic.com/engineering/building-effective-agents
- Anthropic, Multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- Anthropic, Context engineering: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, Parallel compiler agents: https://www.anthropic.com/engineering/building-c-compiler
- Cursor, Scaling long-running autonomous coding: https://cursor.com/blog/scaling-agents

Research papers informing delegation, failure taxonomy, security, and evaluation gates:

- Kim et al., *Towards a Science of Scaling Agent Systems* (arXiv:2512.08296v3, 2026 preprint): https://arxiv.org/abs/2512.08296
- Cemri et al., *Why Do Multi-Agent LLM Systems Fail?* (MAST, arXiv:2503.13657v3, 2025 preprint): https://arxiv.org/abs/2503.13657
- Debenedetti et al., *AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents* (NeurIPS 2024 Datasets and Benchmarks; arXiv:2406.13352v3): https://arxiv.org/abs/2406.13352
- Kapoor et al., *AI Agents That Matter* (arXiv:2407.01502v1, 2024 preprint): https://arxiv.org/abs/2407.01502
- Xia et al., *Agentless: Demystifying LLM-based Software Engineering Agents* (arXiv:2407.01489v2, 2024 preprint): https://arxiv.org/abs/2407.01489
- Yang et al., *SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering* (NeurIPS 2024; arXiv:2405.15793v3): https://arxiv.org/abs/2405.15793
- Yao et al., *τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains* (arXiv:2406.12045v1, 2024 preprint): https://arxiv.org/abs/2406.12045

Claude Code's documented defaults change over time. They explain patterns and tradeoffs, not immutable requirements or verified internal source architecture. Research-system cost/performance figures are not predictions for bluclawd coding tasks.

Pre-implementation review evidence:

- `npm run typecheck` completed successfully.
- Selected task, permission, sandbox, checkpoint, routing, and notification tests passed: 181 tests across 11 files, in two invocations.
- These tests cover existing foundations, not the planned subagent runtime.
- No new implementation test or live-model quality evaluation has been run as part of writing this plan.
