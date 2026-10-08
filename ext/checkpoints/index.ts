/**
 * Checkpoints: a restorable git snapshot of the working tree whenever a user
 * message (a prompt, a steer or a follow-up) enters the conversation, so
 * `/rewind` can restore the files, the conversation, or both, as Claude Code's
 * rewind does. The conversation is rewound with `ctx.navigateTree` to the user
 * message, which leaves the session just before it with its text in the editor.
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
 * `message_end` handlers are awaited inline, so the capture runs detached and
 * its entry is appended once the sha resolves. `turnEntryId`/`subject` are read
 * at THAT point: extensions see a message's message_end before pi persists it.
 * `isCapturing` drops an overlapping background capture; the safety-net capture
 * before a restore bypasses it.
 *
 * ── Restore is destructive and fail-closed ───────────────────────────────────
 * `git read-tree --reset -u <sha>` resets the index and working tree in one
 * step, and only runs after the user chose it: in `/rewind` the option menu is
 * the confirmation (as in Claude Code), the fork-point offer asks with a
 * preview. The current state is captured first so the restore is undoable; if
 * that capture fails, restoring needs a separate "unrecoverable" confirmation. The index is
 * then reset to HEAD so the result reads as ordinary uncommitted work (what was
 * staged is not recorded, as with `git stash pop` without `--index`).
 *
 * ── New files: only the agent's are removed ─────────────────────────────────
 * As in Claude Code, a restore removes the files the agent created since the
 * checkpoint and keeps the user's. A `write`/`bash`/`powershell` call lists
 * the untracked files before and after it runs; the new ones are appended as a
 * `checkpoint-created` entry. A restore diffs the checkpoint against the safety
 * net for the files added since, removes the agent's (`read-tree` alone leaves
 * untracked ones) and writes the user's back. Without a safety net no file is
 * removed, as nothing could bring it back.
 *
 * ── Refs are namespaced per session ──────────────────────────────────────────
 * Sessions sharing one `.git` must not sweep each other's refs; see
 * `pruneCheckpointRefs`. Pruning runs after every capture, so ref growth stays
 * bounded without `/rewind --prune`.
 */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
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
	/** Id of the session entry (the user message) this checkpoint was taken for. */
	turnEntryId: string;
	/** Short label for display — usually that user message's text. */
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
 * The checkpoint of the user message `turnEntryId`, for /rewind and forking:
 * the OLDEST capture with that id. Older sessions captured every turn of a
 * prompt under the same id; the first capture is the tree before the prompt
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

type UserEntry = SessionMessageEntry & { message: Extract<SessionMessageEntry["message"], { role: "user" }> };

function userEntries(branch: SessionEntry[]): UserEntry[] {
	return branch.filter((e): e is UserEntry => e.type === "message" && e.message.role === "user");
}

function userSubject(entry: UserEntry): string {
	return truncateSubject(extractUserText(entry.message.content));
}

/**
 * The entry `message` was persisted as (pi appends the very object it emits),
 * else the latest user message on the branch, for labeling.
 */
