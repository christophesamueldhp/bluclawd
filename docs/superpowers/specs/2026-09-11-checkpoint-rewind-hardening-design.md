# Checkpoint / rewind hardening

Date: 2026-09-11. Scope: `ext/checkpoints/index.ts` only. Direction chosen by the
user: harden and test the existing feature; no new UX.

## Why

The file header cites `test/core-ext-checkpoints.test.ts` as proof of its
non-intrusiveness claim. That file does not exist in this repo; the only
coverage is `test/registration.test.ts` counting one command and three events.
Reproducing the capture/restore sequence with real git surfaced three defects,
and a review of the fork path found a fourth.

## Defects

1. **Restore deletes tracked files that match `.gitignore`.** Capture stages
   the working tree into an *empty* temporary index with `git add -A`. A file
   that is tracked but ignored (the committed-then-ignored `.env` pattern) is
   invisible to that index, so it is absent from the checkpoint tree. On
   restore, `git read-tree --reset -u` sees it in the real index but not in
   the tree and removes it from disk. Reproduced: `D cfg.txt`, file gone.
2. **After restore, every difference against HEAD shows as staged.** ` M` and
   `??` become `M ` and `A `. The header documents this only for previously
   untracked files; it applies to all modifications.
3. **The fork-point offer restores the wrong checkpoint.** One prompt runs
   several turns, each captured with the same `turnEntryId`. `listCheckpoints`
   is newest-first and `session_before_fork` uses `.find`, so it restores the
   state before the *last* turn. `/fork` at a user message replays the prompt
   from scratch, which needs the state before the *first* turn.
4. **The fork-point restore has no safety net.** `/rewind` captures the
   about-to-be-overwritten tree first and refuses to proceed (fail-closed) if
   that capture fails. `session_before_fork` calls `restoreCheckpoint`
   directly after a yes/no prompt.
5. **Checkpoints are attributed to the previous prompt** (found during the
   live check of 1–4). pi's agent loop emits `turn_start` before the prompt's
   `message_start`/`message_end`, and the user message is persisted on
   `message_end`, so the branch read at `turn_start` still ends at the
   previous prompt. Every prompt's first checkpoint carried the previous
   prompt's text as its label ("(session start)" for the first) and a
   `turnEntryId` that never equals the user message id pi passes to
   `session_before_fork` — so the fork-point offer never fired. Present in
   both pi 0.84.4 and 0.85.1. Fix: resolve `turnEntryId`/`subject` from the
   branch after the capture's git calls complete (the message is persisted
   long before those return), instead of synchronously at `turn_start`.

## Design

### Capture

Seed the temporary index from HEAD before staging when HEAD exists:

```
env GIT_INDEX_FILE=<tmp> git read-tree HEAD    # skipped on an unborn HEAD
env GIT_INDEX_FILE=<tmp> git add -A
env GIT_INDEX_FILE=<tmp> git write-tree
```

With tracked entries present, `add -A` records modifications and deletions of
tracked files (ignored or not) and adds untracked files, the same scope as
`git stash -u`. `rev-parse HEAD` already runs for the `-p` parent argument; the
seed reuses that result. The real index and working tree stay untouched.

Checkpoints captured before this change still lack tracked-ignored files;
restoring one of them still removes those files. This cannot be repaired
retroactively and is noted in the header.

### Restore

One helper performs the whole destructive sequence for both callers:

```
restoreWithSafetyNet(ctx, target sha, subject) →
  1. captureCheckpoint (safety net), append a "(before rewind)" entry
  2. if the safety capture failed: confirm the unrecoverable path, else abort
  3. git read-tree --reset -u <sha>
  4. git reset -q            # HEAD exists: index back to HEAD
     git read-tree --empty   # unborn HEAD
  5. report success, or the partial-restore message with the safety sha
```

Step 4 makes the tree look like ordinary uncommitted work again: modified
files unstaged, new files untracked. Staging is not captured (the checkpoint
is a flattened tree), so anything the user had staged is unstaged after a
restore, the same loss as `git stash pop` without `--index`. This replaces the
header's "untracked become tracked" note.

`/rewind` keeps its scope picker and its own "overwrite uncommitted changes"
confirmation, then calls the helper. `session_before_fork` keeps its yes/no
offer, then calls the helper. The safety-net entry appended from the fork
path lands on the outgoing session's branch, so the forked session's first
automatic prune sweeps its ref; the commit object survives until `git gc`
(default two weeks). Recorded as a limitation, not fixed here.

### Fork-point selection

A pure exported helper `checkpointForTurn(entries, turnEntryId)` returns the
oldest checkpoint whose `turnEntryId` matches, or undefined. The fork handler
uses it. `/rewind` is unchanged: the user picks an explicit checkpoint there.

### Header

Rewrite the stale sentences: the test-file reference, the `git stash` scope
comparison (now `stash -u`), and the two "documented, not fixed" notes on
staging. Keep the fork/navigateTree and fire-and-forget rationale as is.

## Tests — `test/checkpoints.test.ts`

Real git in `mkdtemp` repositories. Exec shim: `child_process.execFile` (or
`spawn`) resolving `{ code, stdout, stderr }`, never rejecting, honouring
`cwd` and `timeout` — the shape of pi's `execCommand`, which is not exported.
Fixture env: `HOME=<tmp>`, `GIT_CONFIG_GLOBAL=/dev/null`,
`GIT_CONFIG_NOSYSTEM=1`; repo-local `user.name`/`user.email`.

Unit (no git):
- `listCheckpoints`: filters non-checkpoint entries, drops entries without a
  sha, returns newest-first, fills defaults.
- `checkpointForTurn`: oldest match wins; undefined when absent.

Integration, exported functions:
- non-intrusive capture: `git status --porcelain` and `.git/index` bytes are
  identical before and after `captureCheckpoint`; no temp index left in
  `os.tmpdir()`.
- capture includes tracked-ignored modifications and untracked files; restore
  keeps the tracked-ignored file with its checkpointed content (defect 1).
- restore leaves modified files unstaged and new files untracked (defect 2);
  a file created after the checkpoint survives.
- unborn HEAD: capture and restore both work.
- `captureCheckpoint` returns undefined outside a git repo.
- `pruneCheckpointRefs` removes only refs outside the keep set.

Integration, handlers (factory with a stub `ExtensionAPI` recording `on` and
`registerCommand`, stub `ctx.ui` with scripted `select`/`confirm` answers):
- `/rewind` files-only: safety-net entry appended, tree restored.
- `/rewind` fail-closed: exec wrapper fails `write-tree` once; user declines →
  tree untouched and an error notice; user accepts → restore proceeds.
- `session_before_fork` with two checkpoints on one turn restores the older
  tree and appends a safety-net entry (defects 3 and 4).

The `turn_start` path is fire-and-forget behind the module-level
`isCapturing` guard and is not exercised with real git; the awaited paths
cover the same functions.

## Verification

`npm test`, `npm run typecheck`, `npm run lint`. Live in tmux: with ` M`
and `??` entries in `git status --short`, run `/rewind` files-only to an
earlier checkpoint; the status shape afterwards must still be ` M` / `??`,
and a tracked-ignored file must survive.

## Out of scope

Automatic pruning deletes every checkpoint ref not on the current session's
branch, so concurrent sessions sharing one `.git` (FleetView, subagent
worktrees) sweep each other's refs on every turn. Fixing that needs per-session
ref namespaces and a separate decision.
