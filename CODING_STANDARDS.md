# Coding standards

Read during review. Biome (`npm run lint`) owns formatting and lint, and `npm run typecheck` owns types; these are the judgement calls they cannot make.

## Removals

**Nothing names what a change removes.** When a diff deletes a module, export, status or tool, no reference to it survives: test titles and fixtures, comments, CI steps, docs and ADRs, vendored patches and build scripts. `npm run deadcode` catches files no production entry reaches; references in prose are left to review.

## Types

**Narrow before asserting.** Under `strictNullChecks`, a value that can be absent is narrowed with a guard or typed as optional and handled; a non-null assertion (`!`) sits only where the invariant that rules absence out shows within a few lines, such as an index the loop bounds. When the invariant lives elsewhere (another function, the order of calls, a test setup file), reshape the type so the value cannot be absent, or narrow with a guard. A cast that only silences a null check is a violation (#44).

## Tests

**Tests wait for the event they depend on.** A test that needs a process running, a file written or a message delivered polls for that condition with `waitFor` from `test/helpers/wait-for.ts`, or with a loop bounded by the same `readinessMs` when it must report more, such as a probe's output. It never waits on a fixed sleep or a bound sized for an idle machine, because under parallel load the fixed window loses the race (#45). The poll's deadline is a failure bound, not a timing estimate. Size it for a loaded machine. A fixture descendant's first beat took 22s under `scripts/stress-test.sh` (#76). Every window that must not fire first derives from the deadline or outlasts it: a fixture's watchdog or keep-alive, an exec timeout, the test's own timeout. A fixed delay that only spaces out output, or proves nothing happens within it, is fine.

**Sandbox tests assert the outcome, on every platform they run on.** A test of what a sandboxed command cannot do checks the exit code, the file left unchanged or absent, and the secret missing from the output, never the error text: macOS says `Operation not permitted` where Linux says `Read-only file system`, and lists a denied directory as empty instead of refusing it. A suite gated on `darwin` that exercises the sandbox or run shells runs on Linux too (`scripts/linux-check.sh`), skipping only the tests whose subject exists on one platform, such as `sandbox-exec` or the Keychain.

## Subagents (`ext/subagents/`)

**Shared run state changes after the last await.** State shared across runs or tool calls changes only in the synchronous stretch after a function's last `await`, so no other call interleaves between the check and the change. That state includes the scheduler's run records, message sequence numbers and run-name counters. When a diff adds an `await` to a path that was synchronous, re-check every shared-state change that now sits before it. State a callback reads while an `await` is pending stays valid until that await resolves: shutdown releases the parent context only after `waitForSettled`, since runs still settle and notify meanwhile.

**Tests wait for delivered output.** A test asserting on a notice or message delivered to the orchestrator polls for it with `waitFor` on the condition. `session.waitForIdle()` can return before a background delivery lands.
