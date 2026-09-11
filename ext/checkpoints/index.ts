/**
 * Checkpoints core extension (Claude Code checkpoint/rewind parity — PLAN.md F1.6)
 *
 * Captures a restorable git snapshot of the working tree at the start of every
 * turn, so `/rewind` can time-travel the code back to an earlier point. The
 * conversation is a separate axis: `/rewind` asks whether to restore the files,
 * the conversation, or both, and rewinds the conversation with `ctx.navigateTree`
 * to the user message that started the turn.
 *
 * `navigateTree`, NOT `ctx.fork`: fork is the obvious fit and it is what pi's own
 * `/fork` uses, but calling it from this command handler terminates the session
 * (exit code 1, no stderr) — reproduced with the file restore removed, so the fork
 * alone is the trigger. navigateTree reaches the same point in the session tree,
 * is equally non-destructive (the abandoned path stays in the file), and does not
 * take the session down. Do not "simplify" this back to fork without re-testing
 * that live. Donor `examples/extensions/git-checkpoint.ts`
 * contributes only the hook-point shape (turn_start capture, session_before_fork
 * offer) — its `git stash create` + in-memory Map are a toy and are not reused
 * here: stash create drops untracked files, and an in-memory Map doesn't survive
 * process restart (`/resume`).
 *
 * ── Non-intrusiveness (the crux of this feature) ──────────────────────────────
 * A checkpoint capture must NEVER change what `git status`/`git diff` report, and
 * must never touch the real `.git/index` or working tree. Capture therefore uses
 * a SEPARATE TEMPORARY INDEX FILE (the `GIT_INDEX_FILE` env var, set the same way
 * statusline sets `BLUCLAWD_STATUSLINE_JSON` — via `env VAR=... git ...`, since
 * `ExecOptions` has no env passthrough and a `VAR=val cmd` shell prefix doesn't
 * expand across separate spawned processes anyway):
 *
 *   1. `env GIT_INDEX_FILE=<tmp> git read-tree HEAD` (skipped on an unborn
 *      HEAD) then `env GIT_INDEX_FILE=<tmp> git add -A` — seed the temp index
 *      with HEAD's entries, then stage the ENTIRE working tree on top:
 *      tracked files (modified, deleted, or matching .gitignore — the
 *      committed-then-ignored `.env` pattern) plus untracked files, the same
 *      scope as `git stash -u`. Without the seed, tracked-but-ignored files
 *      are missing from the tree and a restore DELETES them. The real index
 *      is never opened.
 *   2. `env GIT_INDEX_FILE=<tmp> git write-tree` — turn that temp index into a
 *      tree object.
 *   3. `git commit-tree <tree> [-p HEAD] -m ...` — wrap the tree in a commit
 *      object (no index involved at all). Author/committer are fixed synthetic
 *      values so this never depends on the user's `git config`.
 *   4. `git update-ref refs/bluclawd/checkpoints/<sha> <sha>` — keep the commit
 *      reachable from GC. `refs/bluclawd/...` (rather than `git tag`) is
 *      invisible to `git tag`/`git branch` and the user's normal workflow;
 *      `git log --all` will still enumerate it, same tradeoff as e.g. GitHub's
 *      `refs/pull/*` convention.
 *
 * The temp index file itself lives under `os.tmpdir()` (never inside the repo)
 * and is removed in a `finally` block regardless of outcome. Every git exec
 * carries a hard `timeout` (GIT_TIMEOUT_MS) so a hung git can never hang the
 * agent loop. See `test/checkpoints.test.ts` for the byte-identical
 * before/after proof.
 *
 * ── Latency: fire-and-forget capture ──────────────────────────────────────────
 * `turn_start` handlers are awaited inline in the agent loop (confirmed for
 * turn_end by statusline — same mechanism applies to turn_start), so a capture
 * that blocks would add real per-turn latency. The handler therefore kicks off
 * `captureCheckpoint()` detached (`void ... .then`) and appends the `checkpoint`
 * entry only once the sha resolves. `turnEntryId`/`subject` are resolved at
 * THAT point, not at turn_start: pi's agent loop emits turn_start BEFORE the
 * prompt's message_start/message_end, and the user message is persisted on
 * message_end, so the branch as of turn_start still ends at the PREVIOUS
 * prompt. Reading it there labelled every prompt's first checkpoint with the
 * prompt before it ("(session start)" for the first) and gave the fork-point
 * offer a turnEntryId that never matched the forked-at user message. That
 * persistence is synchronous continuation work in the agent loop while the
 * capture needs several child-process round trips, so in practice the
 * post-capture branch always has it (a slow message_start handler in another
 * extension is the only way to narrow that gap).
 * A module-scoped `isCapturing` guard (same idea as statusline's `isRefreshing`)
 * drops an overlapping turn_start capture while one is still in flight, bounding
 * concurrent git subprocesses to one; the next turn tries again. This guard does
 * NOT gate the `/rewind` command's own (foreground, user-awaited) safety-net
 * capture — that one is a one-off, sequential action the user explicitly
 * triggered, and unconditionally running it is more useful than occasionally
 * skipping the undo-safety-net over unlucky timing with a background capture.
 *
 * ── Restore (destructive, fail-closed) ──────────────────────────────────────
 * `git read-tree --reset -u <sha>` resets the real index AND working tree to
 * match the checkpoint's tree in one step (the standard idiom underlying
 * `git reset --hard`) — this is the one operation in this file that is meant to
 * touch the user's working tree, and only ever runs through
 * `restoreWithSafetyNet`, from an explicit, confirmed `/rewind` or a fork-point
 * restore the user opted into — both take the safety net below. It gets its own larger
 * RESTORE_TIMEOUT_MS budget (not the cheap 5s metadata timeout), since a SIGTERM
 * mid-restore on a large repo can leave a partially-applied tree; that failure is
 * reported with a distinct message pointing at the safety-net sha for recovery.
 *
 * `/rewind` is FAIL-CLOSED on its safety net: before restoring it captures the
 * current (about-to-be-overwritten) state so the rewind is undoable. If that
 * safety capture FAILS (timeout/transient git error), the destructive restore
 * does NOT proceed automatically — the user must explicitly re-confirm an
 * "unrecoverable, no safety checkpoint" prompt, otherwise the rewind aborts with
 * the working tree untouched. This closes the data-loss hole where a failed
 * safety net would silently still overwrite the user's uncommitted work.
 *
 * After the tree restore, the index is reset to HEAD (`git reset -q`, or
 * `read-tree --empty` on an unborn HEAD) so the result reads as ordinary
 * uncommitted work: modified files unstaged, new files untracked. A checkpoint
 * is a flattened tree — it does not record what was staged — so anything the
 * user had staged is unstaged after a restore, the same loss as `git stash
 * pop` without `--index`. Checkpoints captured before the HEAD-seeding change
 * above still lack tracked-but-ignored files; restoring one of those still
 * removes such files, and that cannot be repaired retroactively.
 *
 * `read-tree --reset -u` only touches paths that differ between the target
 * tree and the current index, so a file created AFTER the checkpoint
 * (agent-written, never git-added) is in neither and SURVIVES a restore.
 * Removing such strays would need an explicit untracked-diff + delete pass
 * with its own safety questions (it would erase files the USER dropped in
 * too) — documented, not fixed.
 *
 * The fork-point offer (`session_before_fork`) restores the OLDEST checkpoint
 * of the forked-at turn (`checkpointForTurn`): a prompt runs several turns and
 * each is captured, and replaying the prompt needs the tree from before its
 * first turn. Its safety-net entry lands on the OUTGOING session's branch, so
 * the forked session's first automatic prune drops that ref; the commit
 * object stays restorable by sha until `git gc` (default two weeks). Known
 * limitation, shared with every concurrent-session case (see pruning below).
 *
 * ── Persistence & pruning ────────────────────────────────────────────────────
 * Each checkpoint is `pi.appendEntry("checkpoint", { sha, turnEntryId, subject })`
 * — a flat, alias-free object (no nested/mutable state to clone). `listCheckpoints`
 * is a pure function over session entries (root->leaf order in, newest-first out)
 * so it's unit-testable without git. `/rewind --prune` (or `prune`) deletes every
 * `refs/bluclawd/checkpoints/*` ref whose sha isn't referenced by a checkpoint
 * entry on the CURRENT branch — i.e. checkpoints from other/old sessions get
 * swept, avoiding unbounded ref accumulation. `pruneOldCheckpointRefs()` now
 * runs that same sweep automatically after every capture (not just on request),
 * and additionally caps the current branch itself to the newest
 * `MAX_CHECKPOINT_REFS` refs, so growth stays bounded across both long-lived
 * repos (many old sessions) and long-lived sessions (many turns) without the
 * user ever needing `/rewind --prune` — see the note below.
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, InlineExtension, SessionEntry } from "@earendil-works/pi-coding-agent";

const CHECKPOINT_CUSTOM_TYPE = "checkpoint";
const CHECKPOINT_REF_PREFIX = "refs/bluclawd/checkpoints/";
/** Timeout for cheap git metadata/capture calls (rev-parse, add, write-tree, commit-tree, update-ref). */
const GIT_TIMEOUT_MS = 5000;
/**
 * Larger, dedicated budget for the ONE destructive call (`git read-tree --reset -u`).
 * A SIGTERM mid-restore on a large repo can leave a partially-applied tree (neither
 * old nor new state), so restore must not share the cheap 5s metadata budget.
 */
