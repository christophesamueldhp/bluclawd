# Checkpoint ref namespaces per session, and a restore preview

Date: 2026-09-11. Follows the hardening spec of the same day. Scope:
`ext/checkpoints/index.ts` and its test file.

## 1. Per-session ref namespaces

### Problem

Every checkpoint ref lives flat under `refs/bluclawd/checkpoints/<sha>`, and
the automatic prune after each capture deletes every ref whose sha is not on
the *current session's* branch. Two sessions sharing one `.git` — FleetView
sessions in the same repo, a subagent in a worktree — therefore sweep each
other's refs on every turn. The commits survive only until `git gc`.

### Design

Refs move to `refs/bluclawd/checkpoints/<sessionId>/<sha>`, with
`sessionId = ctx.sessionManager.getSessionId()` (stable across `/resume`; a
fork gets a new id, so the safety-net entry appended to the outgoing session
before a fork now stays under the outgoing session's namespace).

Pruning, both automatic (after every capture) and manual (`/rewind --prune`):

- **Own namespace:** keep the newest `MAX_CHECKPOINT_REFS` shas referenced by
  checkpoint entries on the current branch; delete the rest. Same rule as
  before, scoped.
- **Legacy flat refs** (`refs/bluclawd/checkpoints/<40 hex>`, written before
  this change): delete when not referenced by the current branch — the
  pre-change behaviour, so an upgraded repo converges without a migration.
- **Other sessions' namespaces:** delete a ref only when its commit is older
  than `FOREIGN_CHECKPOINT_TTL_DAYS = 30` (`for-each-ref
  --format='%(refname) %(committerdate:unix)'`). 30 days matches Claude
  Code's checkpoint retention. A session resumed after that loses its file
  checkpoints; the conversation is untouched.

Restore never needs a ref (it takes the sha), so nothing else changes.

## 2. Preview before restore

### Problem

The confirmation before a restore says only "This will overwrite your
current uncommitted changes". The user picks a checkpoint by timestamp and
prompt text without seeing what the restore changes.

### Design

`restoreWithSafetyNet` becomes the single owner of the confirmation:

```
1. captureCheckpoint (safety net; also the preview base)
2. if it failed: the existing fail-closed "restore anyway?" confirm (no preview)
   else:
     stat = git diff --stat <safety> <target>
     if stat is empty: notify "Working tree already matches this checkpoint", return false
     confirm(title, "<intro>\n\n<stat, at most 20 lines, then '… and N more'>\n\nYour current
       changes are checkpointed first, so this can be undone with /rewind. Continue?")
     if declined: return false — no entry appended, the ref is swept by the next prune
3. append the "(before rewind)" / "(before fork)" entry
4. restore, report (unchanged)
```

Callers pass the intro: `/rewind` — "Restore the working tree to this
checkpoint?"; the fork offer — "Restore code to the checkpoint at this fork
point? (<subject>)". Each path now asks exactly one question, with the
preview in it; `/rewind` drops its separate confirm and the fork handler drops
its yes/no select.

The preview base is the safety-net tree rather than `git diff <target>`
against the working tree, because `git diff` ignores untracked files and the
checkpoint tree includes them; the safety-net capture already produces the
exact tree that the restore replaces.

## Tests (`test/checkpoints.test.ts`)

- capture writes `refs/bluclawd/checkpoints/<sessionId>/<sha>`.
- prune: keeps own-branch refs, deletes own strays, deletes legacy flat strays,
  keeps a foreign namespace ref younger than the TTL, deletes one older
  (commit date forced with `GIT_COMMITTER_DATE` on a hand-made `commit-tree`).
- `/rewind`: the confirm message names the changed file; declining leaves the
  tree and appends no entry; an identical tree short-circuits with the
  "already matches" notice.
- fork offer: one confirm, no select.
- existing tests adjusted to the single-confirm flow.

## Verification

`npx vitest run test/checkpoints.test.ts`, biome on the two files, typecheck
(ignoring the other session's `sandbox-strict` breakage). Live in tmux: the
confirm shows the stat; `git for-each-ref refs/bluclawd/checkpoints/` shows
the session-id path.
