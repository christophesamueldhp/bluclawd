import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export async function createSubagentFixture() {
	const root = await mkdtemp(join(await realpath(tmpdir()), "bcs-test-"));
	const parentCwd = join(root, "parent");
	const stateDir = join(root, "state");
	await mkdir(parentCwd);
	await mkdir(stateDir);
	const exec: ExtensionAPI["exec"] = (command, args, options) =>
		new Promise((resolve) => {
			execFile(
				command,
				args,
				{
					cwd: options?.cwd ?? parentCwd,
					timeout: options?.timeout ?? 30_000,
					signal: options?.signal,
					maxBuffer: 16 * 1024 * 1024,
					encoding: "utf8",
				},
				(error, stdout, stderr) =>
					resolve({
						stdout,
						stderr,
						code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
						killed: Boolean(error?.killed),
					}),
			);
		});
	const git = async (...args: string[]) => {
		const result = await exec("git", args, { cwd: parentCwd });
		if (result.code !== 0) throw new Error(result.stderr);
		return result.stdout;
	};
	await git("init", "-q", "--initial-branch=main");
	await git("config", "user.name", "Fixture");
	await git("config", "user.email", "fixture@example.invalid");
	await git("config", "commit.gpgsign", "false");
	await writeFile(join(parentCwd, "tracked.txt"), "base line\nsecond base\n");
	await writeFile(join(parentCwd, ".gitignore"), "ignored/\n*.cache\n");
	await git("add", ".");
	await git("commit", "-qm", "Fixture baseline");
	const scratchDirs: string[] = [];
	return {
		parentCwd,
		stateDir,
		root,
		exec,
		git,
		scratchDirs,
		async cleanup() {
			const owned = new Set(scratchDirs);
			for (const name of await readdir(stateDir, { recursive: true })) {
				if (!name.endsWith("/workspace.json")) continue;
				const manifest = join(stateDir, name);
				if (!/^sub_[0-9a-f-]{36}$/.test(basename(dirname(manifest)))) continue;
				const workspace = JSON.parse(await readFile(manifest, "utf8"));
				if (
					workspace.root === join(dirname(manifest), "workspace") &&
					/^bcs-[A-Za-z0-9]+$/.test(basename(workspace.scratchDir)) &&
					["/private/tmp", await realpath(tmpdir())].includes(dirname(workspace.scratchDir))
				) {
					owned.add(workspace.scratchDir);
				}
			}
			for (const path of owned) await rm(path, { recursive: true, force: true });
			await rm(root, { recursive: true, force: true });
		},
	};
}
