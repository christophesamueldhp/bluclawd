import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureRunBaseline, describeWorkspace, materializeWorktree } from "../ext/subagents/run-worktree.ts";

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
		const lines = await describeWorkspace(workspace);
		expect(lines.at(-1)).toMatch(/^Changes since its baseline: A n00\.txt, .*A n49\.txt, and 10 more$/);
	});
});
