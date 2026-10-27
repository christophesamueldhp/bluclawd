import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

export async function createWriterFixture(): Promise<{
	parentCwd: string;
	siblingDir: string;
	runDir: string;
	exec: ExtensionAPI["exec"];
	cleanup(): Promise<void>;
}> {
	const tempRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
	const root = await realpath(await mkdtemp(join(tempRoot, "bluclawd-writer-proof-")));
	const parentCwd = join(root, "parent");
	const siblingDir = join(root, "sibling");
	const runDir = join(root, "run");
	const home = join(root, "home");
	for (const path of [parentCwd, siblingDir, runDir, home]) await mkdir(path, { mode: 0o700 });

	const exec: ExtensionAPI["exec"] = async (command, args, options) => {
		try {
			const result = await execFileAsync(command, args, {
				cwd: options?.cwd ?? parentCwd,
				signal: options?.signal,
				timeout: options?.timeout ?? 5000,
				env: {
					PATH: process.env.PATH,
					HOME: home,
					LANG: "C",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
				},
			});
			return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
		} catch (error) {
			const failure = error as Error & {
				stdout?: string;
				stderr?: string;
				code?: number | string;
				killed?: boolean;
			};
			return {
				stdout: failure.stdout ?? "",
				stderr: failure.stderr ?? failure.message,
				code: typeof failure.code === "number" ? failure.code : 1,
				killed: failure.killed ?? false,
			};
		}
	};
	try {
		await writeFile(join(parentCwd, "tracked.txt"), "original\n");
		for (const args of [
			["init", "-q"],
			["add", "tracked.txt"],
			[
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"user.name=Writer Proof",
				"-c",
				"user.email=proof@example.invalid",
				"commit",
				"-qm",
				"fixture base",
			],
		]) {
			const result = await exec("git", args);
			if (result.code !== 0) throw new Error(`Writer fixture Git setup failed: ${result.stderr}`);
		}
		return { parentCwd, siblingDir, runDir, exec, cleanup: () => rm(root, { recursive: true, force: true }) };
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}
