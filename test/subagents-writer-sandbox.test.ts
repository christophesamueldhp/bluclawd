import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const supported =
	process.platform !== "win32" &&
	SandboxManager.isSupportedPlatform() &&
	SandboxManager.checkDependencies().errors.length === 0;

describe.skipIf(!supported)("M3 sandbox feasibility gate (not a writer implementation)", () => {
	let root: string;
	let parent: string;
	let worker: string;
	const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
	async function run(command: string, child: boolean) {
		const cwd = child ? worker : parent;
		const custom = child
			? { filesystem: { allowWrite: [worker], denyWrite: [parent, join(worker, ".git")], denyRead: [] } }
			: undefined;
		const wrapped = await SandboxManager.wrapWithSandbox(command, "/bin/bash", custom);
		let output = "";
		const result = await createLocalBashOperations().exec(wrapped, cwd, {
			onData: (data) => {
				output += data.toString();
			},
		});
		return { code: result.exitCode, output };
	}

	beforeAll(async () => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "bluclawd-writer-gate-")));
		parent = join(root, "parent");
		worker = join(root, "worker");
		execFileSync("git", ["init", "-q", parent]);
		writeFileSync(join(parent, "tracked.txt"), "original\n");
		execFileSync("git", ["add", "."], { cwd: parent });
		execFileSync(
			"git",
			["-c", "user.name=Sandbox Test", "-c", "user.email=sandbox@example.invalid", "commit", "-qm", "initial"],
			{ cwd: parent },
		);
		execFileSync("git", ["worktree", "add", "--detach", worker, "HEAD"], { cwd: parent, stdio: "pipe" });
		symlinkSync(parent, join(worker, "parent-link"));
		await SandboxManager.initialize(
			{
				network: { allowedDomains: [], deniedDomains: [] },
				filesystem: { allowWrite: [parent], denyWrite: [], denyRead: [] },
			},
			async () => false,
			false,
		);
	}, 60_000);

	afterAll(async () => {
		await SandboxManager.reset();
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("keeps per-command worker restrictions separate from a concurrent parent command", async () => {
		const configBefore = structuredClone(SandboxManager.getConfig());
		const [parentResult, childResult] = await Promise.all([
			run("printf parent > parent-only.txt", false),
			run(`printf child > worker-only.txt; printf escaped > ${quote(join(parent, "escaped.txt"))}`, true),
		]);
		expect(parentResult.code).toBe(0);
		expect(childResult.code).not.toBe(0);
		expect(readFileSync(join(parent, "parent-only.txt"), "utf8")).toBe("parent");
		expect(readFileSync(join(worker, "worker-only.txt"), "utf8")).toBe("child");
		expect(existsSync(join(parent, "escaped.txt"))).toBe(false);
		expect(SandboxManager.getConfig()).toEqual(configBefore);
	});

	it("blocks parent writes through symlinks and Git's shared worktree directory", async () => {
		expect((await run("printf escaped > parent-link/tracked.txt", true)).code).not.toBe(0);
		expect(readFileSync(join(parent, "tracked.txt"), "utf8")).toBe("original\n");
		expect((await run("git update-ref refs/heads/escaped HEAD", true)).code).not.toBe(0);
		expect(existsSync(join(parent, ".git/refs/heads/escaped"))).toBe(false);
	});
});
