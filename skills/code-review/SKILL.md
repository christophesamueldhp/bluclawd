---
name: code-review
description: Review the current diff (working tree, branch, or PR) for correctness bugs first, then quality issues. Use when asked to review changes, review a diff, or check work before merge.
---

# Code Review

Review the change set the user points at (default: the working tree diff against the merge base of the current branch).

## 1. Establish the diff

```bash
git status --short
git diff --stat          # unstaged + staged overview
git log --oneline -10    # recent commits on this branch
```

If the branch has commits beyond the default branch, review the full branch diff (`git diff <default-branch>...HEAD`), otherwise the uncommitted diff. Read every changed hunk — do not review from the summary alone. Open the surrounding code of each hunk when the change's correctness depends on it.

## 2. Pass 1 — correctness (highest priority)

For each changed file, hunt for defects a reviewer must not miss:

- Logic errors: inverted conditions, off-by-one, wrong operator, unreachable branches.
- Broken contracts: callers of a changed signature/return shape that were not updated.
- Error handling: swallowed exceptions, missing failure paths, partial writes without cleanup.
- State bugs: stale caches, missing invalidation, races on shared state, resource leaks.
- Edge inputs: empty/null/unicode/huge inputs, boundary values, concurrent invocation.

For every suspected defect, verify it against the actual code before reporting: state the concrete failure scenario (inputs/state → wrong result). Discard anything you cannot ground.

## 3. Pass 2 — quality

Only after correctness: naming clarity, duplication that the codebase already has an abstraction for, dead code introduced by the change, missing tests for new behavior, inconsistency with the file's existing style.

## 4. Report

Order findings most-severe first. For each: `file:line`, one-sentence defect statement, the failure scenario, and a suggested fix. Separate "must fix" (correctness) from "consider" (quality). If nothing survived verification, say so plainly.
