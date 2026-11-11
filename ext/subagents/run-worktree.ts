/**
 * The isolated Git worktree a run that edits works in (ADR-0010). Its baseline is its orchestrator's checkout as it was
 * at the run's Admission: HEAD, the staged changes and the working files, untracked ones included, ignored ones not.
 * Capturing it touches nothing of the user's: Git records it from a copy of the index, as commits no branch holds,
 * kept by a private ref, `refs/bluclawd/runs/<run>/baseline`. The worktree is made from that, however long the run
 * waited for its turn: HEAD the checkout's, index its staged state, files its working state. Once its run ended, a
 * worktree left exactly as made is removed, a Resume making it again from that baseline; one holding changes stays
 * until its user cleans it up (workspace-cleanup.ts), and a run that never started leaves nothing.
 */
import { execFile, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { writeAtomicPrivateFile } from "./storage.ts";

export interface RunBaseline {
	/** The root of the repository the run was admitted in, real, and the Git directory all its worktrees share. */
	source: string;
	gitDir: string;
	/** The checkout's HEAD at Admission, and the trees of its index and of its working files then. */
	head: string;
	index: string;
	tree: string;
	/** The commit holding the working tree, its parent the index's, its parent HEAD; and the private ref keeping it. */
	commit: string;
	ref: string;
}

/** A run's own worktree, and what it was made from. */
export interface IsolatedWorkspace {
	/** The worktree's root, real. */
	root: string;
	baseline: RunBaseline;
}

/** The variables that would point Git at another repository, index or work tree than those given here. */
const REDIRECTING_GIT_ENV = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_NAMESPACE",
];
const GIT_TIMEOUT_MS = 60_000;
/** As many changed paths as a Report lists; the rest are counted. */
const MAX_LISTED_CHANGES = 50;

export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const name of REDIRECTING_GIT_ENV) delete env[name];
	return {
		...env,
		GIT_AUTHOR_NAME: "bluclawd",
		GIT_AUTHOR_EMAIL: "bluclawd@localhost",
		GIT_COMMITTER_NAME: "bluclawd",
		GIT_COMMITTER_EMAIL: "bluclawd@localhost",
		...extra,
	};
}

/** Never the repository's hooks: nothing of the user's runs because a run was admitted. */
const gitArgs = (args: string[]) => ["-c", "core.hooksPath=/dev/null", ...args];

export function gitSync(cwd: string, args: string[], env = gitEnv()): string {
	const result = spawnSync("git", gitArgs(args), { cwd, env, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
	if (result.status !== 0) {
		throw new Error((result.stderr || result.error?.message || `git ${args[0]} failed`).trim().split("\n")[0]);
	}
	return result.stdout.trim();
}

export function git(cwd: string, args: string[], env = gitEnv()): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			gitArgs(args),
			{ cwd, env, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) reject(new Error((stderr || error.message).trim().split("\n")[0]));
				else resolve(stdout);
			},
		);
	});
}

/** Runs `use` with a scratch index file, copied from `from` when given, and removes it after. */
export function withScratchIndex<T>(from: string | undefined, use: (index: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "bluclawd-index-"));
	const index = join(dir, "index");
	if (from && existsSync(from)) copyFileSync(from, index);
	const done = () => rmSync(dir, { recursive: true, force: true });
	try {
		const result = use(index);
		if (result instanceof Promise) return result.finally(done) as T;
		done();
		return result;
	} catch (error) {
		done();
		throw error;
	}
}

