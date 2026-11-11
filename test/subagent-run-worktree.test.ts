import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	captureRunBaseline,
	cleanWorktree,
	describeWorkspace,
	discardWorktree,
	type IsolatedWorkspace,
	materializeWorktree,
	releaseUnchangedWorktree,
	restoreWorktree,
	worktreeInPlace,
	worktreePath,
} from "../ext/subagents/run-worktree.ts";

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync(
		"git",
		["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8" },
	);
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout;
}

/** The edge cases of a run's baseline that a whole run would cost too much to reach. */
describe("an isolated run's baseline", () => {
	let dir: string;
	let repo: string;
	beforeEach(() => {
		vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		dir = realpathSync(mkdtempSync(join(tmpdir(), "bluclawd-baseline-test-")));
		repo = join(dir, "repo");
		mkdirSync(repo);
		writeFileSync(join(repo, "a.txt"), "one\n");
		writeFileSync(join(repo, ".gitignore"), "build/\n");
		git(repo, "init", "-q", "-b", "main");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "start");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const refs = () => git(repo, "for-each-ref", "refs/bluclawd");

	it("is refused while the checkout has unresolved conflicts, recording nothing", () => {
		git(repo, "checkout", "-q", "-b", "other");
		writeFileSync(join(repo, "a.txt"), "other\n");
		git(repo, "commit", "-q", "-am", "other");
		git(repo, "checkout", "-q", "main");
		writeFileSync(join(repo, "a.txt"), "main\n");
		git(repo, "commit", "-q", "-am", "main");
		spawnSync("git", ["merge", "-q", "other"], { cwd: repo });

		const captured = captureRunBaseline(repo, "sub_conflict");
		expect(captured).toMatchObject({ ok: false, error: expect.stringContaining("Git could not record the state") });
		expect(refs()).toBe("");
		expect(git(repo, "status", "--porcelain")).toBe("UU a.txt\n");
	});

	it("is refused for a directory it does not hold: an ignored one", () => {
		mkdirSync(join(repo, "build"));
		writeFileSync(join(repo, "build", "out.txt"), "built\n");

		expect(captureRunBaseline(join(repo, "build"), "sub_ignored")).toMatchObject({
			ok: false,
			error: expect.stringContaining("is not a directory of the state recorded"),
		});
		expect(refs()).toBe("");
	});

	it("is never made over a directory already there, and lists at most fifty changes in a Report", async () => {
		const captured = captureRunBaseline(repo, "sub_many");
		if (!captured.ok) throw new Error(captured.error);
		const taken = join(dir, "taken");
		mkdirSync(taken);
		writeFileSync(join(taken, "mine.txt"), "mine\n");
		await expect(materializeWorktree({ root: taken, baseline: captured.baseline })).rejects.toThrow();

		const workspace = { root: join(dir, "worktree"), baseline: captured.baseline };
		await materializeWorktree(workspace);
		for (let i = 0; i < 60; i++) writeFileSync(join(workspace.root, `n${String(i).padStart(2, "0")}.txt`), "n\n");
		const lines = await describeWorkspace(workspace, dir);
		expect(lines.at(-1)).toMatch(/^Changes since its baseline: A n00\.txt, .*A n49\.txt, and 10 more$/);
	});
});

/** The edge cases of keeping, removing and restoring a run's worktree that a whole run would cost too much to reach. */
describe("a run's worktree once the run ended", () => {
	let dir: string;
	let repo: string;
	let made: { workspace: IsolatedWorkspace; owner: { agentDir: string; runId: string; runDir: string } };
	beforeEach(async () => {
		vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		dir = realpathSync(mkdtempSync(join(tmpdir(), "bluclawd-retention-test-")));
		repo = join(dir, "repo");
		mkdirSync(repo);
		writeFileSync(join(repo, "a.txt"), "one\n");
		git(repo, "init", "-q", "-b", "main");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "start");
		writeFileSync(join(repo, "a.txt"), "one local\n");
		const runId = "sub_kept";
		const captured = captureRunBaseline(repo, runId);
		if (!captured.ok) throw new Error(captured.error);
		const agentDir = join(dir, "agent");
		const runDir = join(dir, "run");
		mkdirSync(runDir);
		mkdirSync(agentDir);
		made = {
			workspace: { root: worktreePath(agentDir, runId), baseline: captured.baseline },
			owner: { agentDir, runId, runDir },
		};
		await materializeWorktree(made.workspace);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const worktrees = () => git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length ?? 0;

	it("is kept holding a file its baseline left out, which never reaches the repository", async () => {
		const { workspace, owner } = made;
		writeFileSync(join(workspace.root, "out.log"), "only-in-the-worktree\n");
		const blob = git(repo, "hash-object", join(workspace.root, "out.log")).trim();
		await releaseUnchangedWorktree(workspace, owner);
		expect(existsSync(join(workspace.root, "out.log"))).toBe(true);
		const stored = spawnSync("git", ["cat-file", "-e", blob], { cwd: repo });
		expect(stored.status).not.toBe(0);
	});

	it("is not cleaned up once its run started again, and a run that never started says so", async () => {
		const { workspace, owner } = made;
		await expect(cleanWorktree(workspace, owner, () => "it runs again")).rejects.toThrow("it runs again");
		expect(existsSync(workspace.root)).toBe(true);
		expect(worktreeInPlace(workspace, owner.runDir)).toBe(true);

		discardWorktree(workspace, owner);
		expect(worktrees()).toBe(1);
		expect(git(repo, "for-each-ref", "refs/bluclawd")).toBe("");
		expect((await describeWorkspace(workspace, owner.runDir))[0]).toBe(
			`Workspace: ${workspace.root}, removed: the run never started in it.`,
		);
	});

	it("is kept when what changed is its index or HEAD, not its files", async () => {
		const { workspace, owner } = made;
		git(workspace.root, "add", "a.txt");
		await releaseUnchangedWorktree(workspace, owner);
		expect(existsSync(workspace.root)).toBe(true);

		git(workspace.root, "read-tree", workspace.baseline.index);
		git(workspace.root, "commit", "-q", "--allow-empty", "-m", "run");
		await releaseUnchangedWorktree(workspace, owner);
		expect(existsSync(workspace.root)).toBe(true);
	});

	it("is not trusted while its removal is recorded: a Resume replaces what is left there with its baseline", async () => {
		const { workspace, owner } = made;
		await releaseUnchangedWorktree(workspace, owner);
		expect(existsSync(workspace.root)).toBe(false);
		expect(worktrees()).toBe(1);
		// As a removal that did not finish, or a restoration, would leave it.
		mkdirSync(workspace.root);
		writeFileSync(join(workspace.root, "a.txt"), "half\n");

		expect(await restoreWorktree(workspace, owner)).toBeUndefined();
		expect(readFileSync(join(workspace.root, "a.txt"), "utf8")).toBe("one local\n");
		expect(git(workspace.root, "rev-parse", "HEAD").trim()).toBe(workspace.baseline.head);
		expect(worktrees()).toBe(2);
		// Restored, it is the run's own again: what it holds counts.
		writeFileSync(join(workspace.root, "b.txt"), "b\n");
		expect(await restoreWorktree(workspace, owner)).toBeUndefined();
		expect(existsSync(join(workspace.root, "b.txt"))).toBe(true);
	});

	it("is never made again when it was removed outside bluclawd", async () => {
		const { workspace, owner } = made;
		rmSync(workspace.root, { recursive: true });
		expect(await restoreWorktree(workspace, owner)).toMatch(/is gone, removed outside bluclawd/);
		expect(existsSync(workspace.root)).toBe(false);
		expect(await describeWorkspace(workspace, owner.runDir)).toContain(
			`Workspace: ${workspace.root}, gone, removed outside bluclawd: the run cannot be resumed.`,
		);

		// Cleaning up what is already gone still lets go of Git's entry for it, and of its baseline.
		expect(await cleanWorktree(workspace, owner, () => undefined)).toEqual({ restorable: false, changes: [] });
		expect(worktrees()).toBe(1);
		expect(git(repo, "for-each-ref", "refs/bluclawd")).toBe("");
		expect(await restoreWorktree(workspace, owner)).toMatch(/removed at the user's request/);
	});

	it("is not made again once its baseline's ref is gone", async () => {
		const { workspace, owner } = made;
		await releaseUnchangedWorktree(workspace, owner);
		git(repo, "update-ref", "-d", workspace.baseline.ref);
		expect(await restoreWorktree(workspace, owner)).toMatch(
			/its baseline refs\/bluclawd\/runs\/sub_kept\/baseline is gone/,
		);
		expect(existsSync(workspace.root)).toBe(false);
	});
});
