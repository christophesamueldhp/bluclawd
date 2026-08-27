/**
 * Checkpoints core extension (Claude Code checkpoint/rewind parity — PLAN.md F1.6)
 *
 * Captures a restorable git snapshot of the working tree at the start of every
 * turn, so `/rewind` can time-travel the code back to an earlier point without
 * touching the conversation history. Donor `examples/extensions/git-checkpoint.ts`
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
 *   1. `env GIT_INDEX_FILE=<tmp> git add -A`   — stage the ENTIRE working tree
 *      (tracked + untracked, respecting .gitignore, matching `git stash`'s
 *      scope) into the fresh temp index. The real index is never opened.
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
 * agent loop. See `test/core-ext-checkpoints.test.ts` for the byte-identical
 * before/after proof.
 *
 * ── Latency: fire-and-forget capture ──────────────────────────────────────────
 * `turn_start` handlers are awaited inline in the agent loop (confirmed for
 * turn_end by statusline — same mechanism applies to turn_start), so a capture
 * that blocks would add real per-turn latency. The handler therefore captures
 * `turnEntryId`/`subject` SYNCHRONOUSLY (from the branch as of turn_start — cheap,
 * in-memory) and then kicks off `captureCheckpoint()` detached (`void ... .then`),
 * appending the `checkpoint` entry only once the sha resolves. This keeps the
 * turn/subject association correct even though the entry lands asynchronously.
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
 * touch the user's working tree, and only ever runs from an explicit, confirmed
 * `/rewind` (or a fork-point restore the user opted into). It gets its own larger
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
 * Files present in the checkpoint tree that were previously untracked become
 * tracked/staged after a restore (tree objects don't record "trackedness") —
 * documented, not fixed, to keep this file within scope.
 *
 * The inverse also holds (2026-07-10 review I6): `read-tree --reset -u` only
 * touches paths that differ between the target tree and the current index, so a
 * file created AFTER the checkpoint (agent-written, never git-added) is in
 * neither and SURVIVES a `/rewind` or fork-restore. Removing such strays would
 * need an explicit untracked-diff + delete pass with its own safety questions
 * (it would erase files the USER dropped in too) — documented, not fixed.
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

function refNameForSha(sha: string): string {
	return `${CHECKPOINT_REF_PREFIX}${sha}`;
}

export async function isGitRepo(cwd: string, exec: ExtensionAPI["exec"]): Promise<boolean> {
	const result = await exec("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	return result?.code === 0 && result.stdout.trim() === "true";
}

/**
 * Capture a restorable snapshot of the working tree (tracked + untracked files,
 * respecting .gitignore) as a git commit object, without touching the real index
 * or working tree (see file header for the temp-index mechanism). Returns the
 * commit sha, or undefined on any failure or when `cwd` isn't a git repo — never
 * throws (silent no-op).
 */
