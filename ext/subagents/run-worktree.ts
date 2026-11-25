import { execFile, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { subagentRunDir, writeAtomicPrivateFile } from "./storage.ts";

export interface RunBaseline {
	source: string;
	gitDir: string;
	head: string;
	index: string;
	tree: string;
	commit: string;
	ref: string;
}

export interface IsolatedWorkspace {
	root: string;
	baseline: RunBaseline;
}

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

export const withoutUserHooks = (args: string[]) => ["-c", "core.hooksPath=/dev/null", ...args];

export function gitSync(cwd: string, args: string[], env = gitEnv()): string {
	const result = spawnSync("git", withoutUserHooks(args), { cwd, env, encoding: "utf8", timeout: GIT_TIMEOUT_MS });
	if (result.status !== 0) {
		throw new Error((result.stderr || result.error?.message || `git ${args[0]} failed`).trim().split("\n")[0]);
	}
	return result.stdout.trim();
}

export function git(cwd: string, args: string[], env = gitEnv()): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			withoutUserHooks(args),
			{ cwd, env, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) reject(new Error((stderr || error.message).trim().split("\n")[0]));
				else resolve(stdout);
			},
		);
	});
}

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
		// The user's own index is only copied, because even write-tree may rewrite the one it reads.
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

export function dropRunBaseline(baseline: RunBaseline): void {
	try {
		gitSync(baseline.source, ["update-ref", "-d", baseline.ref]);
	} catch {}
}

export interface WorktreeOwner {
	agentDir: string;
	runId: string;
	runDir: string;
}

export function worktreeOwner(workspace: IsolatedWorkspace, agentDir: string, parentSessionId: string): WorktreeOwner {
	const runId = basename(workspace.root);
	return { agentDir, runId, runDir: subagentRunDir(agentDir, parentSessionId, runId) };
}

function removeWorktree({ root, baseline }: IsolatedWorkspace, owner: WorktreeOwner): void {
	assertOwned(root, owner);
	const remove = () => gitSync(baseline.source, ["worktree", "remove", "--force", "--force", root]);
	const removeLeftoverAtOwnedPath = () => rmSync(root, { recursive: true, force: true });
	try {
		remove();
	} catch {
		if (!existsSync(root)) return;
		removeLeftoverAtOwnedPath();
		try {
			remove();
		} catch {}
	}
}

function assertOwned(root: string, owner: WorktreeOwner): void {
	if (root !== worktreePath(owner.agentDir, owner.runId)) {
		throw new Error(`${root} is not the worktree of run ${owner.runId}`);
	}
}

export function discardWorktree(workspace: IsolatedWorkspace, owner: WorktreeOwner): void {
	try {
		removeRecorded(workspace, owner, { restorable: false, changes: [], neverStarted: true });
	} catch {
		return;
	}
	dropRunBaseline(workspace.baseline);
}

export async function materializeWorktree({ root, baseline }: IsolatedWorkspace): Promise<void> {
	mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
	await git(baseline.source, ["worktree", "add", "--detach", "--no-checkout", root, baseline.head]);
	await git(root, ["read-tree", "--reset", "-u", baseline.tree]);
	await git(root, ["read-tree", baseline.index]);
}

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

async function worktreeUnchanged({ root, baseline }: IsolatedWorkspace): Promise<boolean> {
	try {
		const gitsOwnWorktreeEntry = join(baseline.gitDir, "worktrees", basename(root));
		if (readFileSync(join(gitsOwnWorktreeEntry, "gitdir"), "utf8").trim() !== join(root, ".git")) return false;
		if (readFileSync(join(gitsOwnWorktreeEntry, "HEAD"), "utf8").trim() !== baseline.head) return false;
		const env = (index: string) => gitEnv({ GIT_DIR: baseline.gitDir, GIT_WORK_TREE: root, GIT_INDEX_FILE: index });
		const index = await withScratchIndex(join(gitsOwnWorktreeEntry, "index"), (scratch) =>
			git(root, ["write-tree"], env(scratch)),
		);
		if (index.trim() !== baseline.index) return false;
		const filesUnchangedWithoutStoring = await withScratchIndex(undefined, async (scratch) => {
			await git(root, ["read-tree", baseline.tree], env(scratch));
			if ((await git(root, ["ls-files", "--others", "--directory", "-z"], env(scratch))) !== "") return false;
			await git(root, ["update-index", "-q", "--refresh"], env(scratch)).catch(() => undefined);
			await git(root, ["diff-files", "--quiet"], env(scratch));
			return true;
		});
		return filesUnchangedWithoutStoring && baselineKept(baseline);
	} catch {
		return false;
	}
}

function baselineKept(baseline: RunBaseline): boolean {
	try {
		return gitSync(baseline.source, ["rev-parse", "--verify", "-q", baseline.ref]) === baseline.commit;
	} catch {
		return false;
	}
}

export interface WorktreeRemoval {
	restorable: boolean;
	changes: string[];
	neverStarted?: true;
}

export const UNLISTED = "none Git lists among its files";

const removalPath = (runDir: string) => join(runDir, "workspace-removed.json");

function readWorktreeRemoval(runDir: string): WorktreeRemoval | undefined {
	try {
		return JSON.parse(readFileSync(removalPath(runDir), "utf8")) as WorktreeRemoval;
	} catch {
		return undefined;
	}
}

export function worktreeInPlace(workspace: IsolatedWorkspace, runDir: string): boolean {
	return existsSync(workspace.root) && !readWorktreeRemoval(runDir);
}

function removeRecorded(workspace: IsolatedWorkspace, owner: WorktreeOwner, removal: WorktreeRemoval): void {
	assertOwned(workspace.root, owner);
	writeAtomicPrivateFile(removalPath(owner.runDir), JSON.stringify(removal, null, 2));
	removeWorktree(workspace, owner);
}

export async function releaseUnchangedWorktree(workspace: IsolatedWorkspace, owner: WorktreeOwner): Promise<void> {
	if (!existsSync(workspace.root) || !(await worktreeUnchanged(workspace))) return;
	try {
		removeRecorded(workspace, owner, { restorable: true, changes: [] });
	} catch {}
}

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
	const whyBusyAfterAwait = busy();
	if (whyBusyAfterAwait) throw new Error(whyBusyAfterAwait);
	removeRecorded(workspace, owner, removal);
	if (!removal.restorable) dropRunBaseline(workspace.baseline);
	return removal;
}

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

export function listChanges(all: string[], none: string): string {
	const listed = all.slice(0, MAX_LISTED_CHANGES).join(", ");
	const more = all.length - MAX_LISTED_CHANGES;
	return all.length === 0 ? none : more > 0 ? `${listed}, and ${more} more` : listed;
}

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

export function worktreePath(agentDir: string, runId: string): string {
	return join(realpathSync(agentDir), "bluclawd", "worktrees", runId);
}