const RESTORE_TIMEOUT_MS = 30000;
const SUBJECT_MAX_CHARS = 100;
/**
 * Cap on checkpoint refs kept on the current branch by the automatic pruning
 * below (`pruneOldCheckpointRefs`). Keeps the newest N captures restorable;
 * older refs are dropped and their commits become normal git-GC candidates.
 * Matches the "recent bounded window" size used elsewhere in this codebase
 * (e.g. `CACHE_MAX_ENTRIES`/`DEFAULT_MAX_FINISHED_JOBS` = 50).
 */
export const MAX_CHECKPOINT_REFS = 50;

// Follow-ups from the F1.6 review — both CLOSED:
// - Windows `env`-portability: WON'T DO. The `env VAR=... git ...` idiom (also
//   used by statusline) is POSIX-only, but Windows is an explicit non-goal for
//   this fork — CC-PARITY-AUDIT.md §4.10 ("Non-goals ... do NOT fix") locks the
//   platform stance, and §3's "PowerShell" row gives the specific reason: "skip
//   until Windows is a target (checkpoints are POSIX-only anyway)". No
//   cross-platform shim is planned.
// - Unbounded ref growth: CLOSED. `checkpointCurrentTurn()` now calls
//   `pruneOldCheckpointRefs()` unconditionally after every successful capture:
//   below MAX_CHECKPOINT_REFS this is exactly the manual `/rewind --prune`
//   sweep (stray refs from OTHER/old sessions removed), just run every turn
//   instead of on request; above it, it also caps the current branch's own refs
//   to the newest MAX_CHECKPOINT_REFS. Fire-and-forget, same as capture itself
//   (doesn't gate `isCapturing`). Manual `/rewind --prune` is unchanged and
//   still available for on-demand use.

