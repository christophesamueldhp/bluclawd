import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunDirectory } from "../ext/subagents/directory.ts";
import { admitGeneration } from "../ext/subagents/generation-state.ts";
import type { ParentScope } from "../ext/subagents/parent-scope.ts";
import type { RunDefinition } from "../ext/subagents/rpc-runs.ts";
import {
	captureRunBaseline,
	gitSync,
	materializeWorktree,
	releaseUnchangedWorktree,
	worktreePath,
} from "../ext/subagents/run-worktree.ts";
import type { SubagentRunRecord } from "../ext/subagents/runs.ts";
import { subagentRunDir } from "../ext/subagents/storage.ts";
import { registerWorkspaceCleanup } from "../ext/subagents/workspace-cleanup.ts";
import { leaderlessGroup } from "./helpers/leaderless-group.ts";
import { hostEnded } from "./helpers/run-files.ts";

describe("workspace cleanup", () => {
	let dir: string;
	beforeEach(() => {
		vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		dir = realpathSync(mkdtempSync(join(tmpdir(), "bluclawd-cleanup-test-")));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("leaves the worktree of a finished run in place while processes of its run still run, its host ended", async () => {
		const repo = join(dir, "repo");
		mkdirSync(repo);
		writeFileSync(join(repo, "a.txt"), "one\n");
		const git = (...args: string[]) =>
			gitSync(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args]);
		git("init", "-q", "-b", "main");
		git("add", ".");
		git("commit", "-q", "--no-gpg-sign", "-m", "start");
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir);
		const record = { runId: "sub_left", parentSessionId: "parent", name: "w", status: "closed", cwd: repo };
		const captured = captureRunBaseline(repo, record.runId);
		if (!captured.ok) throw new Error(captured.error);
		const workspace = { root: worktreePath(agentDir, record.runId), baseline: captured.baseline };
		await materializeWorktree(workspace);
		const runDir = subagentRunDir(agentDir, record.parentSessionId, record.runId);
		mkdirSync(runDir, { recursive: true });
		const admitted = { provider: "faux", modelId: "faux", thinkingLevel: "off" };
		const definition = { tools: [], deny: [], cwd: repo, instructions: "", admitted, workspace };
		admitGeneration(runDir, 0, definition as unknown as RunDefinition);
		const group = await leaderlessGroup();
		hostEnded(runDir, group);

		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			registerCommand: (_: string, command: { handler: typeof handler }) => {
				handler = command.handler;
			},
		};
		const finished = { record: record as unknown as SubagentRunRecord, state: "finished" as const };
		const directory = { find: () => finished, list: () => [] } as unknown as Pick<RunDirectory, "find" | "list">;
		registerWorkspaceCleanup(pi as unknown as ExtensionAPI, {
			agentDir: () => agentDir,
			scope: () => ({}) as ParentScope,
			directory,
		});
		const notify = vi.fn();
		await handler?.("w", { ui: { notify } });

		expect(notify).toHaveBeenCalledWith(
			`processes of "w" (sub_left) still run (process group ${group}): stop them, or wait for them to end, before cleaning up its workspace.`,
			"warning",
		);
		expect(git("worktree", "list", "--porcelain")).toContain(`worktree ${workspace.root}\n`);
	});
});

describe("workspace cleanup of a chain's later step", () => {
	let dir: string;
	beforeEach(() => {
		vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		dir = realpathSync(mkdtempSync(join(tmpdir(), "bluclawd-chain-cleanup-test-")));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	async function finishedChain() {
		const repo = join(dir, "repo");
		mkdirSync(repo);
		writeFileSync(join(repo, "a.txt"), "one\n");
		const git = (...args: string[]) =>
			gitSync(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args]);
		git("init", "-q", "-b", "main");
		git("add", ".");
		git("commit", "-q", "--no-gpg-sign", "-m", "start");
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir);
		const captured = captureRunBaseline(repo, "sub_first");
		if (!captured.ok) throw new Error(captured.error);
		const workspace = { root: worktreePath(agentDir, "sub_first"), baseline: captured.baseline };
		await materializeWorktree(workspace);
		const records = ["first", "second"].map((name) => ({
			runId: `sub_${name}`,
			parentSessionId: "parent",
			name,
			status: "closed",
			cwd: workspace.root,
		}));
		const runDir = (runId: string) => subagentRunDir(agentDir, "parent", runId);
		const admitted = { provider: "faux", modelId: "faux", thinkingLevel: "off" };
		for (const { runId } of records) {
			mkdirSync(runDir(runId), { recursive: true });
			const definition = { tools: [], deny: [], cwd: workspace.root, instructions: "", admitted, workspace };
			admitGeneration(runDir(runId), 0, definition as unknown as RunDefinition);
		}

		let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
		const pi = {
			registerCommand: (_: string, command: { handler: typeof handler }) => {
				handler = command.handler;
			},
		};
		const find = (_: ParentScope, target: string) => {
			const record = records.find(({ name, runId }) => target === name || target === runId);
			return record && { record: record as unknown as SubagentRunRecord, state: "finished" as const };
		};
		const directory = { find, list: () => [] } as unknown as Pick<RunDirectory, "find" | "list">;
		registerWorkspaceCleanup(pi as unknown as ExtensionAPI, {
			agentDir: () => agentDir,
			scope: () => ({}) as ParentScope,
			directory,
		});
		const notify = vi.fn();
		const clean = async (target: string) => {
			await handler?.(target, { ui: { notify } });
			return notify.mock.lastCall;
		};
		return { git, agentDir, workspace, firstDir: runDir("sub_first"), clean };
	}

	it("removes the chain's worktree, which a Resume makes again", async () => {
		const { workspace, clean } = await finishedChain();

		expect(await clean("second")).toEqual([
			`Removed ${workspace.root}: it held no change since its baseline, so "second" (sub_second) can still be resumed, its worktree made again.`,
			"info",
		]);
		expect(existsSync(workspace.root)).toBe(false);
	});

	it("says a Resume still makes it again once the chain released it unchanged, its baseline kept", async () => {
		const { git, agentDir, workspace, firstDir, clean } = await finishedChain();
		await releaseUnchangedWorktree(workspace, { agentDir, runId: "sub_first", runDir: firstDir });

		expect(await clean("second")).toEqual([
			`${workspace.root} was removed already; "second" (sub_second) can still be resumed, its worktree made again.`,
			"info",
		]);
		expect(git("for-each-ref", "refs/bluclawd")).toContain(workspace.baseline.ref);
	});
});
