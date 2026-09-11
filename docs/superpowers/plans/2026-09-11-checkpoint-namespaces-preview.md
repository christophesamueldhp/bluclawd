# Checkpoint Namespaces + Restore Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop concurrent sessions from pruning each other's checkpoint refs, and show a `git diff --stat` preview in the single confirmation before any restore.

**Architecture:** Refs move under a per-session path; `pruneCheckpointRefs` gains the three-rule sweep (own namespace by branch, legacy strays, foreign refs past a 30-day TTL). `restoreWithSafetyNet` owns the one confirmation and builds the preview from the safety-net tree it already captures.

**Tech Stack:** TypeScript, vitest 4, git CLI, existing harness in `test/checkpoints.test.ts`.

Spec: `docs/superpowers/specs/2026-09-11-checkpoint-namespaces-preview-design.md`.

---

### Task 1: Per-session ref namespaces

**Files:**
- Modify: `ext/checkpoints/index.ts` — `refNameForSha`, `captureCheckpoint` (new `sessionId` argument), `pruneCheckpointRefs` (new signature), `pruneOldCheckpointRefs`, `/rewind --prune`, callers.
- Modify: `test/checkpoints.test.ts` — `capture()` helper passes a session id; `makeCtx` stub gains `getSessionId`; new namespace/prune tests.

- [ ] **Step 1: Write the failing tests** (replace the existing `pruneCheckpointRefs` describe; add the ref-path assertion to the "records the sha" test)

```ts
const SESSION = "session-a";
// capture(dir, exec) → captureCheckpoint(dir, exec, SESSION); makeCtx's sessionManager gains getSessionId: () => SESSION

it("records the sha under refs/bluclawd/checkpoints/<sessionId>/ with the commit as parent", ...)
	expect((await git("rev-parse", `refs/bluclawd/checkpoints/${SESSION}/${sha}`)).trim()).toBe(sha);

describe("pruneCheckpointRefs", () => {
	/** A checkpoint-shaped commit with a forced committer date, under any ref. */
	async function refAt(git, ref, daysAgo) {
		const tree = (await git("write-tree")).trim();
		const date = String(Math.floor(Date.now() / 1000) - daysAgo * 86400);
		const sha = (await git("-c", `user.name=x`, "-c", `user.email=x@x`, "commit-tree", tree, "-m", "old")).trim(); // GIT_COMMITTER_DATE via env in exec wrapper
		await git("update-ref", ref, sha);
		return sha;
	}
	it("keeps own-branch refs, drops own strays, drops legacy strays, and drops foreign refs only past the TTL", ...)
});
```

The committer date needs an env override; extend `makeExec` to accept extra env (`makeExec(extraEnv?)`) and build a second exec for the old-commit fixture with `GIT_COMMITTER_DATE`.

- [ ] **Step 2: Run, expect failures** (`capture` passes an extra arg → ref path assertion fails; prune signature).

- [ ] **Step 3: Implement**

```ts
const FOREIGN_CHECKPOINT_TTL_DAYS = 30;
function refNameForSha(sessionId: string, sha: string) { return `${CHECKPOINT_REF_PREFIX}${sessionId}/${sha}`; }
export async function captureCheckpoint(cwd, exec, sessionId): Promise<string | undefined>  // update-ref uses refNameForSha(sessionId, sha)
export async function pruneCheckpointRefs(cwd, exec, sessionId, keepShas): Promise<number>
  // for-each-ref --format='%(refname) %(committerdate:unix)'
  // own namespace: delete unless keepShas.has(sha)
  // legacy (no '/' after prefix): delete unless keepShas.has(sha)
  // foreign: delete when now - committerdate > TTL
```

`pruneOldCheckpointRefs(cwd, exec, sessionId, branch)`; `checkpointCurrentTurn` and `restoreWithSafetyNet` pass `ctx.sessionManager.getSessionId()`; `/rewind --prune` too.

- [ ] **Step 4: Run the file; all green. Commit** `checkpoints: per-session ref namespaces; prune only what the session owns`

---

### Task 2: Preview in the single confirmation

**Files:**
- Modify: `ext/checkpoints/index.ts` — `restoreWithSafetyNet(pi, ctx, targetSha, safetySubject, intro)`, `/rewind` handler (drop its confirm), fork handler (drop its select).
- Modify: `test/checkpoints.test.ts` — adjust scripts; add preview tests.

- [ ] **Step 1: Write the failing tests**

```ts
// /rewind files-only: select [0, 0], confirm [true]; additionally:
const confirmMessages: string[] = []  // makeCtx records confirm(title, message)
expect(confirmMessages[0]).toContain("a.txt");
// declined: confirm [false] → a.txt unchanged, no "(before rewind)" entry, no restore notice
// identical tree: checkpoint == current → notices contain "already matches", confirm never called
// fail-closed: confirm [false] / [true] (single confirm now)
// fork: no select; confirm [true] / [false]; confirm message contains "fork point" and "a.txt"
```

- [ ] **Step 2: Run, expect failures.**

- [ ] **Step 3: Implement**

```ts
const PREVIEW_MAX_LINES = 20;
async function diffStat(cwd, exec, fromSha, toSha): Promise<string | undefined>  // git diff --stat --stat-width=80 from to; undefined on error
export async function restoreWithSafetyNet(pi, ctx, targetSha, safetySubject, intro): Promise<boolean> {
	const sessionId = ctx.sessionManager.getSessionId();
	const safetySha = await captureCheckpoint(ctx.cwd, pi.exec, sessionId);
	if (!safetySha) { /* existing fail-closed confirm; if declined return false */ }
	else {
		const stat = await diffStat(ctx.cwd, pi.exec, safetySha, targetSha);
		if (stat !== undefined && stat.trim() === "") { ctx.ui.notify("Working tree already matches this checkpoint.", "info"); return false; }
		const preview = stat === undefined ? "(preview unavailable)" : clip(stat, PREVIEW_MAX_LINES);
		const ok = await ctx.ui.confirm("Rewind", `${intro}\n\n${preview}\n\nYour current changes are checkpointed first, so this can be undone with /rewind. Continue?`);
		if (!ok) return false;
		pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, { sha: safetySha, turnEntryId: leaf, subject: safetySubject });
	}
	// restore + report unchanged
}
```

`/rewind`: remove the `if (scopeChoice.files) confirm(...)` block; call `restoreWithSafetyNet(pi, ctx, target.sha, "(before rewind)", "Restore the working tree to this checkpoint?")`. Fork: remove the select; call with intro `Restore code to the checkpoint at this fork point? (${match.subject})`.

- [ ] **Step 4: Run the file; green. Biome. Commit** `checkpoints: preview the diff in one confirmation before any restore`

---

### Task 3: Header, live check, docs

- [ ] Header: ref layout (`<sessionId>/<sha>`), the three prune rules, the preview; drop the sentence that says the fork safety-net ref gets swept.
- [ ] Live in tmux: `/rewind` shows the stat in the confirm; `for-each-ref` shows the session path; second `/rewind` to an identical tree says "already matches".
- [ ] Commit; record observed output below.