/** Data persisted per checkpoint via `pi.appendEntry("checkpoint", ...)`. */
export interface CheckpointData {
	/** Commit sha of the snapshot (see file header for how it's built). */
	sha: string;
	/** Id of the session entry (the user message) that started the turn this checkpoint belongs to. */
	turnEntryId: string;
	/** Short label for display — usually the user message text that started the turn. */
	subject: string;
}

/** A checkpoint entry resolved from session entries, ready for display/restore. */
export interface Checkpoint extends CheckpointData {
	/** Id of the checkpoint's own session entry. */
	entryId: string;
	/** ISO timestamp of the checkpoint entry. */
	timestamp: string;
}

/**
 * Pure helper: given session entries (e.g. `ctx.sessionManager.getBranch()`),
 * return the checkpoints on that branch, newest first. Unit-testable without git.
 */
export function listCheckpoints(entries: SessionEntry[]): Checkpoint[] {
	const checkpoints: Checkpoint[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CHECKPOINT_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<CheckpointData> | undefined;
		if (!data?.sha) continue;
		checkpoints.push({
			entryId: entry.id,
			sha: data.sha,
			turnEntryId: data.turnEntryId ?? "",
			subject: data.subject ?? "(no subject)",
			timestamp: entry.timestamp,
		});
	}
	return checkpoints.reverse();
}

