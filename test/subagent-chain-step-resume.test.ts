import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { type ExtensionContext, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AdmissionContext,
	type AdmissionResult,
	createRunAdmission,
	type RunExecutionContext,
} from "../ext/subagents/admission.ts";
import { type ChainDeps, type ChainResultDetails, runChain } from "../ext/subagents/chains.ts";
import { createRunDirectory } from "../ext/subagents/directory.ts";
import { generationDefinition } from "../ext/subagents/generation-state.ts";
import { SubagentMessageBus } from "../ext/subagents/messages.ts";
import { createParentScope } from "../ext/subagents/parent-scope.ts";
import { materializeWorktree, worktreeOwner, worktreePath } from "../ext/subagents/run-worktree.ts";
import { type SubagentRunRecord, SubagentRunScheduler } from "../ext/subagents/runs.ts";
import { CallsUnderWay, settledMember } from "../ext/subagents/settling.ts";
import { storeRunReport, subagentRunDir } from "../ext/subagents/storage.ts";

let root: string | undefined;
afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function git(cwd: string, ...args: string[]): void {
	const config = ["-c", "user.name=F", "-c", "user.email=f@example.com", "-c", "commit.gpgsign=false"];
	const result = spawnSync("git", [...config, ...args], { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

async function settledUnchangedChain(stopAtSecond = false) {
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", "faux");
	root = realpathSync(mkdtempSync(join(tmpdir(), "bc-chain-step-resume-")));
	const cwd = join(root, "repo");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	writeFileSync(join(cwd, "a.txt"), "one\n");
	git(cwd, "init", "-q");
	git(cwd, "add", ".");
	git(cwd, "commit", "-q", "-m", "start");

	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	const faux = fauxProvider({ provider: "faux-adm", models: [{ id: "faux-main", reasoning: true }] });
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	const sessionManager = SessionManager.inMemory(cwd);
	const calls = new CallsUnderWay();
	const scheduler = new SubagentRunScheduler<RunExecutionContext>({
		executeRun: async ({ record, signal, context }) => {
			const launch = context && "rpc" in context ? context.rpc : undefined;
			if (!launch) throw new Error("not a run on pi's RPC");
			if (launch.sessionFile) {
				return new Promise((resolve) =>
					signal.addEventListener("abort", () => resolve({ status: "closed", summaryText: "" })),
				);
			}
			if (launch.workspace && !launch.worktreeMade) await materializeWorktree(launch.workspace);
			const at = new Date().toISOString();
			const transcriptPath = join(launch.runDir, "transcript.jsonl");
			writeFileSync(
				transcriptPath,
				[
					{ type: "session", version: 3, id: record.runId, timestamp: at, cwd: launch.cwd },
					{ type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: "x" } },
				]
					.map((entry) => JSON.stringify(entry))
					.join("\n"),
			);
			if (stopAtSecond && record.name === "second") {
				calls.stopAll();
				if (!signal.aborted)
					await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
				return { status: "cancelled", summaryText: "", transcriptPath };
			}
			storeRunReport(launch.runDir, { text: "Changed nothing.", outcome: { status: "completed" }, generation: 0 });
			return { status: "closed", summaryText: "Changed nothing.", transcriptPath };
		},
	});
	const scope = createParentScope({
		bus: new SubagentMessageBus(),
		cancelRuns: () => {},
		send: () => {},
		onChange: () => {},
		batchWindowMs: 0,
	});
	scope.enter({ sessionManager } as unknown as ExtensionContext, "replaced");
	const admission = createRunAdmission({
		scheduler,
		directory: createRunDirectory({ scheduler, agentDir: () => agentDir }),
		agentDir: () => agentDir,
		parentThinkingLevel: () => "low",
		scope,
		pane: () => undefined,
		runPane: () => undefined,
		tools: () => ["read", "write"],
		registeredTools: () => [],
		ensureQueue: async () => true,
	});
	const ctx: AdmissionContext = {
		cwd,
		mode: "tui",
		model: faux.getModel("faux-main"),
		modelRegistry: new ModelRegistry(runtime),
		isProjectTrusted: () => false,
		sessionManager,
	};
	const chains: ChainDeps = {
		admission,
		nameHolder: () => undefined,
		agentDir: () => agentDir,
		reports: { next: () => new Promise(() => {}) },
		getRun: (runId) => scheduler.getRun(runId),
		whenFinal: () => undefined,
		handOff: new AbortController().signal,
		cancel: (runId, reason) => scheduler.cancelRun(runId, "caller", reason),
		scope,
		context: () => ctx,
		calls,
		notify: () => {},
	};
	const writer = { name: "writer", description: "Edits files.", instructions: "Edit.", tools: ["read", "write"] };
	const result = await runChain(
		chains,
		[
			{ run: { agent: writer, name: "first", task: "Change nothing." } },
			{ run: { agent: writer, name: "second", task: "Change nothing either." } },
		],
		{ toolCallId: "call_1", parentTurnId: "turn_1" },
		ctx,
	);
	const aggregate = result.content.map(({ text }) => text).join("\n");
	const details = result.details as ChainResultDetails;
	const stepRun = (step: number): Readonly<SubagentRunRecord> => {
		const run = scheduler.getRun(details.runs[step].runId ?? "");
		if (!run) throw new Error(`chain[${step}] has no run: ${aggregate}`);
		return run;
	};
	const [first, second] = [stepRun(0), stepRun(1)];
	const runDir = (run: Readonly<SubagentRunRecord>) => subagentRunDir(agentDir, run.parentSessionId, run.runId);
	const worktree = worktreePath(agentDir, first.runId);

	expect(details.runs.map(({ status }) => status)).toEqual(["completed", stopAtSecond ? "cancelled" : "completed"]);
	expect(aggregate).toContain(
		`Workspace: ${worktree}, removed: it held no change since its baseline, from which a Resume makes it again.`,
	);
	expect(generationDefinition(runDir(first), 0)?.workspace?.root).toBe(worktree);
	expect(generationDefinition(runDir(second), 0)?.workspace?.root).toBe(worktree);
	expect(existsSync(worktree)).toBe(false);
	expect(existsSync(join(runDir(first), "workspace-removed.json"))).toBe(true);
	expect(existsSync(join(runDir(second), "workspace-removed.json"))).toBe(false);

	const resume = async (run: Readonly<SubagentRunRecord>): Promise<string> => {
		const resumed: AdmissionResult = await admission.resume(run, { from: "orchestrator", text: () => "Go on." }, ctx);
		return resumed.ok ? `admitted generation ${resumed.handle.record.generation}` : resumed.error;
	};
	return { agentDir, first, second, worktree, runDir, resume };
}

describe("a Resume of a step of a chain that settled with its shared worktree unchanged, and so released", () => {
	it("makes the worktree again for the chain's first step", async () => {
		const { first, worktree, resume } = await settledUnchangedChain();

		expect(await resume(first)).toBe("admitted generation 1");
		expect(existsSync(join(worktree, "a.txt"))).toBe(true);
	}, 60_000);

	it("makes the worktree again for a later step too", async () => {
		const { second, worktree, resume } = await settledUnchangedChain();

		expect(await resume(second)).toBe("admitted generation 1");
		expect(existsSync(join(worktree, "a.txt"))).toBe(true);
	}, 60_000);

	it("makes the worktree again for a later step of a chain stopped while that step worked", async () => {
		const { second, worktree, resume } = await settledUnchangedChain(true);

		expect(await resume(second)).toBe("admitted generation 1");
		expect(existsSync(join(worktree, "a.txt"))).toBe(true);
	}, 60_000);
});

describe("a later step of a chain whose unchanged worktree was released", () => {
	it("has its worktree owned by the chain's first step", async () => {
		const { agentDir, first, second, runDir } = await settledUnchangedChain();
		const workspace = generationDefinition(runDir(second), 0)?.workspace;
		if (!workspace) throw new Error("the later step was admitted with no workspace");

		expect(worktreeOwner(workspace, agentDir, second.parentSessionId)).toEqual({
			agentDir,
			runId: first.runId,
			runDir: runDir(first),
		});
	}, 60_000);

	it("says, as the chain does, that a Resume makes its worktree again", async () => {
		const { agentDir, second, worktree } = await settledUnchangedChain();

		expect((await settledMember(agentDir, second)).workspace?.lines[0]).toBe(
			`Workspace: ${worktree}, removed: it held no change since its baseline, from which a Resume makes it again.`,
		);
	}, 60_000);
});
