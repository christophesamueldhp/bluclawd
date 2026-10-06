/**
 * Checkpoints: a restorable git snapshot of the working tree at the start of
 * every turn, so `/rewind` can restore the files, the conversation, or both.
 * The conversation is rewound with `ctx.navigateTree` to the user message that
 * started the turn.
 *
 * `navigateTree`, NOT `ctx.fork`: calling fork from this command handler
 * terminates the session (exit code 1, no stderr). navigateTree reaches the same
 * point, keeps the abandoned path in the file, and does not take the session
 * down. Do not switch to fork without re-testing that live. `git stash create`
 * is not used because it drops untracked files.
 *
 * ── Capture never touches the real index or working tree ─────────────────────
 * It works in a separate temporary index via `env GIT_INDEX_FILE=<tmp> git ...`
 * (POSIX-only; `ExecOptions` has no env passthrough):
 *   1. `read-tree HEAD` (skipped on an unborn HEAD), then `add -A`. Without the
 *      HEAD seed, tracked files matching .gitignore (the committed-then-ignored
 *      `.env` pattern) are missing from the tree and a restore DELETES them.
 *   2. `write-tree`, then `commit-tree [-p HEAD]` with fixed synthetic
 *      author/committer, so it never depends on the user's `git config`.
 *   3. `update-ref refs/bluclawd/checkpoints/<sessionId>/<sha>` keeps the commit
 *      safe from GC and out of `git tag`/`git branch` (`git log --all` still
 *      lists it).
 * The temp index lives under `os.tmpdir()` and is removed in a `finally`.
 *
 * ── Capture is fire-and-forget ───────────────────────────────────────────────
 * `turn_start` handlers are awaited inline, so the capture runs detached and its
 * entry is appended once the sha resolves. `turnEntryId`/`subject` are read at
 * THAT point, not at turn_start: turn_start fires before the prompt's user
 * message is persisted (on message_end), so the branch at turn_start still ends
 * at the PREVIOUS prompt. `isCapturing` drops an overlapping background capture;
 * the safety-net capture before a restore bypasses it.
 *
 * ── Restore is destructive and fail-closed ───────────────────────────────────
 * `git read-tree --reset -u <sha>` resets the index and working tree in one
 * step, and only runs through `restoreWithSafetyNet` after a confirmation. That
 * captures the current state first so the restore is undoable; if the capture
 * fails, restoring needs a separate "unrecoverable" confirmation. The index is
 * then reset to HEAD so the result reads as ordinary uncommitted work (what was
 * staged is not recorded, as with `git stash pop` without `--index`). Files
 * created after the checkpoint and never added survive a restore: `read-tree`
 * only touches paths that differ from the index.
 *
 * ── Refs are namespaced per session ──────────────────────────────────────────
 * Sessions sharing one `.git` must not sweep each other's refs; see
 * `pruneCheckpointRefs`. Pruning runs after every capture, so ref growth stays
 * bounded without `/rewind --prune`.
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, InlineExtension, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, type TUI } from "@earendil-works/pi-tui";

const CHECKPOINT_CUSTOM_TYPE = "checkpoint";
const CHECKPOINT_REF_PREFIX = "refs/bluclawd/checkpoints/";
/** Timeout for cheap git metadata/capture calls (rev-parse, add, write-tree, commit-tree, update-ref). */
const GIT_TIMEOUT_MS = 5000;
/**
 * The one destructive call (`git read-tree --reset -u`) gets its own budget: a
 * SIGTERM mid-restore on a large repo can leave a partially-applied tree.
 */
const RESTORE_TIMEOUT_MS = 30000;
const SUBJECT_MAX_CHARS = 100;
/**
 * Checkpoint refs kept for this session (the newest on the current branch);
 * older commits become normal git-GC candidates.
 */
const MAX_CHECKPOINT_REFS = 50;

