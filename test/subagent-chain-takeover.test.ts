import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdmissionContext } from "../ext/subagents/admission.ts";
import { type ChainDeps, resumeChains } from "../ext/subagents/chains.ts";
import { admitGeneration } from "../ext/subagents/generation-state.ts";
import type { ChainStep } from "../ext/subagents/invocation.ts";
import type { ParentScope } from "../ext/subagents/parent-scope.ts";
import type { RunDefinition } from "../ext/subagents/rpc-runs.ts";
import {
	captureRunBaseline,
	type IsolatedWorkspace,
	materializeWorktree,
	worktreePath,
} from "../ext/subagents/run-worktree.ts";
import { createRunId, type SubagentRunRecord } from "../ext/subagents/runs.ts";
import { CallsUnderWay } from "../ext/subagents/settling.ts";
import {
	getSubagentsRootDir,
	storeRunReport,
	subagentRunDir,
	writeAtomicPrivateFile,
	writePersistedRunRecord,
} from "../ext/subagents/storage.ts";

const SESSION = "session-1";
const at = (minute: number) => Date.parse(`2026-01-01T00:${String(minute).padStart(2, "0")}:00Z`);

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

/** A step's run as its orchestrator stores it once it closed, in `cwd`. */
function closedRun(
	runId: string,
	name: string,
	cwd: string,
	extra: Partial<SubagentRunRecord> = {},
): SubagentRunRecord {
	return {
		runId,
		parentSessionId: SESSION,
		sessionEpoch: 1,
		parentTurnId: "turn_1",
		originToolCallId: "call_1",
		name,
		generation: 0,
		backend: "rpc",
		agentName: name,
		provider: "faux",
		modelId: "faux-1",
		thinkingLevel: "off",
		cwd,
		taskSummary: name,
		admittedAt: at(0),
		startedAt: at(0),
		endedAt: at(30),
		deliveryMode: "background",
		chain: "chain_t",
		status: "closed",
		backgroundDeliveryAttempted: false,
		...extra,
	} as SubagentRunRecord;
}

/** A repository and the worktree of a chain made from it, run `a`'s, where `a` added new.txt. */
async function chainWorktree(): Promise<{ agentDir: string; a: string; workspace: IsolatedWorkspace }> {
	root = realpathSync(mkdtempSync(join(tmpdir(), "bc-chain-takeover-")));
	const repo = join(root, "repo");
	const agentDir = join(root, "agent");
	mkdirSync(repo);
	mkdirSync(agentDir);
	writeFileSync(join(repo, "a.txt"), "one\n");
	git(repo, "init", "-q");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "start");
	const a = createRunId();
	const captured = captureRunBaseline(repo, a);
	if (!captured.ok) throw new Error(captured.error);
	const workspace = { root: worktreePath(agentDir, a), baseline: captured.baseline };
	await materializeWorktree(workspace);
	writeFileSync(join(workspace.root, "new.txt"), "v1\n");
	return { agentDir, a, workspace };
}

/**
 * Stores run `a` as it closed in its last generation: each generation's role with `tools`, and its Report; and its
 * transcript, with `transcript`'s entries.
 */
