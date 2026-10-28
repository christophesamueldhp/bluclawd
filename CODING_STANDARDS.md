# Coding standards

Read during review. Biome (`npm run lint`) owns formatting and lint, and `npm run typecheck` owns types; these are the judgement calls they cannot make.

## Subagents (`ext/subagents/`)

**Shared run state changes after the last await.** State shared across runs or tool calls (the scheduler's run records, `emittedLaunchResults`, message sequence numbers, run-name counters) changes only in the synchronous stretch after a function's last `await`, so no other call interleaves between the check and the change. When a diff adds an `await` to a path that was synchronous, re-check every shared-state change that now sits before it.

**Tests wait for delivered output.** A test asserting on a notice or message delivered to the orchestrator polls for it (`waitFor` on the condition). `session.waitForIdle()` can return before a background delivery lands.
