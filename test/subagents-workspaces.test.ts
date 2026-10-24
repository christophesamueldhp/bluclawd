import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureCheckpoint } from "../ext/checkpoints/index.ts";
import { createIsolatedSubagentPolicySnapshot } from "../ext/subagents/execution-policy.ts";
import { captureSourceSnapshot, captureWorkspaceTree } from "../ext/subagents/source-snapshot.ts";
import { createIsolatedWorkspace, createSafeGitExec, resolveRepositoryIdentity } from "../ext/subagents/workspace.ts";
import { createSubagentFixture } from "./helpers/subagent-fixture.ts";

const fixtures: Awaited<ReturnType<typeof createSubagentFixture>>[] = [];
afterEach(async () => {
	for (const f of fixtures.splice(0)) await f.cleanup();
});
async function setup(nested = false) {
	const f = await createSubagentFixture();
	fixtures.push(f);
	const cwd = nested ? join(f.parentCwd, "src", "nested") : f.parentCwd;
	await mkdir(cwd, { recursive: true });
	const policy = createIsolatedSubagentPolicySnapshot({ cwd, denyRules: [], allowedTools: ["read", "bash"] })
		.snapshot!;
	await f.git("remote", "add", "origin", "https://example.invalid/private");
	const source = await captureSourceSnapshot({
		agentDir: f.stateDir,
		parentSessionId: "parent",
		runtimeGeneration: 1,
		policy,
		exec: f.exec,
		signal: new AbortController().signal,
		isCurrent: () => true,
	});
	const create = async () => {
		const runId = `sub_${randomUUID()}`;
		const workspace = await createIsolatedWorkspace({
			runId,
			runDir: join(f.stateDir, "bluclawd", "subagents", "parent", runId),
			source,
			exec: f.exec,
			signal: new AbortController().signal,
			isCurrent: () => true,
		});
		f.scratchDirs.push(workspace.scratchDir);
		return workspace;
	};
	return { f, source, policy, create, cwd };
}