function storeRun(
	agentDir: string,
	workspace: IsolatedWorkspace,
	record: SubagentRunRecord,
	generations: { tools: string[]; report: string }[],
	transcript: object[] = [],
): void {
	const runDir = subagentRunDir(agentDir, SESSION, record.runId);
	const transcriptPath = join(runDir, "transcript.jsonl");
	writePersistedRunRecord(agentDir, { ...record, transcriptPath });
	const header = { type: "session", version: 3, id: "a", timestamp: new Date(at(0)).toISOString(), cwd: record.cwd };
	writeFileSync(transcriptPath, `${[header, ...transcript].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	generations.forEach(({ tools, report }, generation) => {
		admitGeneration(runDir, generation, {
			name: "writer",
			description: "Edits files.",
			instructions: "Make the change asked.",
			tools,
			deny: [],
			cwd: workspace.root,
			projectTrusted: false,
			admitted: { provider: "faux", modelId: "faux-1", thinkingLevel: "off" },
			workspace,
		} as unknown as RunDefinition);
		storeRunReport(runDir, { text: report, outcome: { status: "completed" }, generation });
	});
}

/**
 * Takes over chain `chain_t` as the session's next instance does, its plan storing `steps` and `ran`. Each step it
 * admits completes at once with the Report "Admitted done."; resolves with the tasks it admitted and the aggregate.
 */
function takeOver(
	agentDir: string,
	workspace: IsolatedWorkspace,
	steps: ChainStep[],
	ran: ({ runId: string; generation: number } | null)[],
): Promise<{ tasks: string[]; aggregate: string }> {
	writeAtomicPrivateFile(
		join(getSubagentsRootDir(agentDir), SESSION, "chain-plans", "chain_t.json"),
		JSON.stringify({ chain: "chain_t", steps, toolCallId: "call_1", parentTurnId: "turn_1", writes: true, ran }),
	);
	const tasks: string[] = [];
	return new Promise((resolve) => {
		const deps: ChainDeps = {
			admission: {
				launch: async ({ params, chain }) => {
					tasks.push(params.task);
					const run = closedRun(chain?.runId ?? createRunId(), params.name ?? "", workspace.root);
					storeRunReport(subagentRunDir(agentDir, SESSION, run.runId), {
						text: "Admitted done.",
						outcome: { status: "completed" },
						generation: 0,
					});
					return { ok: true, handle: { runId: run.runId, record: run, completion: Promise.resolve(run) } };
				},
				resume: async () => ({ ok: false, error: "no step is resumed after the takeover" }),
			},
			nameHolder: () => undefined,
			agentDir: () => agentDir,
			reports: { next: () => new Promise(() => {}) },
			getRun: () => undefined,
			whenFinal: () => undefined,
			handOff: new AbortController().signal,
			cancel: () => {},
			scope: {
				current: () => ({ parentSessionId: SESSION, sessionEpoch: 2 }) as ParentScope,
				inScope: () => true,
				onBranch: () => true,
			},
			context: () => ({}) as AdmissionContext,
			calls: new CallsUnderWay(),
			notify: (_first, { parentText }) => resolve({ tasks, aggregate: parentText }),
		};
		resumeChains(deps, SESSION);
	});
}

// The window no real pi can be timed into: the session ended after the plan recorded a step and before that step's
// run existed, so the session taking over admits it from what the steps before stored.
describe("a chain taken over before its next step's run existed", () => {
	it("tells that step where the step that edits before it worked, and the aggregate each step's checks", async () => {
		const { agentDir, a, workspace } = await chainWorktree();
		storeRun(agentDir, workspace, closedRun(a, "a", workspace.root), [
			{ tools: ["read", "write"], report: "Wrote v1." },
		]);

		const { tasks, aggregate } = await takeOver(
			agentDir,
			workspace,
			[
				{ run: { agent: "writer", name: "a", task: "Write new.txt." } },
				{ run: { agent: "explorer", name: "b", task: "Look next." } },
			],
			[
				{ runId: a, generation: 0 },
				{ runId: createRunId(), generation: 0 },
			],
		);

		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toContain("Look next.");
		expect(tasks[0]).toContain("Wrote v1.");
		expect(tasks[0]).toMatch(/^Changes since its baseline: A new\.txt$/m);
		expect(aggregate).toMatch(/Chain chain_t: 2 steps, all completed\./);
		expect(aggregate).toMatch(
			/### chain\[0\] "a" \(sub_[\w-]+\): completed\nChecks: none ran: it had no tool that runs commands\.\nWrote v1\./,
		);
	}, 60_000);

	it("says what it cannot tell of the checks of a step whose run a later step resumed", async () => {
		const { agentDir, a, workspace } = await chainWorktree();
		const tools = ["read", "write", "bash"];
		// Generation 0 ran a command; generation 1, started at minute 20, none.
		storeRun(
			agentDir,
			workspace,
			closedRun(a, "a", workspace.root, { generation: 1, startedAt: at(20) }),
			[
				{ tools, report: "Checked v1." },
				{ tools, report: "Checked again." },
			],
			[
				{
					type: "message",
					timestamp: new Date(at(5)).toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "grep v1 new.txt" } }],
					},
				},
				{
					type: "message",
					timestamp: new Date(at(5)).toISOString(),
					message: { role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, content: "v1" },
				},
			],
		);

		const { tasks, aggregate } = await takeOver(
			agentDir,
			workspace,
			[
				{ run: { agent: "writer", name: "a", task: "Write new.txt." } },
				{ resume: 0, task: "Check again." },
				{ run: { agent: "explorer", name: "c", task: "Look last." } },
			],
			[
				{ runId: a, generation: 0 },
				{ runId: a, generation: 1 },
				{ runId: createRunId(), generation: 0 },
			],
		);

		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toContain("Checked again.");
		expect(tasks[0]).toMatch(/^Changes since its baseline: A new\.txt$/m);
		expect(aggregate).toMatch(/Chain chain_t: 3 steps, all completed\./);
		expect(aggregate).toMatch(
			/### chain\[0\] "a" \(sub_[\w-]+\): completed\nChecks: unknown: its run was resumed since\.\nChecked v1\./,
		);
		expect(aggregate).toMatch(
			/### chain\[1\] "a" \(sub_[\w-]+\), resumed: completed\nChecks: its transcript shows it ran no commands\.\nChecked again\./,
		);
	}, 60_000);
});