/**
 * The checkpoint to restore when forking at the user message `turnEntryId`:
 * the OLDEST capture of that turn. A prompt runs several turns, each captured
 * with the same turnEntryId; the first capture is the tree before the prompt
 * changed anything, which is what replaying the prompt from scratch needs.
 */
export function checkpointForTurn(entries: SessionEntry[], turnEntryId: string): Checkpoint | undefined {
	if (!turnEntryId) return undefined;
	return listCheckpoints(entries)
		.reverse()
		.find((c) => c.turnEntryId === turnEntryId);
}

/** Extract plain text from a user message's content (string or content-block array). */
function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block): block is { type: string; text: string } => (block as { type?: string })?.type === "text")
			.map((block) => block.text)
			.join(" ");
	}
	return "";
}

function truncateSubject(text: string): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (!singleLine) return "(empty message)";
	if (singleLine.length <= SUBJECT_MAX_CHARS) return singleLine;
	return `${singleLine.slice(0, SUBJECT_MAX_CHARS - 1)}…`;
}

/**
 * Walk a branch (root->leaf order, e.g. from `ctx.sessionManager.getBranch()`)
 * backward to find the user message that started the current turn, for labeling.
 */
function findTurnContext(branch: SessionEntry[]): {
	turnEntryId: string;
	subject: string;
} {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "message" && entry.message.role === "user") {
			return {
				turnEntryId: entry.id,
				subject: truncateSubject(extractUserText(entry.message.content)),
			};
		}
	}
	const leaf = branch[branch.length - 1];
	return { turnEntryId: leaf?.id ?? "", subject: "(session start)" };
}

/**
 * Refs from OTHER sessions' namespaces are kept this long (by commit date)
 * before the prune drops them — a session resumed later than this loses its
 * file checkpoints, nothing else. Matches Claude Code's checkpoint retention.
 */
const FOREIGN_CHECKPOINT_TTL_DAYS = 30;

function refNameForSha(sessionId: string, sha: string): string {
	return `${CHECKPOINT_REF_PREFIX}${sessionId}/${sha}`;
}

export async function isGitRepo(cwd: string, exec: ExtensionAPI["exec"]): Promise<boolean> {
	const result = await exec("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	return result?.code === 0 && result.stdout.trim() === "true";
}

/** Current HEAD commit sha, or undefined on an unborn HEAD (fresh `git init`). */
async function headSha(cwd: string, exec: ExtensionAPI["exec"]): Promise<string | undefined> {
	const result = await exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	const sha = result?.stdout.trim();
	return result?.code === 0 && sha ? sha : undefined;
}

/**
 * Capture a restorable snapshot of the working tree (tracked + untracked files,
 * respecting .gitignore) as a git commit object, without touching the real index
 * or working tree (see file header for the temp-index mechanism). Returns the
 * commit sha, or undefined on any failure or when `cwd` isn't a git repo — never
 * throws (silent no-op).
 */
export async function captureCheckpoint(
	cwd: string,
	exec: ExtensionAPI["exec"],
	sessionId: string,
): Promise<string | undefined> {
	if (!(await isGitRepo(cwd, exec))) return undefined;

	const tmpIndex = join(tmpdir(), `bluclawd-checkpoint-${randomUUID()}.index`);
	try {
		// Seed the temp index with HEAD's entries first, so `add -A` sees tracked
		// files even when they match .gitignore (the committed-then-ignored
		// pattern). An empty index would drop them from the tree and a later
		// restore would delete them. Skipped on an unborn HEAD: nothing to seed.
		const head = await headSha(cwd, exec);
		if (head) {
			const seed = await exec("env", [`GIT_INDEX_FILE=${tmpIndex}`, "git", "read-tree", head], {
				cwd,
				timeout: GIT_TIMEOUT_MS,
			}).catch(() => undefined);
			if (!seed || seed.code !== 0) return undefined;
		}

		const add = await exec("env", [`GIT_INDEX_FILE=${tmpIndex}`, "git", "add", "-A"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		}).catch(() => undefined);
		if (!add || add.code !== 0) return undefined;

		const writeTree = await exec("env", [`GIT_INDEX_FILE=${tmpIndex}`, "git", "write-tree"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		}).catch(() => undefined);
		const tree = writeTree?.stdout.trim();
		if (!writeTree || writeTree.code !== 0 || !tree) return undefined;

		const parentArgs = head ? ["-p", head] : [];

		const commit = await exec(
			"env",
			[
				"GIT_AUTHOR_NAME=bluclawd-checkpoint",
				"GIT_AUTHOR_EMAIL=checkpoint@bluclawd.local",
				"GIT_COMMITTER_NAME=bluclawd-checkpoint",
				"GIT_COMMITTER_EMAIL=checkpoint@bluclawd.local",
				"git",
				"commit-tree",
				tree,
				...parentArgs,
				"-m",
				"bluclawd checkpoint",
			],
			{ cwd, timeout: GIT_TIMEOUT_MS },
		).catch(() => undefined);
		const sha = commit?.stdout.trim();
		if (!commit || commit.code !== 0 || !sha) return undefined;

		const updateRef = await exec("git", ["update-ref", refNameForSha(sessionId, sha), sha], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		}).catch(() => undefined);
		if (!updateRef || updateRef.code !== 0) return undefined;

		return sha;
	} catch {
		return undefined;
	} finally {
		await rm(tmpIndex, { force: true }).catch(() => {});
	}
}