/** Why no worktree can be made from the checkout `cwd` is in, as far as is known before its state is recorded. */
export function worktreeUnavailable(cwd: string): string | undefined {
	let source: string;
	try {
		source = realpathSync(gitSync(cwd, ["rev-parse", "--show-toplevel"]));
	} catch {
		return `${cwd} is not in a Git repository`;
	}
	try {
		gitSync(cwd, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
	} catch {
		return `${source} has no commit yet`;
	}
	return undefined;
}

/**
 * Records the checkout `cwd` is in as it is now, for run `runId`: refused outside Git, before a first commit, with
 * unresolved conflicts, or when `cwd` itself is not part of what is recorded (an ignored directory). `cwd` is real.
 */
export function captureRunBaseline(
	cwd: string,
	runId: string,
): { ok: true; baseline: RunBaseline; cwd: string } | { ok: false; error: string } {
	let source: string;
	try {
		source = realpathSync(gitSync(cwd, ["rev-parse", "--show-toplevel"]));
	} catch {
		return { ok: false, error: `${cwd} is not in a Git repository` };
	}
	let head: string;
	try {
		head = gitSync(cwd, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
	} catch {
		return { ok: false, error: `${source} has no commit yet` };
	}
	try {
		const gitDir = realpathSync(gitSync(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
		const indexFile = gitSync(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
		const rel = relative(source, cwd).split(sep).join("/");
		// The user's own index is only copied: even write-tree may rewrite the one it reads.
		const { index, tree } = withScratchIndex(indexFile, (scratch) => {
			const env = gitEnv({ GIT_INDEX_FILE: scratch });
			const index = gitSync(source, ["write-tree"], env);
			gitSync(source, ["add", "-A"], env);
			return { index, tree: gitSync(source, ["write-tree"], env) };
		});
		const message = (what: string) => `bluclawd: ${what} at the Admission of run ${runId}`;
		const staged = gitSync(source, [
			"commit-tree",
			"--no-gpg-sign",
			index,
			"-p",
			head,
			"-m",
			message("staged state"),
		]);
		const commit = gitSync(source, [
			"commit-tree",
			"--no-gpg-sign",
			tree,
			"-p",
			staged,
			"-m",
			message("working tree"),
		]);
		if (!holdsDirectory(source, commit, rel)) {
			return {
				ok: false,
				error: `${cwd} is not a directory of the state recorded: it is ignored, or holds no file`,
			};
		}
		const ref = `refs/bluclawd/runs/${runId}/baseline`;
		gitSync(source, ["update-ref", ref, commit, ""]);
		return { ok: true, baseline: { source, gitDir, head, index, tree, commit, ref }, cwd: rel };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `Git could not record the state of ${source} (${reason})` };
	}
}

function holdsDirectory(source: string, commit: string, rel: string): boolean {
	try {
		return gitSync(source, ["cat-file", "-t", `${commit}:${rel}`]) === "tree";
	} catch {
		return false;
	}
}

/** Lets go of a baseline no run was admitted with. */
export function dropRunBaseline(baseline: RunBaseline): void {
	try {
		gitSync(baseline.source, ["update-ref", "-d", baseline.ref]);
	} catch {
		// Kept: a private ref, which holds nothing of the user's.
	}
}

/** The run a worktree is kept for, and where. */
export interface WorktreeOwner {
	agentDir: string;
	runId: string;
	runDir: string;
}

/**
 * Removes the run's worktree and Git's entry for it. Only the path bluclawd gives that run's worktree is ever
 * removed, whatever its definition says.
 */
function removeWorktree({ root, baseline }: IsolatedWorkspace, owner: WorktreeOwner): void {
	assertOwned(root, owner);
	const remove = () => gitSync(baseline.source, ["worktree", "remove", "--force", "--force", root]);
	try {
		remove();
	} catch {
		if (!existsSync(root)) return;
		// Not a worktree Git knows: what a removal or a restoration that did not finish left at the run's path.
		rmSync(root, { recursive: true, force: true });
		try {
			remove();
		} catch {
			// Git had no entry for it.
		}
	}
}

function assertOwned(root: string, owner: WorktreeOwner): void {
	if (root !== worktreePath(owner.agentDir, owner.runId)) {
		throw new Error(`${root} is not the worktree of run ${owner.runId}`);
	}
}

/** Lets go of the worktree of a run that never started, and of its baseline: nothing of it is left to resume. */
export function discardWorktree(workspace: IsolatedWorkspace, owner: WorktreeOwner): void {
	try {
		removeRecorded(workspace, owner, { restorable: false, changes: [], neverStarted: true });
	} catch {
		// Kept, like any worktree of a run: only its user removes it then.
		return;
	}
	dropRunBaseline(workspace.baseline);
}

/** Makes the run's worktree from its baseline; it must not exist yet. */
export async function materializeWorktree({ root, baseline }: IsolatedWorkspace): Promise<void> {
	mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
	await git(baseline.source, ["worktree", "add", "--detach", "--no-checkout", root, baseline.head]);
	await git(root, ["read-tree", "--reset", "-u", baseline.tree]);
	await git(root, ["read-tree", baseline.index]);
}

/**
 * What changed in the worktree since its baseline, as Git's status letter and path, untracked files included. Git is
 * pointed at the repository explicitly: the worktree's own `.git` is the run's to write, and is never followed.
 */
export function worktreeChanges({ root, baseline }: IsolatedWorkspace): Promise<string[]> {
	return withScratchIndex(undefined, async (scratch) => {
		const env = gitEnv({ GIT_DIR: baseline.gitDir, GIT_WORK_TREE: root, GIT_INDEX_FILE: scratch });
		await git(root, ["read-tree", baseline.tree], env);
		await git(root, ["add", "-A"], env);
		const after = (await git(root, ["write-tree"], env)).trim();
		const listed = (
			await git(root, ["diff-tree", "-r", "--no-renames", "--name-status", "-z", baseline.tree, after], env)
		)
			.split("\0")
			.filter(Boolean);
		const changes: string[] = [];
		for (let i = 0; i + 1 < listed.length; i += 2) changes.push(`${listed[i]} ${listed[i + 1]}`);
		return changes;
	});
}

/**
 * Whether the worktree is exactly as it was made from its baseline: its HEAD and index the baseline's, and its files
 * the baseline's working files, none added, ignored ones included. Anything Git cannot answer counts as a change.
 */
async function worktreeUnchanged({ root, baseline }: IsolatedWorkspace): Promise<boolean> {
	try {
		// Git's own entry for the worktree, found from the repository, never through the worktree's .git file.
		const entry = join(baseline.gitDir, "worktrees", basename(root));
		if (readFileSync(join(entry, "gitdir"), "utf8").trim() !== join(root, ".git")) return false;
		if (readFileSync(join(entry, "HEAD"), "utf8").trim() !== baseline.head) return false;
		const env = (index: string) => gitEnv({ GIT_DIR: baseline.gitDir, GIT_WORK_TREE: root, GIT_INDEX_FILE: index });
		const index = await withScratchIndex(join(entry, "index"), (scratch) => git(root, ["write-tree"], env(scratch)));
		if (index.trim() !== baseline.index) return false;
		// Compared without storing anything: a file the baseline left out, ignored or not, never reaches the repository.
		const filesUnchanged = await withScratchIndex(undefined, async (scratch) => {
			await git(root, ["read-tree", baseline.tree], env(scratch));
			if ((await git(root, ["ls-files", "--others", "--directory", "-z"], env(scratch))) !== "") return false;
			await git(root, ["update-index", "-q", "--refresh"], env(scratch)).catch(() => undefined);
			await git(root, ["diff-files", "--quiet"], env(scratch));
			return true;
		});
		return filesUnchanged && baselineKept(baseline);
	} catch {
		return false;
	}
}

/** Whether the baseline's ref still holds it, so a worktree can be made from it again. */
function baselineKept(baseline: RunBaseline): boolean {
	try {
		return gitSync(baseline.source, ["rev-parse", "--verify", "-q", baseline.ref]) === baseline.commit;
	} catch {
		return false;
	}
}

/**
 * Why a run's worktree was removed, stored in its run's directory before removing it. While it is there, whatever is
 * left at the worktree's path is not the run's workspace: its removal may not have finished, or a restoration.
 */
export interface WorktreeRemoval {
	/** Whether it held nothing but its baseline, which a Resume makes it from again. */
	restorable: boolean;
	/** What it had changed since its baseline, as Git saw it. */
	changes: string[];
	/** Set when its run never started in it. */
	neverStarted?: true;
}

/** The changes of a worktree Git lists none of: files it ignores, its index or HEAD, or a worktree gone already. */
export const UNLISTED = "none Git lists among its files";

const removalPath = (runDir: string) => join(runDir, "workspace-removed.json");

function readWorktreeRemoval(runDir: string): WorktreeRemoval | undefined {
	try {
		return JSON.parse(readFileSync(removalPath(runDir), "utf8")) as WorktreeRemoval;
	} catch {
		return undefined;
	}
}

/** Whether the run's own worktree is there, no removal of it recorded. */
export function worktreeInPlace(workspace: IsolatedWorkspace, runDir: string): boolean {
	return existsSync(workspace.root) && !readWorktreeRemoval(runDir);
}

/** Removes the worktree, its removal recorded first. */
function removeRecorded(workspace: IsolatedWorkspace, owner: WorktreeOwner, removal: WorktreeRemoval): void {
	assertOwned(workspace.root, owner);
	writeAtomicPrivateFile(removalPath(owner.runDir), JSON.stringify(removal, null, 2));
	removeWorktree(workspace, owner);
}

/**
 * Removes the worktree of a run that ended, if it holds exactly its baseline and that baseline is still kept: a
 * Resume makes it again, as it was. Any other is kept for its user to clean up.
 */
export async function releaseUnchangedWorktree(workspace: IsolatedWorkspace, owner: WorktreeOwner): Promise<void> {
	if (!existsSync(workspace.root) || !(await worktreeUnchanged(workspace))) return;
	try {
		removeRecorded(workspace, owner, { restorable: true, changes: [] });
	} catch {
		// Kept, or recorded as removed: a Resume then makes it again in full.
	}
}

/**
 * Removes a run's worktree at its user's request. One that held changes cannot be made again, so its baseline goes
 * with it; one that held none can, from its baseline, which is kept. The run's sessions and Reports stay. `busy` says
 * why the run may not lose its worktree now, if it may not.
 */
export async function cleanWorktree(
	workspace: IsolatedWorkspace,
	owner: WorktreeOwner,
	busy: () => string | undefined,
): Promise<WorktreeRemoval> {
	const recorded = readWorktreeRemoval(owner.runDir);
	const removal = recorded ?? {
		restorable: await worktreeUnchanged(workspace),
		changes: await worktreeChanges(workspace).catch(() => []),
	};
	// Asked again with nothing awaited before the removal: a Resume may have started meanwhile.
	const why = busy();
	if (why) throw new Error(why);
	removeRecorded(workspace, owner, removal);
	if (!removal.restorable) dropRunBaseline(workspace.baseline);
	return removal;
}

/**
 * Makes sure the worktree of a run about to resume is its own, exactly: the one it left, or, when it was removed
 * holding only its baseline, the baseline made again. Never anything newer. Says why not when it cannot.
 */
export async function restoreWorktree(workspace: IsolatedWorkspace, owner: WorktreeOwner): Promise<string | undefined> {
	const { root, baseline } = workspace;
	const removal = readWorktreeRemoval(owner.runDir);
	if (!removal) {
		return existsSync(root)
			? undefined
			: `its worktree ${root} is gone, removed outside bluclawd, with whatever it held`;
	}
	if (!removal.restorable) {
		return `its worktree ${root} was removed at the user's request, with its changes since its baseline (${listChanges(removal.changes, UNLISTED)}), which cannot be made again`;
	}
	if (!baselineKept(baseline)) return `its worktree ${root} was removed, and its baseline ${baseline.ref} is gone too`;
	try {
		removeWorktree(workspace, owner);
		await materializeWorktree(workspace);
	} catch (error) {
		return `its worktree ${root} could not be made again from its baseline (${error instanceof Error ? error.message : String(error)})`;
	}
	rmSync(removalPath(owner.runDir), { force: true });
	return undefined;
}

/** Changes as a Report lists them: at most fifty, the rest counted. */
export function listChanges(all: string[], none: string): string {
	const listed = all.slice(0, MAX_LISTED_CHANGES).join(", ");
	const more = all.length - MAX_LISTED_CHANGES;
	return all.length === 0 ? none : more > 0 ? `${listed}, and ${more} more` : listed;
}

/** The lines of a run's Report that say where it worked, from what, and what it changed there. */
export async function describeWorkspace(workspace: IsolatedWorkspace, runDir: string): Promise<string[]> {
	const { root, baseline } = workspace;
	const removal = readWorktreeRemoval(runDir);
	let where: string;
	let changes: string;
	if (removal?.neverStarted) {
		where = "removed: the run never started in it.";
		changes = "none";
	} else if (removal) {
		where = removal.restorable
			? "removed: it held no change since its baseline, from which a Resume makes it again."
			: "removed at the user's request with the changes below, which are lost: the run cannot be resumed.";
		changes = listChanges(removal.changes, removal.restorable ? "none" : UNLISTED);
	} else if (!existsSync(root)) {
		where = "gone, removed outside bluclawd: the run cannot be resumed.";
		changes = "unknown";
	} else {
		where = "an isolated Git worktree; what the run changed there is not in your checkout.";
		try {
			changes = listChanges(await worktreeChanges(workspace), "none");
		} catch (error) {
			changes = `unknown, Git could not compare them (${error instanceof Error ? error.message : String(error)})`;
		}
	}
	return [
		`Workspace: ${root}, ${where}`,
		`Baseline: ${baseline.commit} (${baseline.ref}): HEAD ${baseline.head} of ${baseline.source} with the staged, unstaged and untracked changes it had at the run's Admission.`,
		`Changes since its baseline: ${changes}`,
	];
}

/** What a run in a worktree is told of it, besides its role's instructions: one that only reads works in its chain's. */
export function workspaceInstructions({ root, baseline }: IsolatedWorkspace, writes = true, shell = false): string {
	if (!writes) {
		return [
			"",
			"## Your workspace",
			`You read an isolated Git worktree, ${root}: a copy of your orchestrator's checkout ${baseline.source} as it was when your chain was admitted, its uncommitted changes included and its ignored files left out, with the changes of the steps before you. You cannot change files. Later changes in its checkout do not reach you.`,
		].join("\n");
	}
	return [
		"",
		"## Your workspace",
		`You work in an isolated Git worktree, ${root}: a copy of your orchestrator's checkout ${baseline.source} as it was when you were admitted, its uncommitted changes included and its ignored files left out. You may change files only inside it, never its .git. Your changes stay there for your orchestrator to review; later changes in its checkout do not reach you.`,
		shell
			? "Your commands run in a sandbox of this run: they write only in the worktree and in $TMPDIR, cannot commit or change other Git state, reach a host only once the user allows it, and every process a command starts ends with it, so start nothing to outlive a command."
			: "You have no shell.",
	].join("\n");
}

/** Where the worktrees of runs are kept: one per run, named after it. */
export function worktreePath(agentDir: string, runId: string): string {
	return join(realpathSync(agentDir), "bluclawd", "worktrees", runId);
}
