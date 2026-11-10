/**
 * The isolated Git worktree a run that edits works in (ADR-0010). Its baseline is its orchestrator's checkout as it was
 * at the run's Admission: HEAD, the staged changes and the working files, untracked ones included, ignored ones not.
 * Capturing it touches nothing of the user's: Git records it from a copy of the index, as commits no branch holds,
 * kept by a private ref, `refs/bluclawd/runs/<run>/baseline`. The worktree is made from that, however long the run
 * waited for its turn: HEAD the checkout's, index its staged state, files its working state.
 */
import { execFile, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

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

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
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

function gitSync(cwd: string, args: string[], env = gitEnv()): string {
	const result = spawnSync("git", gitArgs(args), { cwd, env, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
	if (result.status !== 0) {
		throw new Error((result.stderr || result.error?.message || `git ${args[0]} failed`).trim().split("\n")[0]);
	}
	return result.stdout.trim();
}

function git(cwd: string, args: string[], env = gitEnv()): Promise<string> {
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
function withScratchIndex<T>(from: string | undefined, use: (index: string) => T): T {
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

/** The lines of a run's Report that say where it worked, from what, and what it changed there. */
export async function describeWorkspace(workspace: IsolatedWorkspace): Promise<string[]> {
	const { root, baseline } = workspace;
	let changes: string;
	try {
		const all = await worktreeChanges(workspace);
		const listed = all.slice(0, MAX_LISTED_CHANGES).join(", ");
		const more = all.length - MAX_LISTED_CHANGES;
		changes = all.length === 0 ? "none" : more > 0 ? `${listed}, and ${more} more` : listed;
	} catch (error) {
		changes = `unknown, Git could not compare them (${error instanceof Error ? error.message : String(error)})`;
	}
	return [
		`Workspace: ${root}, an isolated Git worktree; what the run changed there is not in your checkout.`,
		`Baseline: ${baseline.commit} (${baseline.ref}): HEAD ${baseline.head} of ${baseline.source} with the staged, unstaged and untracked changes it had at the run's Admission.`,
		`Changes since its baseline: ${changes}`,
	];
}

/** What a run that edits is told of its workspace, besides its role's instructions. */
export function workspaceInstructions({ root, baseline }: IsolatedWorkspace): string {
	return [
		"",
		"## Your workspace",
		`You work in an isolated Git worktree, ${root}: a copy of your orchestrator's checkout ${baseline.source} as it was when you were admitted, its uncommitted changes included and its ignored files left out. You may change files only inside it, never its .git, and you have no shell. Your changes stay there for your orchestrator to review; later changes in its checkout do not reach you.`,
	].join("\n");
}

/** Where the worktrees of runs are kept: one per run, named after it. */
export function worktreePath(agentDir: string, runId: string): string {
	return join(realpathSync(agentDir), "bluclawd", "worktrees", runId);
}