/**
 * Restore the working tree to a previously captured checkpoint. This is the
 * one deliberately destructive operation in this file — only call it from an
 * explicit, user-confirmed action. `read-tree --reset -u` rewrites the index
 * and working tree together; the index is then reset to HEAD so the result
 * reads as ordinary uncommitted work (modified files unstaged, new files
 * untracked) instead of a fully staged tree. Returns false (never throws) if
 * the sha can't be restored (e.g. not a git repo, unknown sha).
 */
export async function restoreCheckpoint(cwd: string, exec: ExtensionAPI["exec"], sha: string): Promise<boolean> {
	const result = await exec("git", ["read-tree", "--reset", "-u", sha], {
		cwd,
		timeout: RESTORE_TIMEOUT_MS,
	}).catch(() => undefined);
	if (result?.code !== 0) return false;

	const head = await headSha(cwd, exec);
	const unstage = await exec("git", head ? ["reset", "-q"] : ["read-tree", "--empty"], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	return unstage?.code === 0;
}

/**
 * Sweep `refs/bluclawd/checkpoints/**` with three rules, so sessions sharing
 * one `.git` (FleetView, subagent worktrees) never delete each other's live
 * checkpoints:
 *   - `<sessionId>/<sha>` (this session): delete unless the sha is in `keepShas`.
 *   - `<sha>` directly under the prefix (legacy flat layout): same rule, so an
 *     upgraded repo converges without a migration.
 *   - `<otherSession>/<sha>`: delete only when the commit is older than
 *     FOREIGN_CHECKPOINT_TTL_DAYS.
 * Returns the number of refs removed. Never throws.
 */
export async function pruneCheckpointRefs(
	cwd: string,
	exec: ExtensionAPI["exec"],
	sessionId: string,
	keepShas: ReadonlySet<string>,
): Promise<number> {
	const list = await exec(
		"git",
		["for-each-ref", "--format=%(refname) %(committerdate:unix)", CHECKPOINT_REF_PREFIX],
		{
			cwd,
			timeout: GIT_TIMEOUT_MS,
		},
	).catch(() => undefined);
	if (!list || list.code !== 0) return 0;

	const cutoff = Math.floor(Date.now() / 1000) - FOREIGN_CHECKPOINT_TTL_DAYS * 86400;
	let removed = 0;
	for (const line of list.stdout.split("\n")) {
		const [ref, dateText] = line.trim().split(" ");
		if (!ref) continue;
		const rest = ref.slice(CHECKPOINT_REF_PREFIX.length);
		const slash = rest.indexOf("/");
		const owner = slash === -1 ? sessionId : rest.slice(0, slash);
		const sha = slash === -1 ? rest : rest.slice(slash + 1);
		const stale = owner === sessionId ? !keepShas.has(sha) : Number.parseInt(dateText ?? "", 10) < cutoff;
		if (!stale) continue;
		const del = await exec("git", ["update-ref", "-d", ref], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		}).catch(() => undefined);
		if (del?.code === 0) removed++;
	}
	return removed;
}

