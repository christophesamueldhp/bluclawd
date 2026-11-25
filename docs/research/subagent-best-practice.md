# Subagents against vendor best practice

This compares bluclawd's subagent flow with what coding-agent vendors document and recommend for delegation. bluclawd's behavior is taken from the README's "Subagents" section, `GLOSSARY.md`, ADRs 0003, 0005, 0006, 0008, 0010 and 0013, the tool text in `ext/subagents/index.ts` and the bundled roles in `ext/subagents/agents/`. Where an ADR and the README differ, the README wins. Sources were read on 2026-11-25. Citations use keys such as [S1], listed at the end.

## Short answer

Mostly yes, and often stricter than the vendors. bluclawd's orchestrator is [S10]'s manager pattern and [S5]'s orchestrator-workers. A batch is [S5]'s sectioning, and a chain is its prompt chaining. It matches the common core: a fresh context and a self-contained brief, a condensed Report, one level of delegation, a concurrency cap, a worktree per writer and tool limits the runtime enforces. It goes further on Evidence, Integration, crash recovery and read-only defaults. It diverges in four places. Parallel writers are not kept apart, a run has no budget, the parent's context cannot be forked, and worktrees get no dependencies. Its evaluation has not shown that delegation pays with a real model.

The brief's premise that Claude Code forbids nesting is out of date. A subagent can now spawn subagents up to three layers deep by default [S1].

## Best-practice table

