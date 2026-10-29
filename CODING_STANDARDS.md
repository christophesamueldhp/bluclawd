# Coding standards

Read during review. Biome (`npm run lint`) owns formatting and lint, and `npm run typecheck` owns types; these are the judgement calls they cannot make.

## Removals

**Nothing names what a change removes.** When a diff deletes a module, export, status or tool, no reference to it survives: test titles and fixtures, comments, CI steps, docs and ADRs, vendored patches and build scripts. `npm run deadcode` catches files no production entry reaches; references in prose are left to review.

## Types

**Narrow before asserting.** Under `strictNullChecks`, a value that can be absent is narrowed with a guard or typed as optional and handled; a non-null assertion (`!`) sits only where a nearby invariant rules absence out, with a short comment when that invariant isn't obvious. A cast that only silences a null check is a violation (#44).

## Tests

**Tests wait for the event they depend on.** A test that needs a process running, a file written or a message delivered polls for that condition with `waitFor` from `test/helpers/wait-for.ts` (or a loop bounded by the same `readinessMs`, when it must report more, such as a probe's output), never a fixed sleep or a bound sized for an idle machine: under parallel load the fixed window loses the race (#45). The poll's deadline is a failure bound, not a timing estimate: size it for a loaded machine (a fixture descendant's first beat took 22s under `scripts/stress-test.sh`, #76), and every window that must not fire first (a fixture's watchdog or keep-alive, an exec timeout, the test's own timeout) derives from it or outlasts it. A fixed delay that only spaces out output, or proves nothing happens within it, is fine.

## Subagents (`ext/subagents/`)

**Shared run state changes after the last await.** State shared across runs or tool calls (the scheduler's run records, message sequence numbers, run-name counters) changes only in the synchronous stretch after a function's last `await`, so no other call interleaves between the check and the change. When a diff adds an `await` to a path that was synchronous, re-check every shared-state change that now sits before it. State a callback reads while an `await` is pending stays valid until that await resolves: shutdown releases the parent context only after `waitForSettled`, since runs still settle and notify meanwhile.

**Tests wait for delivered output.** A test asserting on a notice or message delivered to the orchestrator polls for it (`waitFor` on the condition). `session.waitForIdle()` can return before a background delivery lands.

## Remote web app (`daemon/remote/web/`)

**What a chat hands to the chat that follows it changes in place.** `openChat(id, previous)` shares `pending` with the previous chat, so assigning a new list (`chat.pending = …`) splits them, and a send that fails after the move no longer reaches the chat on screen. Tests assert the sharing with `toBe` after the list changed, not only before.
