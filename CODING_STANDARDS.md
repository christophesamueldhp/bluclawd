# Coding standards

Read during review. Biome (`npm run lint`) owns formatting and lint, and `npm run typecheck` owns types; these are the judgement calls they cannot make.

## Removals

**Nothing names what a change removes.** When a diff deletes a module, export, status or tool, no reference to it survives: test titles and fixtures, comments, CI steps, docs and ADRs, vendored patches and build scripts. `npm run deadcode` catches files no production entry reaches; references in prose are left to review.

## Subagents (`ext/subagents/`)

**Shared run state changes after the last await.** State shared across runs or tool calls (the scheduler's run records, `emittedLaunchResults`, message sequence numbers, run-name counters) changes only in the synchronous stretch after a function's last `await`, so no other call interleaves between the check and the change. When a diff adds an `await` to a path that was synchronous, re-check every shared-state change that now sits before it.

**Tests wait for delivered output.** A test asserting on a notice or message delivered to the orchestrator polls for it (`waitFor` on the condition). `session.waitForIdle()` can return before a background delivery lands.