| Practice | Who recommends or does it | bluclawd | Note |
|---|---|---|---|
| Delegate only when it pays; do small work directly | [S3] fresh subagents "can end up *slower*"; [S4] multi-agent uses about 15× chat tokens; [S5] start simple; [S2] teams cost more | matches | Tool text: "Do small work yourself". In the first live run the model delegated nothing in two of three scenarios (`delegation-efficiency.md`). |
| Child gets a fresh context and a self-contained brief: objective, output format, tools, boundaries | [S1], [S2], [S4], [S15] | matches | The tool text follows [S4]'s list almost word for word. |
| Optional fork of the parent's context | [S1] fork mode on by default, sharing the parent's prompt cache; [S9] `fork_context`, default false; [S11] handoffs pass the full history; [S13] "share full agent traces" | missing | Fresh context only, by ADR-0010. |
| Condensed result, full output kept by reference | [S6] "often 1,000-2,000 tokens"; [S4] lightweight references avoid the "game of telephone"; [S8] return summaries | matches | ADR-0010 targets 1,000–2,000 tokens. Reports are cut at 8 KiB, batches at 16 KiB, and the full Report and transcript are referenced. |
| Don't trust the child's claim; check the end state; review with a fresh context | [S3] review by a fresh subagent "isn't swayed by the reasoning"; [S4] end-state evaluation; [S14] clean-context reviewer | matches, goes further | Evidence comes from disk, not from the run's text. The `reviewer` role has no history. The eval grades the final tree. |
| Parallelize reads; be careful with parallel writers | [S8] "agents editing code at once can create conflicts"; [S2] "Avoid file conflicts"; [S14] "writes stay single-threaded" | partly | Each writer has its own worktree. Serial writing is advice only: "one at a time unless their files are disjoint". |
| An isolated checkout per writer | [S1] `isolation: worktree`, opt-in, branched from the default branch; [S16]; [S3] `claude -w`; [S7] a container per agent | matches, stricter | Required for every writer, and made from the checkout as it is, uncommitted changes included. |
| Bring the child's changes back | [S16] `/apply-worktree`, and `/best-of-n` "does not merge"; [S7] agents merge and push themselves | goes further | `subagent_integrate`: a three-way merge, all or nothing, `preview`, `keep`, an optional `check`. |
| Provision ignored files and dependencies in worktrees | [S3] `.worktreeinclude`, `worktree.symlinkDirectories`; [S16] `.cursor/worktrees.json` setup scripts | missing | None documented. Ignored files stay out, and ADR-0010 requires "need and authorization". |
| Limit depth | [S9] `DEFAULT_AGENT_MAX_DEPTH = 1`, so children cannot spawn; [S17] subagents "**cannot** call other subagents"; [S2] no nested teams; [S1] three layers, configurable | matches the conservative side | One level, a hard limit: `subagent` is refused to runs. |
| Cap concurrency | [S1] 20 per session, then the spawn fails; [S9] 6 per session (from source); [S2] start with 3–5; [S4] 3–5 in parallel | matches, goes further | 4 across the whole daemon, scheduled fairly. Extra runs queue rather than fail. Only the user can raise the cap. |
| A turn or time budget per child | [S1] `maxTurns`, returning a partial, resumable result; [S17] `max_turns` 30, `timeout_mins` 10 | differs | No budget. `maxTurns` is rejected, and only an explicit stop ends a run early (ADR-0003). |
| Foreground or background | [S1] background by default; [S4] synchronous runs are a bottleneck | differs, on purpose | Foreground by default, background opt-in. Progress wakes nobody. |
| Cancellation and resume | [S1] `x` stops, `SendMessage` resumes with history; [S9] close and resume tools; [S4] resume from the point of failure; [S2] teammates are not restored on resume | matches, goes further | Stop keeps the session and worktree. Resume is explicit. A run's host outlives its orchestrator, and side effects that are uncertain are never replayed. |
| People can watch and steer children | [S1] panel, Enter to open, messages; [S2] split panes; [S8] the web sidebar is read-only; [S15] "you can't guide them directly" | matches, goes further | Each run is a real pi in a pane. It takes messages at a safe point, and the orchestrator is told. |
| Child approvals reach the user with the child named | [S1] background prompts surface in the main session, naming the subagent; [S2] in the lead's session; [S8] the overlay shows the source thread | differs | A pane run asks in its own pane, and the panel says `needs input`. Network requests are asked in the orchestrator's session. With nobody to ask, the request is blocked, as in [S8]'s non-interactive runs. |
| The runtime narrows tools, not the prompt | [S3] "enforced by Claude Code rather than requested in a prompt"; [S1] `tools`/`disallowedTools`, all tools when omitted; [S8] instructions "don't create a separate read-only sandbox"; [S17] all tools when omitted | goes further | A role that names no tools only reads. Limits hold at every call, nested codemode included. MCP is refused. Credential paths are never readable. |
| A model per child; small models for simple jobs | [S1] call, then definition, then environment, then parent; [S3] "Haiku is a good fit for subagents doing simple jobs"; [S8] a fast model for narrow work | partly | Call, then role, then parent, with no substitution. The bundled roles inherit, and the guidance never suggests a cheaper model. |
| Messages between agents are data, not consent | [S2] a teammate "can't approve a permission prompt or supply consent on your behalf"; [S1] named siblings can message each other | matches | Siblings are reached by name, the roles treat messages as data, and only the user opens `/collaborate`. |

## Where bluclawd goes beyond common practice

- **Evidence kept apart from the Report.** No source read keeps a runtime-observed record of a child's checks and changes next to its claim. The sources do support the idea. [S3] lists "Claude said it was done and it wasn't quite" among the usual failures. [S4] recommends end-state evaluation. [S14] warns that "Agents assume they share state with their children when they don't". Evidence is drawn from the transcript, the stored outcome and Git, which fits all three. This is the strongest part of the design.
- **All-or-nothing Integration with a combined check.** [S16] applies a worktree and [S7] lets agents merge for themselves, noting that "Merge conflicts are frequent". No source read applies a three-way merge all or nothing, refuses on conflict and validates the combined tree. The sources support the motive. [S7] says "the task verifier is nearly perfect, otherwise Claude will solve the wrong problem". The limit is that a clean textual merge says nothing about whether two runs' decisions agree (see below).
- **All-or-nothing batch admission.** Not found in the sources read, and neither supported nor contradicted. [S1] and [S9] check their caps per spawn and fail past them. Admitting a batch whole avoids a half-launched batch.
- **A queue shared across orchestrators, served fairly.** [S1] and [S9] cap per session and return an error. No source discusses a machine-wide queue.
- **Sequential chains in one worktree.** This matches [S5]'s prompt chaining with gates, [S10]'s code-driven chains and evaluator loops, and [S14]'s finding that work goes well when "writes stay single-threaded" while a clean-context reviewer iterates with the coder. A chain is bluclawd's best answer to Cognition's argument.
- **Recovery without replay.** [S4] asks for resume from failure, and [S2] lists missing teammate resumption as a limitation. A run with no Report is reported uncertain, never replayed. This is also where [S4] expects asynchronous systems to break: "result coordination, state consistency, and error propagation".
- **Read-only by default, enforced by the runtime.** [S1] and [S17] give every tool when none are named, and [S8] says instructions do not make an agent read-only. [S3] recommends bluclawd's safer default.