export async function captureCheckpoint(cwd: string, exec: ExtensionAPI["exec"]): Promise<string | undefined> {
	if (!(await isGitRepo(cwd, exec))) return undefined;

	const tmpIndex = join(tmpdir(), `bluclawd-checkpoint-${randomUUID()}.index`);
	try {
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

		const headRef = await exec("git", ["rev-parse", "HEAD"], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
		}).catch(() => undefined);
		const parentArgs = headRef?.code === 0 && headRef.stdout.trim() ? ["-p", headRef.stdout.trim()] : [];

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

		const updateRef = await exec("git", ["update-ref", refNameForSha(sha), sha], {
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
 * Restore the working tree AND index to a previously captured checkpoint. This
 * is the one deliberately destructive operation in this file — only call it
 * from an explicit, user-confirmed action. Returns false (never throws) if the
 * sha can't be restored (e.g. not a git repo, unknown sha).
 */
export async function restoreCheckpoint(cwd: string, exec: ExtensionAPI["exec"], sha: string): Promise<boolean> {
	const result = await exec("git", ["read-tree", "--reset", "-u", sha], {
		cwd,
		timeout: RESTORE_TIMEOUT_MS,
	}).catch(() => undefined);
	return result?.code === 0;
}

/**
 * Delete every `refs/bluclawd/checkpoints/*` ref whose sha is not in `keepShas`.
 * Returns the number of refs removed. Never throws.
 */
export async function pruneCheckpointRefs(
	cwd: string,
	exec: ExtensionAPI["exec"],
	keepShas: ReadonlySet<string>,
): Promise<number> {
	const list = await exec("git", ["for-each-ref", "--format=%(refname)", CHECKPOINT_REF_PREFIX], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	if (!list || list.code !== 0) return 0;

	const refs = list.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	let removed = 0;
	for (const ref of refs) {
		const sha = ref.slice(CHECKPOINT_REF_PREFIX.length);
		if (keepShas.has(sha)) continue;
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
async function pruneOldCheckpointRefs(cwd: string, exec: ExtensionAPI["exec"], branch: SessionEntry[]): Promise<void> {
	const shas = listCheckpoints(branch).map((c) => c.sha); // newest-first
	await pruneCheckpointRefs(cwd, exec, new Set(shas.slice(0, MAX_CHECKPOINT_REFS)));
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
		const { turnEntryId, subject } = findTurnContext(ctx.sessionManager.getBranch());
		isCapturing = true;
		void captureCheckpoint(ctx.cwd, pi.exec)
			.then(async (sha) => {
				if (sha) {
					pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, { sha, turnEntryId, subject });
					// Fire-and-forget, like capture itself — doesn't gate isCapturing below.
					void pruneOldCheckpointRefs(ctx.cwd, pi.exec, ctx.sessionManager.getBranch());
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

	// Donor behavior (git-checkpoint.ts): offer to restore the checkpoint at the
	// fork point, kept simple (no auto-restore, always asks first).
	pi.on("session_before_fork", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const match = listCheckpoints(ctx.sessionManager.getBranch()).find((c) => c.turnEntryId === event.entryId);
		if (!match) return;

		const choice = await ctx.ui.select(`Restore code to the checkpoint at this fork point? (${match.subject})`, [
			"Yes, restore code to that checkpoint",
			"No, keep current code",
		]);
		if (choice?.startsWith("Yes")) {
			const restored = await restoreCheckpoint(ctx.cwd, pi.exec, match.sha);
			ctx.ui.notify(
				restored ? "Code restored to checkpoint." : "Failed to restore checkpoint.",
				restored ? "info" : "error",
			);
		}
	});

	pi.registerCommand("rewind", {
		description: "Restore the working tree to a previous checkpoint (`--prune` to clean up old checkpoint refs)",
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();
			if (trimmed === "--prune" || trimmed === "prune") {
				const keepShas = new Set(listCheckpoints(ctx.sessionManager.getBranch()).map((c) => c.sha));
				const removed = await pruneCheckpointRefs(ctx.cwd, pi.exec, keepShas);
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

			const confirmed = await ctx.ui.confirm(
				"Rewind",
				"This will overwrite your current uncommitted changes with the selected checkpoint. Continue?",
			);
			if (!confirmed) return;

			// Safety net: checkpoint the current (about-to-be-overwritten) state first
			// so the rewind itself can be undone with another /rewind. Deliberately
			// bypasses the isCapturing guard (see file header) — this is a foreground,
			// user-awaited, one-off action.
			const safetySha = await captureCheckpoint(ctx.cwd, pi.exec);
			if (safetySha) {
				pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, {
					sha: safetySha,
					turnEntryId: ctx.sessionManager.getLeafEntry()?.id ?? "",
					subject: "(before rewind)",
				});
			} else {
				// Fail-closed. The safety-net capture failed (e.g. timeout on a very
				// large tree, or a transient git error), so restoring now would
				// overwrite the user's current uncommitted work with NO way to recover
				// it — exactly the data loss the safety net exists to prevent. Do NOT
				// restore unless the user explicitly opts into that unsafe path.
				const proceed = await ctx.ui.confirm(
					"Safety checkpoint failed",
					"Could not snapshot your current changes before rewinding. If you restore now, your current uncommitted changes will be UNRECOVERABLE. Restore anyway, without a safety checkpoint?",
				);
				if (!proceed) {
					ctx.ui.notify("Rewind aborted: safety checkpoint failed, current changes left untouched.", "error");
					return;
				}
			}

			const restored = await restoreCheckpoint(ctx.cwd, pi.exec, target.sha);
			if (restored) {
				ctx.ui.notify("Working tree restored to checkpoint.", "info");
			} else {
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
			}
		},
	});
}

const checkpointsExtension: InlineExtension = { name: "checkpoints", factory };
export default checkpointsExtension;