/**
 * Automatic counterpart to the manual `/rewind --prune`: runs after every
 * successful capture (unconditionally, not just once some threshold is
 * crossed), so a repo doesn't depend on the user remembering to prune. Deletes
 * every checkpoint ref that isn't among the newest `MAX_CHECKPOINT_REFS` shas on
 * the CURRENT branch — below that count this is exactly manual `/rewind
 * --prune`'s "sweep every stray ref from OTHER/old sessions" behavior, just run
 * every turn instead of on request; above it, it also caps the current branch's
 * own refs (see the "Unbounded ref growth" note above). Cheap in steady state
 * (one `for-each-ref`, zero deletes once nothing is stray or over the cap).
 * Never throws — `pruneCheckpointRefs` already swallows its own errors.
 */
async function pruneOldCheckpointRefs(
	cwd: string,
	exec: ExtensionAPI["exec"],
	sessionId: string,
	branch: SessionEntry[],
): Promise<void> {
	const shas = listCheckpoints(branch).map((c) => c.sha); // newest-first
	await pruneCheckpointRefs(cwd, exec, sessionId, new Set(shas.slice(0, MAX_CHECKPOINT_REFS)));
}

/** Lines of `git diff --stat` shown in the restore confirmation before it is clipped. */
const PREVIEW_MAX_LINES = 20;

/**
 * `git diff --stat` from one checkpoint commit to another — what restoring
 * `toSha` changes relative to the tree captured as `fromSha`. Undefined on any
 * git error; the empty string when the trees are identical.
 */
async function diffStat(
	cwd: string,
	exec: ExtensionAPI["exec"],
	fromSha: string,
	toSha: string,
): Promise<string | undefined> {
	const result = await exec("git", ["diff", "--stat", "--stat-width=80", fromSha, toSha], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	return result?.code === 0 ? result.stdout : undefined;
}

function clipLines(text: string, max: number): string {
	const lines = text.trimEnd().split("\n");
	if (lines.length <= max) return lines.join("\n");
	return `${lines.slice(0, max).join("\n")}\n… and ${lines.length - max} more`;
}

/**
 * The whole destructive sequence, shared by `/rewind` and the fork-point
 * offer: safety-net capture → ONE confirmation that previews what the restore
 * changes (or the fail-closed prompt if the safety capture failed) → append
 * the safety-net entry → restore → report. Returns true only when the tree was
 * restored. `intro` is the question the confirmation opens with.
 */
export async function restoreWithSafetyNet(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	targetSha: string,
	safetySubject: string,
	intro: string,
): Promise<boolean> {
	// Deliberately bypasses the isCapturing guard (see file header) — this is a
	// foreground, user-awaited, one-off action. The captured tree doubles as the
	// preview base: `git diff <sha>` against the working tree would skip
	// untracked files, and this tree has them.
	const safetySha = await captureCheckpoint(ctx.cwd, pi.exec, ctx.sessionManager.getSessionId());
	if (safetySha) {
		const stat = await diffStat(ctx.cwd, pi.exec, safetySha, targetSha);
		if (stat !== undefined && stat.trim() === "") {
			ctx.ui.notify("Working tree already matches this checkpoint.", "info");
			return false;
		}
		const preview = stat === undefined ? "(preview unavailable)" : clipLines(stat, PREVIEW_MAX_LINES);
		const proceed = await ctx.ui.confirm(
			"Rewind",
			`${intro}\n\n${preview}\n\nYour current changes are checkpointed first, so this can be undone with /rewind. Continue?`,
		);
		// Declined: no entry is appended; the safety-net ref is swept by the next prune.
		if (!proceed) return false;
		pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, {
			sha: safetySha,
			turnEntryId: ctx.sessionManager.getLeafEntry()?.id ?? "",
			subject: safetySubject,
		});
	} else {
		// Fail-closed. Restoring now would overwrite the user's current
		// uncommitted work with NO way to recover it — exactly the data loss the
		// safety net exists to prevent. Do NOT restore unless the user opts in.
		const proceed = await ctx.ui.confirm(
			"Safety checkpoint failed",
			`${intro}\n\nCould not snapshot your current changes before rewinding (no preview either). If you restore now, your current uncommitted changes will be UNRECOVERABLE. Restore anyway, without a safety checkpoint?`,
		);
		if (!proceed) {
			ctx.ui.notify("Rewind aborted: safety checkpoint failed, current changes left untouched.", "error");
			return false;
		}
	}

	const restored = await restoreCheckpoint(ctx.cwd, pi.exec, targetSha);
	if (restored) {
		ctx.ui.notify("Working tree restored to checkpoint.", "info");
		return true;
	}
	// read-tree can be interrupted mid-write (e.g. SIGTERM on RESTORE_TIMEOUT_MS),
	// potentially leaving a partially-applied tree. Point the user at the
	// safety-net sha (when one was taken) so they can get back to where they were.
	const recovery = safetySha
		? ` Your pre-rewind state is checkpointed at ${safetySha.slice(0, 7)} — run /rewind to return to it.`
		: "";
	ctx.ui.notify(
		`Failed to restore checkpoint; the working tree may be in a partially-applied state.${recovery}`,
		"error",
	);
	return false;
}