## Where bluclawd lags or diverges, ranked by impact

1. **Parallel writers are not kept apart.** Two `tasks` members can both edit, each in its own worktree. No overlap check was found in `batches.ts` or `admission.ts`; the tool text only advises "one at a time unless their files are disjoint". Integration catches textual conflicts only. [S13]'s Flappy Bird example is two compatible-looking diffs built on conflicting assumptions, which a three-way merge accepts. Integration is already one run or chain per call, and the tool text already sends dependent steps to `chain`. Two additions would help:
   - Let a batch member declare the paths it owns, and refuse or flag batches whose writers overlap.
   - Default `check` to a project command on every Integration, so it is not easy to omit.
2. **No turn, time or token budget per run.** Background runs and an uncapped total mean a run can spend without limit until someone stops it. [S1] returns a partial, resumable result at `maxTurns`, and [S17] defaults to 30 turns and 10 minutes. Consider an optional per-call budget that ends the generation with a partial Report and leaves it resumable. This reopens ADR-0003's rejection of quotas, so it needs the user's decision.
3. **Overhead before any benefit.** The tools add about 3,600 estimated tokens to every parent request, even when nothing is delegated (`delegation-efficiency.md`). On the scripted model, delegating always cost more. [S3] warns that delegating the same task "doesn't make the answer any better", and [S4] reports about 15× the tokens of chat. Run the live comparison across models and scenarios. Trim the tool text until the evaluation shows a gain.
4. **No fork of the parent's context.** Every run starts fresh. [S1], [S9] and [S11] offer the parent's history as an option, and [S1] notes that a fork reuses the parent's prompt cache, so it costs less than a fresh subagent for tasks that need the same context. [S13] argues for sharing full traces. Consider an opt-in fork for continuation work, never for `reviewer`, since [S14] finds review works best with no shared context. This revises ADR-0010's "without automatically copying the parent conversation".
5. **Worktree provisioning.** Ignored files are left out, and no documented mechanism adds dependencies or local configuration. A writer's checks can then fail for reasons that have nothing to do with its change. Add an allowlist like [S3]'s `.worktreeinclude`, or a user-authorized setup command like [S16]'s, held to the same trust as roles.
6. **Approvals stay in the run's pane.** [S1], [S2] and [S8] bring a child's prompt to the session the user is looking at, naming the child. bluclawd marks the row `needs input` and waits. ADR-0006 and ADR-0013 chose this on purpose. A notice in the orchestrator's session naming the run, the action and the target would close most of the gap without moving the dialog.
7. **Model choice.** The bundled `explorer` inherits the parent's model. [S3] and [S8] suggest a cheaper model for narrow, read-only work. Say so in the tool text, and keep refusing to substitute a model.

## Risks the sources warn about