function findTurnContext(
	branch: SessionEntry[],
	message: unknown,
): {
	turnEntryId: string;
	subject: string;
} {
	const users = userEntries(branch);
	const entry = users.find((e) => e.message === message) ?? users.at(-1);
	if (entry) return { turnEntryId: entry.id, subject: userSubject(entry) };
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

/** A path from the repository root as a pathspec, whatever `cwd` is. */
function topPathspec(path: string, magic = ""): string {
	return `:(top,literal${magic})${path}`;
}

/** Paths (from the repository root) in `currentSha` but not in `sha`; undefined on a git error. */
async function addedFiles(
	cwd: string,
	exec: ExtensionAPI["exec"],
	sha: string,
	currentSha: string,
): Promise<string[] | undefined> {
	const result = await exec("git", ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=A", sha, currentSha], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	return result?.code === 0 ? result.stdout.split("\0").filter(Boolean) : undefined;
}

/** Of the files added since `sha`, the ones a restore keeps: all but the agent's. */
async function userAddedFiles(
	cwd: string,
	exec: ExtensionAPI["exec"],
	sha: string,
	currentSha: string,
	agentCreated: ReadonlySet<string>,
): Promise<string[]> {
	return ((await addedFiles(cwd, exec, sha, currentSha)) ?? []).filter((path) => !agentCreated.has(path));
}

/**
 * Restore the working tree to a checkpoint; only call it from an explicit,
 * user-confirmed action. `currentSha`, a capture of the tree being replaced,
 * names the files added since the checkpoint: those in `agentCreated` (paths
 * from the repository root) are removed, the rest kept as they are. The index
 * is then reset to HEAD so the result reads as ordinary uncommitted work instead
 * of a fully staged tree. Returns false (never throws) if the sha can't be restored.
 */
export async function restoreCheckpoint(
	cwd: string,
	exec: ExtensionAPI["exec"],
	sha: string,
	currentSha?: string,
	agentCreated: ReadonlySet<string> = new Set(),
): Promise<boolean> {
	const added = currentSha ? await addedFiles(cwd, exec, sha, currentSha) : [];
	if (!added) return false;

	const result = await exec("git", ["read-tree", "--reset", "-u", sha], {
		cwd,
		timeout: RESTORE_TIMEOUT_MS,
	}).catch(() => undefined);
	if (result?.code !== 0) return false;

	// read-tree removed the tracked ones; with the index now at `sha`, the rest
	// are untracked.
	const remove = added.filter((path) => agentCreated.has(path)).map((path) => topPathspec(path));
	if (remove.length > 0) {
		const clean = await exec("git", ["clean", "-f", "-q", "--", ...remove], {
			cwd,
			timeout: RESTORE_TIMEOUT_MS,
		}).catch(() => undefined);
		if (clean?.code !== 0) return false;
	}
	// The user's: read-tree removed the tracked ones, so write them all back.
	const keep = added.filter((path) => !agentCreated.has(path)).map((path) => topPathspec(path));
	if (currentSha && keep.length > 0) {
		const checkout = await exec("git", ["checkout", currentSha, "--", ...keep], {
			cwd,
			timeout: RESTORE_TIMEOUT_MS,
		}).catch(() => undefined);
		if (checkout?.code !== 0) return false;
	}

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

/** Pathspecs that leave `paths` (from the repository root) out of a diff. */
function excludeArgs(paths: string[]): string[] {
	return paths.length > 0 ? ["--", ...paths.map((path) => topPathspec(path, ",exclude"))] : [];
}

/**
 * `git diff --stat` from one checkpoint commit to another — what restoring
 * `toSha` changes relative to the tree captured as `fromSha`, leaving out
 * `exclude`. Undefined on any git error; the empty string when the trees are identical.
 */
async function diffStat(
	cwd: string,
	exec: ExtensionAPI["exec"],
	fromSha: string,
	toSha: string,
	exclude: string[] = [],
): Promise<string | undefined> {
	const result = await exec("git", ["diff", "--stat", "--stat-width=80", fromSha, toSha, ...excludeArgs(exclude)], {
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

interface DiffStats {
	files: string[];
	insertions: number;
	deletions: number;
}

/**
 * What changes from `fromSha` to `toSha`, or to the working tree's tracked
 * files when `toSha` is undefined, leaving out `exclude`. Undefined on any git
 * error, e.g. a sha whose ref was pruned and the commit collected.
 */
async function diffNumstat(
	cwd: string,
	exec: ExtensionAPI["exec"],
	fromSha: string,
	toSha?: string,
	exclude: string[] = [],
): Promise<DiffStats | undefined> {
	const args = ["diff", "--numstat", "--no-renames", fromSha, ...(toSha ? [toSha] : []), ...excludeArgs(exclude)];
	const result = await exec("git", args, {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	if (result?.code !== 0) return undefined;
	const stats: DiffStats = { files: [], insertions: 0, deletions: 0 };
	for (const line of result.stdout.split("\n")) {
		const [added, removed, file] = line.split("\t");
		if (!file) continue;
		stats.files.push(file);
		// Binary files show "-" for both counts.
		stats.insertions += Number.parseInt(added ?? "", 10) || 0;
		stats.deletions += Number.parseInt(removed ?? "", 10) || 0;
	}
	return stats;
}

/** A prompt row's note in /rewind, worded as in Claude Code. */
function rowNote(stats: DiffStats | undefined): string {
	if (!stats) return "⚠ No code restore";
	const counts = `+${stats.insertions} -${stats.deletions}`;
	if (stats.files.length === 0) return "No code changes";
	if (stats.files.length === 1) return `${basename(stats.files[0] ?? "")} ${counts}`;
	return `${stats.files.length} files changed ${counts}`;
}

/** What "Restore code" would do, worded as in Claude Code. */
function restoreEffect(stats: DiffStats): string {
	const [first = "", second = ""] = stats.files.map((file) => basename(file));
	if (!first) return "The code has not changed (nothing will be restored).";
	const files =
		stats.files.length === 1
			? first
			: stats.files.length === 2
				? `${first} and ${second}`
				: `${first} and ${stats.files.length - 1} other files`;
	return `The code will be restored +${stats.insertions} -${stats.deletions} in ${files}.`;
}

/** Suffix repeats with " (2)", " (3)", ... so `select`'s answer maps back to one row. */
function uniqueLabels(labels: string[]): string[] {
	const seen = new Map<string, number>();
	return labels.map((label) => {
		const n = (seen.get(label) ?? 0) + 1;
		seen.set(label, n);
		return n === 1 ? label : `${label} (${n})`;
	});
}

/**
 * The fork-point offer: safety-net capture → ONE confirmation that previews
 * what the restore changes → `restoreOverSafetyNet`.
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
	if (safetySha) {
		const kept = await userAddedFiles(
			ctx.cwd,
			pi.exec,
			targetSha,
			safetySha,
			agentCreatedFiles(ctx.sessionManager.getEntries()),
		);
		const stat = await diffStat(ctx.cwd, pi.exec, safetySha, targetSha, kept);
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
	}
	return restoreOverSafetyNet(pi, ctx, targetSha, safetySha, safetySubject, intro);
}

/**
 * The destructive tail shared by `/rewind` and the fork-point offer, once the
 * user chose to restore: append the safety-net entry for `safetySha` (or ask the
 * fail-closed question when the capture failed) → restore → report. `restored`
 * is true only when the tree was restored; `safety` is the safety-net entry's
 * data, when one was appended. `intro` opens the fail-closed question.
 */
async function restoreOverSafetyNet(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	targetSha: string,
	safetySha: string | undefined,
	safetySubject: string,
	intro: string,
): Promise<{ restored: boolean; safety?: CheckpointData }> {
	let safety: CheckpointData | undefined;
	if (safetySha) {
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

	const agentCreated = agentCreatedFiles(ctx.sessionManager.getEntries());
	const restored = await restoreCheckpoint(ctx.cwd, pi.exec, targetSha, safetySha, agentCreated);
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

const CREATED_CUSTOM_TYPE = "checkpoint-created";
/** The tools whose new files a restore removes. */
const CREATING_TOOLS = new Set(["write", "bash", "powershell"]);

/** Untracked, not ignored files in the whole repository, by path from its root; undefined outside one. */
async function untrackedFiles(cwd: string, exec: ExtensionAPI["exec"]): Promise<Set<string> | undefined> {
	const result = await exec("git", ["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ":/"], {
		cwd,
		timeout: GIT_TIMEOUT_MS,
	}).catch(() => undefined);
	return result?.code === 0 ? new Set(result.stdout.split("\0").filter(Boolean)) : undefined;
}

/**
 * The files the agent created this session, by path from the repository root.
 * Every entry counts, not just the branch's: a conversation rewind leaves the files.
 */
export function agentCreatedFiles(entries: SessionEntry[]): Set<string> {
	const paths = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CREATED_CUSTOM_TYPE) continue;
		for (const path of (entry.data as { paths?: string[] } | undefined)?.paths ?? []) paths.add(path);
	}
	return paths;
}

/** Overlap guard for the message_end background capture. */
let isCapturing = false;

/**
 * Background captures this session that failed while `cwd` WAS a git repo;
 * reset on `session_start`. "Not a git repo" is expected and not counted —
 * these are prompts silently left without a safety net.
 */
let failedCaptureCount = 0;

/**
 * Registration does no git work, so it is safe to run twice per load
 * (bootstrap + trust-resolving pass).
 */
export function factory(pi: ExtensionAPI): void {
	function checkpointUserMessage(ctx: ExtensionContext, message: unknown): void {
		if (isCapturing) return; // an in-flight capture: this message goes without a checkpoint
		isCapturing = true;
		const sessionId = ctx.sessionManager.getSessionId();
		void captureCheckpoint(ctx.cwd, pi.exec, sessionId)
			.then(async (sha) => {
				// Read AFTER the capture: pi persists the message after its message_end handlers.
				const { turnEntryId, subject } = findTurnContext(ctx.sessionManager.getBranch(), message);
				if (sha) {
					pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, { sha, turnEntryId, subject });
					// Fire-and-forget, like capture itself — doesn't gate isCapturing below.
					void pruneOldCheckpointRefs(ctx.cwd, pi.exec, sessionId, ctx.sessionManager.getBranch());
					return;
				}
				// "Not a git repo" is expected and gets no notice; any other failure
				// (index.lock, timeout, ...) left this prompt without a safety net.
				if (!(await isGitRepo(ctx.cwd, pi.exec))) return;
				failedCaptureCount++;
				if (failedCaptureCount === 1 && ctx.hasUI) {
					ctx.ui.notify(
						`Checkpoint capture failed for "${subject}" — this prompt has no code restore in /rewind. ` +
							"Run /rewind to see which prompts are covered.",
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

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role === "user") checkpointUserMessage(ctx, event.message);
	});

	// Untracked files before each creating tool call, by toolCallId.
	const untrackedBefore = new Map<string, Set<string>>();
	pi.on("tool_call", async (event, ctx) => {
		if (!CREATING_TOOLS.has(event.toolName)) return;
		const before = await untrackedFiles(ctx.cwd, pi.exec);
		if (before) untrackedBefore.set(event.toolCallId, before);
	});
	pi.on("tool_result", async (event, ctx) => {
		const before = untrackedBefore.get(event.toolCallId);
		if (!before) return;
		untrackedBefore.delete(event.toolCallId);
		const after = await untrackedFiles(ctx.cwd, pi.exec);
		const created = [...(after ?? [])].filter((path) => !before.has(path));
		if (created.length > 0) pi.appendEntry(CREATED_CUSTOM_TYPE, { paths: created });
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

			// One row per prompt, plus the safety nets (taken for no prompt) so a rewind
			// can be undone; newest first, so select starts on the most recent.
			const branch = ctx.sessionManager.getBranch();
			const promptIds = new Set(userEntries(branch).map((e) => e.id));
			const checkpointsById = new Map(listCheckpoints(branch).map((c) => [c.entryId, c]));
			const points: Array<{ prompt?: UserEntry; checkpoint?: Checkpoint; subject: string }> = [];
			for (const entry of branch) {
				if (entry.type === "message" && promptIds.has(entry.id)) {
					const prompt = entry as UserEntry;
					points.push({ prompt, checkpoint: checkpointForTurn(branch, prompt.id), subject: userSubject(prompt) });
				}
				const checkpoint = checkpointsById.get(entry.id);
				if (checkpoint && !promptIds.has(checkpoint.turnEntryId))
					points.push({ checkpoint, subject: checkpoint.subject });
			}
			points.reverse();
			if (points.length === 0) {
				ctx.ui.notify("Nothing to rewind to yet.", "info");
				return;
			}

			// The current tree: the base for each row's changes and the restore preview,
			// and the safety net if a restore follows (unused, its ref goes with the next prune).
			// Bypasses the isCapturing guard: this is a foreground, user-awaited action.
			const currentSha = await captureCheckpoint(ctx.cwd, pi.exec, ctx.sessionManager.getSessionId());
			// What changed since each point: its checkpoint to the next newer one, or to now.
			// A failed diff (no checkpoint, or its commit is gone) means no code restore.
			let newerSha = currentSha;
			const rows = points.map((point) => {
				const { checkpoint } = point;
				const row = { ...point, toSha: newerSha };
				if (checkpoint) newerSha = checkpoint.sha;
				return row;
			});
			const stats = await Promise.all(
				rows.map((row) =>
					row.checkpoint ? diffNumstat(ctx.cwd, pi.exec, row.checkpoint.sha, row.toSha) : undefined,
				),
			);

			// Surface capture failures here too: this is where users check what they
			// can rewind to.
			const failureNote =
				failedCaptureCount > 0
					? ` (${failedCaptureCount} checkpoint${failedCaptureCount === 1 ? "" : "s"} failed to capture this session — those prompts have no code restore)`
					: "";
			const labels = uniqueLabels(rows.map((row, i) => `${row.subject} · ${rowNote(stats[i])}`));
			const choice = await ctx.ui.select(`Rewind to:${failureNote}`, labels);
			if (!choice) return;
			const index = labels.indexOf(choice);
			const row = rows[index];
			if (!row) return;
			const target = stats[index] ? row.checkpoint : undefined;

			const kept =
				target && currentSha
					? await userAddedFiles(
							ctx.cwd,
							pi.exec,
							target.sha,
							currentSha,
							agentCreatedFiles(ctx.sessionManager.getEntries()),
						)
					: [];
			const effect =
				target && currentSha ? await diffNumstat(ctx.cwd, pi.exec, currentSha, target.sha, kept) : undefined;
			const BOTH = "Restore code and conversation";
			const TALK = "Restore conversation";
			const CODE = "Restore code";
			const scope = await ctx.ui.select(
				[
					row.prompt
						? "Confirm you want to restore to the point before you sent this message:"
						: "Confirm you want to restore the code to this checkpoint:",
					row.subject,
					...(effect ? [restoreEffect(effect)] : []),
				].join("\n\n"),
				!row.prompt ? [CODE, "Never mind"] : target ? [BOTH, TALK, CODE, "Never mind"] : [TALK, "Never mind"],
			);
			if (scope !== BOTH && scope !== TALK && scope !== CODE) return;

			// Conversation only: the working tree is untouched and navigating is
			// non-destructive, so there is nothing to snapshot first.
			if (scope === TALK || !target) {
				if (row.prompt) await ctx.navigateTree(row.prompt.id);
				return;
			}

			let safety: CheckpointData | undefined;
			if (effect?.files.length === 0) {
				ctx.ui.notify("Working tree already matches this checkpoint.", "info");
				if (scope === CODE) return;
			} else {
				const result = await restoreOverSafetyNet(
					pi,
					ctx,
					target.sha,
					currentSha,
					"(before rewind)",
					`Restore the working tree to the checkpoint "${target.subject}"?`,
				);
				if (!result.restored) return;
				safety = result.safety;
			}
			// Move the conversation after the restore: it swaps what the session points at.
			if (scope === CODE || !row.prompt) return;
			const { cancelled } = await ctx.navigateTree(row.prompt.id);
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