/** Module-scoped overlap guard for the turn_start background capture (see file header). */
let isCapturing = false;

/**
 * Session-scoped count of turn_start captures that failed while `cwd` WAS a
 * git repo (index.lock, GIT_TIMEOUT_MS, or any other git error — see
 * `captureCheckpoint`'s individual `.catch(() => undefined)` sites). Reset on
 * `session_start` (covers resume). Deliberately does NOT count the "not a git
 * repo" no-op — that is a stable, already-surfaced-by-design condition (see
 * the dedicated test for it), not the surprise this counter exists for: a
 * turn silently missing its safety net while checkpoints are otherwise
 * working (IMPROVEMENT-PLAN.md §4.3).
 */
let failedCaptureCount = 0;

/**
 * Extension factory. Idempotent at registration time: the body below only calls
 * on()/registerCommand() (no git/exec work), so it is safe to run twice per load
 * (bootstrap + final trust-resolving pass). All git work happens in handlers.
 */
export function factory(pi: ExtensionAPI): void {
	function checkpointCurrentTurn(ctx: ExtensionContext): void {
		if (isCapturing) return; // an in-flight capture: the next turn_start will try again
		isCapturing = true;
		const sessionId = ctx.sessionManager.getSessionId();
		void captureCheckpoint(ctx.cwd, pi.exec, sessionId)
			.then(async (sha) => {
				// Resolved AFTER the capture, not at turn_start: pi persists the prompt's
				// user message on message_end, which the agent loop emits after
				// turn_start, so the branch at turn_start still ends at the previous
				// prompt. By the time the git calls have completed the message is in.
				const { turnEntryId, subject } = findTurnContext(ctx.sessionManager.getBranch());
				if (sha) {
					pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, { sha, turnEntryId, subject });
					// Fire-and-forget, like capture itself — doesn't gate isCapturing below.
					void pruneOldCheckpointRefs(ctx.cwd, pi.exec, sessionId, ctx.sessionManager.getBranch());
					return;
				}
				// Capture failed. Distinguish "not a git repo" (stable, expected, not
				// this turn's fault — no counter, no notice) from a genuine git-op
				// failure (index.lock, GIT_TIMEOUT_MS, ...) that silently left this
				// turn with no safety net (IMPROVEMENT-PLAN.md §4.3). The extra check
				// only runs on the already-slow failure path, so the happy path pays
				// nothing for it.
				if (!(await isGitRepo(ctx.cwd, pi.exec))) return;
				failedCaptureCount++;
				if (failedCaptureCount === 1 && ctx.hasUI) {
					ctx.ui.notify(
						`Checkpoint capture failed for "${subject}" — this turn has no safety net for /rewind. ` +
							"Run /rewind to see which turns are covered.",
						"warning",
					);
				}
			})
			.catch(() => {})
			.finally(() => {
				isCapturing = false;
			});
	}

	pi.on("session_start", async () => {
		failedCaptureCount = 0;
	});

	pi.on("turn_start", async (_event, ctx) => {
		checkpointCurrentTurn(ctx);
	});

	// Offer to put the code back where it was when the forked-at prompt began.
	// Always asks first (the one confirmation with the preview lives in
	// restoreWithSafetyNet), never auto-restores.
	pi.on("session_before_fork", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const match = checkpointForTurn(ctx.sessionManager.getBranch(), event.entryId);
		if (!match) return;
		await restoreWithSafetyNet(
			pi,
			ctx,
			match.sha,
			"(before fork)",
			`Restore code to the checkpoint at this fork point? (${match.subject})`,
		);
	});

	pi.registerCommand("rewind", {
		description: "Restore the working tree to a previous checkpoint (`--prune` to clean up old checkpoint refs)",
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();
			if (trimmed === "--prune" || trimmed === "prune") {
				const keepShas = new Set(listCheckpoints(ctx.sessionManager.getBranch()).map((c) => c.sha));
				const removed = await pruneCheckpointRefs(ctx.cwd, pi.exec, ctx.sessionManager.getSessionId(), keepShas);
				ctx.ui.notify(`Pruned ${removed} old checkpoint ref${removed === 1 ? "" : "s"}.`, "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/rewind requires interactive mode", "error");
				return;
			}

			const checkpoints = listCheckpoints(ctx.sessionManager.getBranch());
			// Surface capture failures here too, not just the one-time notice on the
			// turn they happened (IMPROVEMENT-PLAN.md §4.3) — this is where a user
			// actually checks "what can I rewind to", so a gap between turn count and
			// checkpoint count belongs in the same view as the list itself.
			const failureNote =
				failedCaptureCount > 0
					? ` (${failedCaptureCount} checkpoint${failedCaptureCount === 1 ? "" : "s"} failed to capture this session — those turns have no safety net)`
					: "";
			if (checkpoints.length === 0) {
				ctx.ui.notify(`No checkpoints yet.${failureNote}`, failedCaptureCount > 0 ? "warning" : "info");
				return;
			}

			// Suffixed with a sha fragment so two checkpoints that render an identical
			// timestamp+subject (e.g. two captures within the same second) still map
			// back to the right entry via labels.indexOf() below.
			const labels = checkpoints.map(
				(c) => `${new Date(c.timestamp).toLocaleString()} — ${c.subject} (${c.sha.slice(0, 7)})`,
			);
			const choice = await ctx.ui.select(`Rewind to which checkpoint?${failureNote}`, labels);
			if (!choice) return;
			const target = checkpoints[labels.indexOf(choice)];
			if (!target) return;

			// What to rewind. Claude Code asks the same three-way question, and the two
			// halves are genuinely independent here: the git checkpoint restores files,
			// while the conversation lives in pi's session tree and is rewound by forking
			// at the user message that started the turn.
			const canRewindTalk = Boolean(target.turnEntryId);
			const SCOPES = [
				{ label: "Files only — restore the working tree, keep the conversation", files: true, talk: false },
				{ label: "Files and conversation — restore the tree and rewind the conversation", files: true, talk: true },
				{
					label: "Conversation only — rewind the conversation to that turn, leave files alone",
					files: false,
					talk: true,
				},
			].filter((scope) => !scope.talk || canRewindTalk);
			let scopeChoice = SCOPES[0];
			if (SCOPES.length > 1) {
				const scopeLabels = SCOPES.map((scope) => scope.label);
				const picked = await ctx.ui.select("Rewind what?", scopeLabels);
				if (!picked) return;
				scopeChoice = SCOPES[scopeLabels.indexOf(picked)];
			}
			if (!scopeChoice) return;

			// Conversation only: nothing touches the working tree, so none of the
			// safety-net machinery below applies. Navigating the tree is non-destructive —
			// the abandoned path stays in the session file — so there is nothing to
			// snapshot first.
			if (!scopeChoice.files) {
				await ctx.navigateTree(target.turnEntryId);
				return;
			}

			const restored = await restoreWithSafetyNet(
				pi,
				ctx,
				target.sha,
				"(before rewind)",
				`Restore the working tree to the checkpoint "${target.subject}"?`,
			);
			// Move the conversation LAST: it swaps what the session is pointing at, so
			// anything after it would run against state that is being replaced — the
			// same ordering FleetView's switchSession hand-off exists for.
			if (restored && scopeChoice.talk) await ctx.navigateTree(target.turnEntryId);
		},
	});
}

const checkpointsExtension: InlineExtension = { name: "checkpoints", factory };
export default checkpointsExtension.factory;