- **Context fragmentation.** [S13] says "Actions carry implicit decisions, and conflicting decisions carry bad results". [S14] says that for "parallel-writer swarms" the original view still holds. Worktrees prevent overwrites, not disagreement. Watch batches whose members edit.
- **Thin briefs.** A fresh context makes the brief everything. [S4]'s early lead agent wrote one-line tasks, and its subagents would "duplicate work, leave gaps". [S14] says children are wrongly assumed to share state. The evaluation does not measure brief quality.
- **Stale reads.** Read-only runs share the live checkout while the orchestrator and other runs edit it. ADR-0010 allows a snapshot for a reader that needs a stable view, but the README documents none. The `explorer` prompt only warns that others may be editing.
- **Over-spawning and convergence.** [S4] saw "50 subagents for simple queries". [S7] saw 16 agents "stuck solving the same task". bluclawd has no total cap, by design, and relies on its guidance.
- **Reviewers that always find something.** [S3] says "A reviewer that's asked to find problems will always find *something*". The `reviewer` role's restraint rule and "Review is for large or risky changes" address this. Keep them.
- **Children rarely report upward unprompted.** [S14] says a sub-agent writing back to its manager "doesn't happen by default". bluclawd relies on `subagent_message` for blockers in the middle of a run, and nothing yet measures whether models use it.
- **A weak verifier.** [S7] depended on a nearly perfect test oracle. Integration's `check` is optional, and a writer's Checks are only as good as the commands it chose to run.

## Unconfirmed

- Codex's documentation gives no default for `agents.max_concurrent_threads_per_session` [S8]. The value 6 and the depth of 1 come from source at tag `rust-v0.172.0` [S9]. A root session is depth 0, and a spawn whose depth would exceed the limit is refused.
- Whether Codex cloud runs best-of-N attempts or uses containers is unconfirmed: [S12] says only that each task has its own workspace.
- How Cursor handles conflicts when it applies a worktree is unconfirmed: [S16] does not say.
- Amp publishes no cost figures for subagents [S15].
- ADR-0005's description of Codex "v1" and "v2" steering is the repository's own claim, not checked against a primary source.

## Sources

- [S1] Claude Code, Subagents: https://code.claude.com/docs/en/sub-agents
- [S2] Claude Code, Agent teams: https://code.claude.com/docs/en/agent-teams
- [S3] Claude Code, Best practices: https://code.claude.com/docs/en/best-practices
- [S4] Anthropic, "How we built our multi-agent research system", 2025-06-13: https://www.anthropic.com/engineering/multi-agent-research-system
- [S5] Anthropic, "Building effective agents", 2024-12-19: https://www.anthropic.com/engineering/building-effective-agents
- [S6] Anthropic, "Effective context engineering for AI agents", 2025-09-29: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- [S7] Anthropic, "Building a C compiler with a team of parallel Claudes", 2026-02-05: https://www.anthropic.com/engineering/building-c-compiler
- [S8] OpenAI, Codex subagents (developers.openai.com/codex/subagents redirects here): https://learn.chatgpt.com/docs/agent-configuration/subagents
- [S9] openai/codex at `rust-v0.172.0`: `codex-rs/core/src/config/mod.rs` (`DEFAULT_AGENT_MAX_THREADS`, `DEFAULT_AGENT_MAX_DEPTH`), `codex-rs/core/src/agent/registry.rs`, `codex-rs/core/src/tools/handlers/multi_agents/spawn.rs` (`fork_context`)
- [S10] OpenAI Agents SDK, Orchestrating multiple agents: https://openai.github.io/openai-agents-python/multi_agent/
- [S11] OpenAI Agents SDK, Handoffs: https://openai.github.io/openai-agents-python/handoffs/
- [S12] OpenAI, Codex cloud: https://learn.chatgpt.com/docs/cloud
- [S13] Cognition, Walden Yan, "Don't Build Multi-Agents", 2025-06-12: https://cognition.com/blog/dont-build-multi-agents
- [S14] Cognition, Walden Yan, "Multi-Agents: What's Actually Working", 2026-04-22: https://cognition.com/blog/multi-agents-working
- [S15] Amp, Models and subagents: https://ampcode.com/docs/models-and-subagents
- [S16] Cursor, Worktrees: https://cursor.com/docs/configuration/worktrees
- [S17] Gemini CLI, Subagents: https://geminicli.com/docs/core/subagents/
