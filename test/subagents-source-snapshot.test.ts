import { mkdir, open, readdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIsolatedSubagentPolicySnapshot } from "../ext/subagents/execution-policy.ts";
import { captureSourceSnapshot, readSourceSnapshot } from "../ext/subagents/source-snapshot.ts";
import { createSubagentFixture } from "./helpers/subagent-fixture.ts";

const fixtures: Awaited<ReturnType<typeof createSubagentFixture>>[] = [];
async function fixture() {
	const f = await createSubagentFixture();
	fixtures.push(f);
	return f;
}
afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	for (const f of fixtures.splice(0)) await f.cleanup();
});

function options(f: Awaited<ReturnType<typeof fixture>>, denyRules: string[] = []) {
	return {
		agentDir: f.stateDir,
		parentSessionId: "parent",
		runtimeGeneration: 1,
		policy: createIsolatedSubagentPolicySnapshot({ cwd: f.parentCwd, denyRules, allowedTools: ["read", "bash"] })
			.snapshot!,
		exec: f.exec,
		signal: new AbortController().signal,
		isCurrent: () => true,
	};
}

describe("pinned policy-filtered source snapshots", () => {
	it("records HEAD/index/working views without altering the source index or branch", async () => {
		const f = await fixture();
		await writeFile(join(f.parentCwd, "tracked.txt"), "staged change\nsecond base\n");
		await f.git("add", "tracked.txt");
		await writeFile(join(f.parentCwd, "tracked.txt"), "staged change\nunstaged change\n");
		await writeFile(join(f.parentCwd, "new file\nwith spaces.txt"), "untracked\r\n");
		const beforeIndex = await readFile(join(f.parentCwd, ".git", "index"));
		const beforeHead = await f.git("rev-parse", "HEAD");
		const source = await captureSourceSnapshot(options(f));
		const blob = async (tree: string, path: string) => {
			const result = await f.exec("git", ["show", `${tree}:${path}`], { cwd: source.repoDir });
			expect(result.code).toBe(0);
			return result.stdout;
		};
		expect(await blob(source.baseTree, "tracked.txt")).toBe("base line\nsecond base\n");
		expect(await blob(source.indexTree, "tracked.txt")).toBe("staged change\nsecond base\n");
		expect(await blob(source.worktreeTree, "tracked.txt")).toBe("staged change\nunstaged change\n");
		expect(await blob(source.worktreeTree, "new file\nwith spaces.txt")).toBe("untracked\r\n");
		expect(await readFile(join(f.parentCwd, ".git", "index"))).toEqual(beforeIndex);
		expect(await f.git("rev-parse", "HEAD")).toBe(beforeHead);
		expect(source.sourceHead).toBe(beforeHead.trim());
		expect(readSourceSnapshot(f.stateDir, "parent", source.snapshotId)).toEqual(source);
		if (process.platform !== "win32") {
			expect((await stat(join(source.repoDir, "..", "snapshot.json"))).mode & 0o777).toBe(0o600);
		}
	});

	it("excludes ignored and read-denied bytes from every imported tree and object", async () => {
		const f = await fixture();
		await writeFile(join(f.parentCwd, "private.env"), "SECRET-HEAD");
		await writeFile(join(f.parentCwd, "old.cache"), "IGNORED-HEAD");
		await f.git("add", "-f", "private.env", "old.cache");
		await f.git("commit", "-qm", "Sensitive fixture");
		const secretOid = (await f.git("rev-parse", "HEAD:private.env")).trim();
		await f.git("rm", "-q", "old.cache");
		await mkdir(join(f.parentCwd, "ignored"));
		await writeFile(join(f.parentCwd, "ignored", "credential"), "IGNORED-WORKING");
		await writeFile(join(f.parentCwd, "private.env"), "SECRET-WORKING");
		const source = await captureSourceSnapshot(options(f, ["Read(**/*.env)"]));
		for (const tree of [source.baseTree, source.indexTree, source.worktreeTree]) {
			const result = await f.exec("git", ["ls-tree", "-r", "--name-only", tree], { cwd: source.repoDir });
			expect(result.stdout).toBe(".gitignore\ntracked.txt\n");
		}
		expect((await f.exec("git", ["cat-file", "-e", secretOid], { cwd: source.repoDir })).code).not.toBe(0);
		expect((await f.exec("git", ["cat-file", "-e", source.sourceHead], { cwd: source.repoDir })).code).not.toBe(0);
	});

	it("honors an explicitly configured source exclude file without copying configuration", async () => {
		const f = await fixture();
		const exclude = join(f.root, "global-ignore");
		await writeFile(exclude, "local-secret\n");
		await f.git("config", "core.excludesFile", exclude);
		await writeFile(join(f.parentCwd, "local-secret"), "excluded credential");
		const source = await captureSourceSnapshot(options(f));
		const names = await f.exec("git", ["ls-tree", "-r", "--name-only", source.worktreeTree], { cwd: source.repoDir });
		expect(names.stdout).toBe(".gitignore\ntracked.txt\n");
		const config = await readFile(join(source.repoDir, "config"), "utf8");
		expect(config).not.toContain(exclude);
	});

	it("honors system ignore configuration selected by the parent environment", async () => {
		const f = await fixture();
		const exclude = join(f.root, "company-ignore");
		const config = join(f.root, "system-gitconfig");
		await writeFile(exclude, "company-credential\n");
		await writeFile(config, `[core]\n excludesFile = ${exclude}\n`);
		await writeFile(join(f.parentCwd, "company-credential"), "must not be copied");
		vi.stubEnv("GIT_CONFIG_SYSTEM", config);
		const source = await captureSourceSnapshot(options(f));
		const files = await f.exec("git", ["ls-tree", "-r", "--name-only", source.worktreeTree], { cwd: source.repoDir });
		expect(files.stdout).toBe(".gitignore\ntracked.txt\n");
	});

	it("refuses active filters supplied by global attributes without executing them", async () => {
		const f = await fixture();
		const attributes = join(f.root, "attributes");
		const config = join(f.root, "global-gitconfig");
		await writeFile(attributes, "*.txt filter=external\n");
		await writeFile(config, `[core]\n attributesFile = ${attributes}\n`);
		vi.stubEnv("GIT_CONFIG_GLOBAL", config);
		await expect(captureSourceSnapshot(options(f))).rejects.toThrow(/filter/i);
	});

	it("captures many files without spawning a Git process for each blob", async () => {
		const f = await fixture();
		await mkdir(join(f.parentCwd, "many"));
		for (let n = 0; n < 96; n++) await writeFile(join(f.parentCwd, "many", `file-${n}.txt`), `data ${n}\n`);
		await f.git("add", "many");
		await f.git("commit", "-qm", "Many files");
		let processes = 0;
		const args = options(f);
		args.exec = async (...input) => {
			if (++processes > 100) throw new Error("Snapshot exceeded a bounded process budget");
			return f.exec(...input);
		};
		const source = await captureSourceSnapshot(args);
		const result = await f.exec("git", ["show", `${source.worktreeTree}:many/file-95.txt`], { cwd: source.repoDir });
		expect(result.stdout).toBe("data 95\n");
	});

	it("does not execute fsmonitor, hooks, diff drivers or textconv during preparation", async () => {
		const f = await fixture();
		const marker = join(f.root, "executed");
		const script = join(f.root, "hook");
		await writeFile(script, `#!/bin/sh\necho executed > "${marker}"\n`, { mode: 0o700 });
		for (const key of ["core.fsmonitor", "diff.external", "diff.hostile.textconv"])
			await f.git("config", key, script);
		await f.git("config", "core.hooksPath", f.root);
		const source = await captureSourceSnapshot(options(f));
		expect(source.worktreeTree).toMatch(/^[a-f0-9]{40,64}$/);
		await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["assume-unchanged", "skip-worktree", "intent-to-add", "filter", "symlink", "unmerged"])(
		"refuses unsupported %s state without altering the source",
		async (kind) => {
			const f = await fixture();
			if (kind === "assume-unchanged" || kind === "skip-worktree")
				await f.git("update-index", `--${kind}`, "tracked.txt");
			if (kind === "intent-to-add") {
				await writeFile(join(f.parentCwd, "new.txt"), "new");
				await f.git("add", "-N", "new.txt");
			}
			if (kind === "filter") await writeFile(join(f.parentCwd, ".gitattributes"), "*.txt filter=lfs\n");
			if (kind === "symlink") await symlink(join(f.parentCwd, "tracked.txt"), join(f.parentCwd, "link.txt"));
			if (kind === "unmerged") {
				const oid = (await f.git("rev-parse", "HEAD:tracked.txt")).trim();
				const info = join(f.root, "unmerged-index");
				await writeFile(
					info,
					`0 ${"0".repeat(40)}\ttracked.txt\n100644 ${oid} 1\ttracked.txt\n100644 ${oid} 2\ttracked.txt\n`,
				);
				const result = await f.exec("sh", ["-c", 'git update-index --index-info < "$1"', "fixture", info], {
					cwd: f.parentCwd,
				});
				expect(result.code).toBe(0);
			}
			const before = await readFile(join(f.parentCwd, ".git", "index"));
			await expect(captureSourceSnapshot(options(f))).rejects.toThrow(/unsupported|symlink|filter|index/i);
			expect(await readFile(join(f.parentCwd, ".git", "index"))).toEqual(before);
		},
	);

	it("rejects source mutation across capture rather than publishing mixed views", async () => {
		const f = await fixture();
		let changed = false;
		const args = options(f);
		args.exec = async (...input) => {
			const result = await f.exec(...input);
			if (!changed && input[1].includes("fast-import")) {
				changed = true;
				await writeFile(join(f.parentCwd, "tracked.txt"), "changed during capture\n");
			}
			return result;
		};
		await expect(captureSourceSnapshot(args)).rejects.toThrow(/changed|source/i);
	});

	it("rejects an oversized file before reading or importing its payload", async () => {
		const f = await fixture();
		const file = await open(join(f.parentCwd, "oversized.bin"), "w");
		await file.truncate(64 * 1024 * 1024 + 1);
		await file.close();
		await expect(captureSourceSnapshot(options(f))).rejects.toThrow(/byte limit/i);
	});

	it("rejects aborted, stale and unavailable-storage capture", async () => {
		const f = await fixture();
		await expect(captureSourceSnapshot({ ...options(f), signal: AbortSignal.abort() })).rejects.toThrow();
		await expect(captureSourceSnapshot({ ...options(f), isCurrent: () => false })).rejects.toThrow(
			/owner|session|current/i,
		);
		const file = join(f.root, "not-a-directory");
		await writeFile(file, "occupied");
		await expect(captureSourceSnapshot({ ...options(f), agentDir: file })).rejects.toThrow();
	});

	it("rejects directory symlink substitution before any source snapshot is published", async () => {
		const f = await fixture();
		const directory = join(f.parentCwd, "dir");
		await mkdir(directory);
		await writeFile(join(directory, "input.txt"), "safe input");
		await f.git("add", "dir");
		await f.git("commit", "-qm", "Directory fixture");
		const outside = join(f.root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "input.txt"), "outside credential");
		const args = options(f);
		let replaced = false;
		args.exec = async (...input) => {
			const result = await f.exec(...input);
			if (!replaced && input[1].includes("--debug")) {
				replaced = true;
				await rename(directory, join(f.parentCwd, "dir-original"));
				await symlink(outside, directory);
			}
			return result;
		};
		await expect(captureSourceSnapshot(args)).rejects.toThrow();
		const state = await readdir(join(f.stateDir, "bluclawd", "subagents", "parent", "sources"), { recursive: true });
		expect(state.filter((path) => path.endsWith("snapshot.json"))).toEqual([]);
	});

	it("expires queued preparation within the same thirty-second deadline", async () => {
		const f = await fixture();
		vi.useFakeTimers();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = 0;
		const exec = async (...input: Parameters<typeof f.exec>) => {
			started++;
			await held;
			return f.exec(...input);
		};
		const pending = Array.from({ length: 6 }, () => captureSourceSnapshot({ ...options(f), exec }));
		const completed = Promise.allSettled(pending);
		try {
			await vi.waitFor(() => expect(started).toBe(2));
			await vi.advanceTimersByTimeAsync(30_001);
			expect(started).toBe(2);
		} finally {
			release();
		}
		const outcomes = await completed;
		expect(outcomes.every((result) => result.status === "rejected" && /timed out/i.test(String(result.reason)))).toBe(
			true,
		);
	});

	it("rejects forged storage references and symlinked manifests", async () => {
		const f = await fixture();
		const source = await captureSourceSnapshot(options(f));
		expect(() => readSourceSnapshot(f.stateDir, "../other", source.snapshotId)).toThrow();
		const manifest = join(source.repoDir, "..", "snapshot.json");
		await rename(manifest, `${manifest}.original`);
		await symlink(`${manifest}.original`, manifest);
		expect(() => readSourceSnapshot(f.stateDir, "parent", source.snapshotId)).toThrow(/symlink|storage/i);
	});

	it("bounds two active/four queued preparations and rejects overflow before new Git work", async () => {
		const f = await fixture();
		const ac = new AbortController();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = 0;
		const exec = async (...input: Parameters<typeof f.exec>) => {
			started++;
			await held;
			return f.exec(...input);
		};
		const pending = Array.from({ length: 6 }, () =>
			captureSourceSnapshot({ ...options(f), exec, signal: ac.signal }),
		);
		const settled = Promise.allSettled(pending);
		await vi.waitFor(() => expect(started).toBe(2));
		await expect(captureSourceSnapshot({ ...options(f), exec })).rejects.toThrow(/capacity|queue|busy/i);
		expect(started).toBe(2);
		ac.abort();
		release();
		expect((await settled).every((result) => result.status === "rejected")).toBe(true);
	});
});