/** Data persisted per checkpoint via `pi.appendEntry("checkpoint", ...)`. */
interface CheckpointData {
	/** Commit sha of the snapshot. */
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

/** The checkpoints on a branch (e.g. `ctx.sessionManager.getBranch()`), newest first. */
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
 * before the prune drops them.
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
 * Capture a snapshot of the working tree (tracked + untracked, respecting
 * .gitignore) as a commit, without touching the real index or working tree.
 * Returns the sha, or undefined on any failure or outside a git repo; never throws.
 */
export async function captureCheckpoint(
	cwd: string,
	exec: ExtensionAPI["exec"],
	sessionId: string,
): Promise<string | undefined> {
	if (!(await isGitRepo(cwd, exec))) return undefined;

	const tmpIndex = join(tmpdir(), `bluclawd-checkpoint-${randomUUID()}.index`);
	try {
		// Seed with HEAD so `add -A` keeps tracked files that match .gitignore;
		// without them a restore would delete those files.
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
 * Restore the working tree to a checkpoint; only call it from an explicit,
 * user-confirmed action. The index is then reset to HEAD so the result reads as
 * ordinary uncommitted work instead of a fully staged tree. Returns false (never
 * throws) if the sha can't be restored.
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
 * one `.git` never delete each other's live checkpoints:
 *   - `<sessionId>/<sha>` (this session): delete unless the sha is in `keepShas`.
 *   - `<sha>` directly under the prefix (older flat layout): the same rule.
 *   - `<otherSession>/<sha>`: delete only when the commit is older than
 *     FOREIGN_CHECKPOINT_TTL_DAYS. A ref with no committer date parses to NaN,
 *     fails the comparison, and is KEPT — the safe direction. Session ids are
 *     UUIDs, so the first `/` splits owner and sha.
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
 * Runs after every successful capture: keeps only the newest
 * `MAX_CHECKPOINT_REFS` shas on the current branch and sweeps stray refs, as
 * `/rewind --prune` does on request. Never throws.
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
 * the safety-net entry → restore → report. `restored` is true only when the tree
 * was restored; `safety` is the safety-net entry's data, when one was appended.
 * `intro` is the question the confirmation opens with.
 */
async function restoreWithSafetyNet(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	targetSha: string,
	safetySubject: string,
	intro: string,
): Promise<{ restored: boolean; safety?: CheckpointData }> {
	// Bypasses the isCapturing guard: this is a foreground, user-awaited action.
	// The captured tree doubles as the preview base, since `git diff <sha>`
	// against the working tree would skip untracked files.
	const safetySha = await captureCheckpoint(ctx.cwd, pi.exec, ctx.sessionManager.getSessionId());
	let safety: CheckpointData | undefined;
	if (safetySha) {
		const stat = await diffStat(ctx.cwd, pi.exec, safetySha, targetSha);
		if (stat !== undefined && stat.trim() === "") {
			ctx.ui.notify("Working tree already matches this checkpoint.", "info");
			return { restored: false };
		}
		const preview = stat === undefined ? "(preview unavailable)" : clipLines(stat, PREVIEW_MAX_LINES);
		const proceed = await ctx.ui.confirm(
			"Rewind",
			`${intro}\n\n${preview}\n\nYour current changes are checkpointed first, so this can be undone with /rewind. Continue?`,
		);
		// Declined: no entry is appended; the safety-net ref is swept by the next prune.
		if (!proceed) return { restored: false };
		safety = { sha: safetySha, turnEntryId: ctx.sessionManager.getLeafEntry()?.id ?? "", subject: safetySubject };
		pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, safety);
	} else {
		// Fail-closed: restoring now would overwrite uncommitted work with no
		// way to recover it, so only restore if the user opts in.
		const proceed = await ctx.ui.confirm(
			"Safety checkpoint failed",
			`${intro}\n\nCould not snapshot your current changes before rewinding (no preview either). If you restore now, your current uncommitted changes will be UNRECOVERABLE. Restore anyway, without a safety checkpoint?`,
		);
		if (!proceed) {
			ctx.ui.notify("Rewind aborted: safety checkpoint failed, current changes left untouched.", "error");
			return { restored: false };
		}
	}

	const restored = await restoreCheckpoint(ctx.cwd, pi.exec, targetSha);
	if (restored) {
		ctx.ui.notify("Working tree restored to checkpoint.", "info");
		return { restored: true, safety };
	}
	// read-tree can be interrupted mid-write (e.g. SIGTERM on RESTORE_TIMEOUT_MS);
	// point the user at the safety-net sha so they can get back.
	const recovery = safetySha
		? ` Your pre-rewind state is checkpointed at ${safetySha.slice(0, 7)} — run /rewind to return to it.`
		: "";
	ctx.ui.notify(
		`Failed to restore checkpoint; the working tree may be in a partially-applied state.${recovery}`,
		"error",
	);
	return { restored: false };
}

/** Overlap guard for the turn_start background capture. */
let isCapturing = false;

/**
 * Background captures this session that failed while `cwd` WAS a git repo;
 * reset on `session_start`. "Not a git repo" is expected and not counted —
 * these are turns silently left without a safety net.
 */
let failedCaptureCount = 0;

/**
 * Registration does no git work, so it is safe to run twice per load
 * (bootstrap + trust-resolving pass).
 */
export function factory(pi: ExtensionAPI): void {
	function checkpointCurrentTurn(ctx: ExtensionContext): void {
		if (isCapturing) return; // an in-flight capture: the next turn_start will try again
		isCapturing = true;
		const sessionId = ctx.sessionManager.getSessionId();
		void captureCheckpoint(ctx.cwd, pi.exec, sessionId)
			.then(async (sha) => {
				// Read AFTER the capture, not at turn_start: the prompt's user message
				// is persisted on message_end, which comes after turn_start.
				const { turnEntryId, subject } = findTurnContext(ctx.sessionManager.getBranch());
				if (sha) {
					pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, { sha, turnEntryId, subject });
					// Fire-and-forget, like capture itself — doesn't gate isCapturing below.
					void pruneOldCheckpointRefs(ctx.cwd, pi.exec, sessionId, ctx.sessionManager.getBranch());
					return;
				}
				// "Not a git repo" is expected and gets no notice; any other failure
				// (index.lock, timeout, ...) left this turn without a safety net.
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

	pi.on("session_start", async (_event, ctx) => {
		failedCaptureCount = 0;
		if (ctx.mode === "tui") listenForDoubleEscape(ctx);
	});

	/**
	 * Esc twice on an empty, idle prompt opens /rewind, as it opens rewind in Claude Code; pi's own
	 * double Esc (its /tree) never sees the second press.
	 */
	let offDoubleEscape: (() => void) | undefined;
	const listenForDoubleEscape = (ctx: ExtensionContext): void => {
		offDoubleEscape?.();
		// A zero-line widget, only to get hold of the TUI and see whether a dialog has the keys.
		let tui: TUI | undefined;
		ctx.ui.setWidget("checkpoints:tui", (widgetTui) => {
			tui = widgetTui;
			return { render: () => [], invalidate: () => {} };
		});
		let escapeAt = 0;
		offDoubleEscape = ctx.ui.onTerminalInput((data) => {
			if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
			if (!matchesKey(data, "escape")) {
				escapeAt = 0;
				return undefined;
			}
			if (!ctx.isIdle() || ctx.ui.getEditorText() !== "" || tui?.hasOverlay()) {
				escapeAt = 0;
				return undefined;
			}
			const now = Date.now();
			if (now - escapeAt < DOUBLE_ESCAPE_MS) {
				escapeAt = 0;
				pi.sendUserMessage("/rewind", { expandPromptTemplates: true });
				return { consume: true };
			}
			escapeAt = now;
			return undefined;
		});
	};

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
			// Surface capture failures here too: this is where users check what they
			// can rewind to.
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

			// The git checkpoint restores files; the conversation lives in pi's
			// session tree and is rewound to the user message that started the turn.
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

			// Conversation only: the working tree is untouched and navigating is
			// non-destructive, so there is nothing to snapshot first.
			if (!scopeChoice.files) {
				await ctx.navigateTree(target.turnEntryId);
				return;
			}

			const { restored, safety } = await restoreWithSafetyNet(
				pi,
				ctx,
				target.sha,
				"(before rewind)",
				`Restore the working tree to the checkpoint "${target.subject}"?`,
			);
			// Move the conversation after the restore: it swaps what the session points at.
			if (!restored || !scopeChoice.talk) return;
			const { cancelled } = await ctx.navigateTree(target.turnEntryId);
			// The safety net was appended on the branch just left, where /rewind no longer
			// lists it and pruning drops its ref; repeat it on the branch we landed on.
			if (!cancelled && safety) pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, safety);
		},
	});
}

/** pi's own double-Esc window. */
const DOUBLE_ESCAPE_MS = 500;

const checkpointsExtension: InlineExtension = { name: "checkpoints", factory };
export default checkpointsExtension.factory;