describe("independent per-run materialization", () => {
	it("preserves nested cwd and uses a standalone repository with no parent history/remotes", async () => {
		const { f, source, create } = await setup(true);
		const workspace = await create();
		expect(relative(workspace.root, workspace.executionCwd)).toBe("src/nested");
		expect(workspace.gitDir).toBe(join(workspace.root, ".git"));
		const runGit = (...args: string[]) => f.exec("git", args, { cwd: workspace.executionCwd });
		expect((await runGit("rev-parse", "--show-toplevel")).stdout.trim()).toBe(workspace.root);
		expect((await runGit("rev-list", "--count", "HEAD")).stdout.trim()).toBe("1");
		expect((await runGit("remote", "-v")).stdout).toBe("");
		expect((await runGit("cat-file", "-e", source.sourceHead)).code).not.toBe(0);
		await expect(stat(join(workspace.gitDir, "objects", "info", "alternates"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("materializes exact dirty/staged/deleted/new and binary bytes without sharing writable inodes", async () => {
		const { f } = await setup();
		await writeFile(join(f.parentCwd, "tracked.txt"), "staged change\nsecond base\n");
		await f.git("add", "tracked.txt");
		await writeFile(join(f.parentCwd, "tracked.txt"), "staged change\nunstaged change\n");
		const binary = Buffer.from([0, 255, 128, 10, 13, 0]);
		await writeFile(join(f.parentCwd, "binary.bin"), binary);
		await f.git("add", "binary.bin");
		await writeFile(join(f.parentCwd, "crlf.txt"), "line\r\n");
		await f.git("rm", "-q", ".gitignore");
		const policy = createIsolatedSubagentPolicySnapshot({ cwd: f.parentCwd, denyRules: [], allowedTools: ["write"] })
			.snapshot!;
		const source = await captureSourceSnapshot({
			agentDir: f.stateDir,
			parentSessionId: "parent",
			runtimeGeneration: 1,
			policy,
			exec: f.exec,
			signal: new AbortController().signal,
			isCurrent: () => true,
		});
		const runId = `sub_${randomUUID()}`;
		const workspace = await createIsolatedWorkspace({
			runId,
			runDir: join(f.stateDir, "bluclawd", "subagents", "parent", runId),
			source,
			exec: f.exec,
			signal: new AbortController().signal,
			isCurrent: () => true,
		});
		f.scratchDirs.push(workspace.scratchDir);
		expect(await readFile(join(workspace.root, "binary.bin"))).toEqual(binary);
		expect(await readFile(join(workspace.root, "crlf.txt"), "utf8")).toBe("line\r\n");
		await expect(stat(join(workspace.root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
		const cached = await f.exec("git", ["diff", "--cached"], { cwd: workspace.root });
		const working = await f.exec("git", ["diff"], { cwd: workspace.root });
		expect(cached.stdout).toContain("+staged change");
		expect(working.stdout).toContain("+unstaged change");
		expect((await stat(join(workspace.root, "tracked.txt"))).ino).not.toBe(
			(await stat(join(f.parentCwd, "tracked.txt"))).ino,
		);
		const privateIndex = await readFile(join(workspace.gitDir, "index"));
		expect(
			await captureWorkspaceTree({ workspace, policy, exec: f.exec, signal: new AbortController().signal }),
		).toBe(source.worktreeTree);
		expect(await readFile(join(workspace.gitDir, "index"))).toEqual(privateIndex);
	});

	it("does not treat baseline untracked files as deleted when the agent changes ignore rules", async () => {
		const { f, policy } = await setup();
		await writeFile(join(f.parentCwd, "input.txt"), "existing untracked input\n");
		const source = await captureSourceSnapshot({
			agentDir: f.stateDir,
			parentSessionId: "parent",
			runtimeGeneration: 1,
			policy,
			exec: f.exec,
			signal: new AbortController().signal,
			isCurrent: () => true,
		});
		const runId = `sub_${randomUUID()}`;
		const workspace = await createIsolatedWorkspace({
			runId,
			runDir: join(f.stateDir, "bluclawd", "subagents", "parent", runId),
			source,
			exec: f.exec,
			signal: new AbortController().signal,
			isCurrent: () => true,
		});
		f.scratchDirs.push(workspace.scratchDir);
		await writeFile(join(workspace.root, ".gitignore"), "input.txt\n*.cache\n");
		const tree = await captureWorkspaceTree({
			workspace,
			policy,
			exec: f.exec,
			signal: new AbortController().signal,
		});
		const file = await f.exec("git", ["show", `${tree}:input.txt`], { cwd: workspace.root });
		expect(file.code).toBe(0);
		expect(file.stdout).toBe("existing untracked input\n");
	});

	it("keeps same-role invocations and their scratch independent while pinning the chosen view", async () => {
		const { f, create } = await setup();
		await writeFile(join(f.parentCwd, "tracked.txt"), "later parent edit\n");
		const [first, second] = await Promise.all([create(), create()]);
		await writeFile(join(first.root, "tracked.txt"), "first agent\n");
		expect(await readFile(join(second.root, "tracked.txt"), "utf8")).toBe("base line\nsecond base\n");
		expect(await readFile(join(f.parentCwd, "tracked.txt"), "utf8")).toBe("later parent edit\n");
		expect(first.scratchDir).not.toBe(second.scratchDir);
		if (process.platform !== "win32") expect((await stat(first.scratchDir)).mode & 0o777).toBe(0o700);
	});

	it("provides private scratch with enough pathname space for real Unix sockets", async () => {
		const { create } = await setup();
		const workspace = await create();
		const server = createServer();
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(join(workspace.scratchDir, `srt-mux-${randomUUID()}.sock`), resolve);
			});
			expect(server.listening).toBe(true);
		} finally {
			if (server.listening)
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	it("refuses stale/aborted setup, arbitrary run directories and repeated workspace reuse", async () => {
		const { f, source, create } = await setup();
		const args = {
			runId: `sub_${randomUUID()}`,
			runDir: f.parentCwd,
			source,
			exec: f.exec,
			signal: new AbortController().signal,
			isCurrent: () => true,
		};
		await expect(createIsolatedWorkspace(args)).rejects.toThrow(/storage|directory|path/i);
		const workspace = await create();
		await expect(
			createIsolatedWorkspace({ ...args, runId: workspace.runId, runDir: join(workspace.root, "..") }),
		).rejects.toThrow();
		await expect(createIsolatedWorkspace({ ...args, signal: AbortSignal.abort() })).rejects.toThrow();
		await expect(createIsolatedWorkspace({ ...args, isCurrent: () => false })).rejects.toThrow();
	});

	it("keeps safe Git cwd/env semantics compatible with nested checkpoint capture", async () => {
		const { f, cwd } = await setup(true);
		await writeFile(join(cwd, "new.txt"), "checkpoint data\n");
		const index = await readFile(join(f.parentCwd, ".git", "index"));
		const repository = await resolveRepositoryIdentity(cwd, f.exec);
		const exec = createSafeGitExec(f.exec, repository);
		const sha = await captureCheckpoint(cwd, exec, "fixture");
		expect(sha).toMatch(/^[a-f0-9]{40,64}$/);
		expect(await f.git("show", `${sha}:src/nested/new.txt`)).toBe("checkpoint data\n");
		expect(await readFile(join(f.parentCwd, ".git", "index"))).toEqual(index);
		await expect(exec("env", ["GIT_DIR=/other", "git", "status"])).rejects.toThrow(/unsafe|environment/i);
		await expect(exec("git", ["status"], { cwd: f.root })).rejects.toThrow(/outside|cwd/i);
	});
});
