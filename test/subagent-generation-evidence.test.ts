import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitGeneration, runDefinitionPath } from "../ext/subagents/generation-state.ts";
import type { RunDefinition } from "../ext/subagents/rpc-runs.ts";
import {
	checksLines,
	commandsRun,
	generationEvidence,
	generationReport,
	sessionFileEntries,
} from "../ext/subagents/run-evidence.ts";
import {
	captureRunBaseline,
	type IsolatedWorkspace,
	materializeWorktree,
	worktreePath,
} from "../ext/subagents/run-worktree.ts";
import { createRunId, type SubagentRunRecord } from "../ext/subagents/runs.ts";
import { settledMember } from "../ext/subagents/settling.ts";
import { readRunReports, storeRunReport, subagentRunDir } from "../ext/subagents/storage.ts";

const SESSION = "session-1";
const at = (minute: number) => Date.UTC(2026, 0, 1, 0, minute);

let root: string | undefined;
afterEach(() => {
	vi.useRealTimers();
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function git(cwd: string, ...args: string[]): void {
	const config = ["-c", "user.name=F", "-c", "user.email=f@example.com", "-c", "commit.gpgsign=false"];
	const result = spawnSync("git", [...config, ...args], { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

/** A run's directory, and the worktree of a run made from a repository, where it added new.txt. */
async function runWithWorktree(): Promise<{
	agentDir: string;
	runId: string;
	runDir: string;
	workspace: IsolatedWorkspace;
}> {
	root = realpathSync(mkdtempSync(join(tmpdir(), "bc-generation-evidence-")));
	const repo = join(root, "repo");
	const agentDir = join(root, "agent");
	mkdirSync(repo);
	mkdirSync(agentDir);
	writeFileSync(join(repo, "a.txt"), "one\n");
	git(repo, "init", "-q");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "start");
	const runId = createRunId();
	const captured = captureRunBaseline(repo, runId);
	if (!captured.ok) throw new Error(captured.error);
	const workspace = { root: worktreePath(agentDir, runId), baseline: captured.baseline };
	await materializeWorktree(workspace);
	writeFileSync(join(workspace.root, "new.txt"), "v1\n");
	const runDir = subagentRunDir(agentDir, SESSION, runId);
	mkdirSync(runDir, { recursive: true });
	return { agentDir, runId, runDir, workspace };
}

/** Admits generation `generation` of the run at `admittedAt`, or as stored before Admission kept when, with `tools`. */
function admit(
	runDir: string,
	generation: number,
	{ tools, workspace, admittedAt }: { tools: string[]; workspace?: IsolatedWorkspace; admittedAt?: number },
): void {
	vi.setSystemTime(admittedAt ?? at(0));
	admitGeneration(runDir, generation, {
		name: "writer",
		description: "Edits files.",
		instructions: "Make the change asked.",
		tools,
		deny: [],
		cwd: workspace?.root ?? runDir,
		projectTrusted: false,
		admitted: { provider: "faux", modelId: "faux-1", thinkingLevel: "off" },
		...(workspace ? { workspace } : {}),
	} as unknown as RunDefinition);
	vi.useRealTimers();
	if (admittedAt !== undefined) return;
	const path = runDefinitionPath(runDir, generation);
	const { admittedAt: _, ...stored } = JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify(stored));
}

/** A run's record, closed in generation `generation`. */
const closedRun = (runId: string, generation: number, extra: Partial<SubagentRunRecord> = {}): SubagentRunRecord =>
	({
		runId,
		parentSessionId: SESSION,
		sessionEpoch: 1,
		parentTurnId: "turn_1",
		originToolCallId: "call_1",
		name: "writer",
		generation,
		backend: "rpc",
		agentName: "writer",
		provider: "faux",
		modelId: "faux-1",
		thinkingLevel: "off",
		cwd: "/tmp",
		taskSummary: "writer",
		admittedAt: at(0),
		deliveryMode: "background",
		status: "closed",
		backgroundDeliveryAttempted: false,
		...extra,
	}) as SubagentRunRecord;

describe("which Report is a Generation's, by Integration's rule and a member's", () => {
	it("differs for a Resume that stored none: Integration's is the earlier Generation's, a member has none", async () => {
		const { agentDir, runId, runDir, workspace } = await runWithWorktree();
		admit(runDir, 0, { tools: ["edit"], workspace, admittedAt: at(0) });
		storeRunReport(runDir, { text: "Done.", outcome: { status: "completed" }, generation: 0 });
		// A Resume left idle, or one that did not start: closed, with no Report of its own.
		admit(runDir, 1, { tools: ["edit"], workspace, admittedAt: at(30) });

		// Integration's rule: the run's latest Report, of any Generation.
		expect(readRunReports(runDir, -1).at(-1)?.text).toBe("Done.");
		// A member's rule: the last stored with its Generation's number.
		expect((await settledMember(agentDir, closedRun(runId, 1))).report).toBeUndefined();
	});
});

describe("a Generation's Report", () => {
	it("is the last one stored with its number, whichever Generation stored later ones", async () => {
		const { runDir } = await runWithWorktree();
		storeRunReport(runDir, { text: "First.", outcome: { status: "completed" }, generation: 0 });
		storeRunReport(runDir, {
			text: "Second.",
			outcome: { status: "failed", error: "its model failed" },
			generation: 0,
		});
		storeRunReport(runDir, { text: "Resumed.", outcome: { status: "completed" }, generation: 1 });

		expect(generationReport(runDir, 0)).toMatchObject({ seq: 2, text: "Second.", outcome: { status: "failed" } });
		expect(generationReport(runDir, 1)?.text).toBe("Resumed.");
		expect(generationReport(runDir, 2)).toBeUndefined();
	});
});

/** A bash call its pi made at minute `minute`, and its result: failed with `code` when given. */
const ran = (minute: number, command: string, code?: number): object[] => {
	const timestamp = new Date(at(minute)).toISOString();
	const id = `call-${minute}`;
	return [
		{
			type: "message",
			id: `${id}-ask`,
			parentId: null,
			timestamp,
			message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] },
		},
		{
			type: "message",
			id: `${id}-result`,
			parentId: `${id}-ask`,
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: id,
				toolName: "bash",
				isError: code !== undefined,
				content: [{ type: "text", text: code === undefined ? "ok" : `Command exited with code ${code}` }],
			},
		},
	];
};

/** Stores the run's transcript, with `entries`, and says where it is. */
function storeTranscript(runDir: string, entries: object[]): string {
	const path = join(runDir, "transcript.jsonl");
	const header = { type: "session", version: 3, id: "s", timestamp: new Date(at(0)).toISOString(), cwd: runDir };
	writeFileSync(path, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

describe("what the runtime saw of a Generation", () => {
	it("is its Report, the commands it ran from its admission to the next one's, and what it changed in its worktree", async () => {
		const { runDir, workspace } = await runWithWorktree();
		admit(runDir, 0, { tools: ["edit", "bash"], workspace, admittedAt: at(0) });
		storeRunReport(runDir, { text: "Added new.txt.", outcome: { status: "completed" }, generation: 0 });
		admit(runDir, 1, { tools: ["edit", "bash"], workspace, admittedAt: at(30) });
		const transcript = storeTranscript(runDir, [
			...ran(5, "npm test", 1),
			...ran(10, "npm test"),
			...ran(40, "git diff"),
		]);

		const first = await generationEvidence(runDir, 0, { transcript, startedAt: at(20) });
		expect(first.report?.text).toBe("Added new.txt.");
		expect(first.reportFile).toBe(join(runDir, "reports", "1.md"));
		expect(first.tools).toEqual(["edit", "bash"]);
		expect(first.commands).toEqual({
			ran: [
				{ command: "npm test", ended: "exit 1" },
				{ command: "npm test", ended: "exit 0" },
			],
		});
		expect(first.workspace?.root).toBe(workspace.root);
		expect(first.workspace?.lines.at(-1)).toBe("Changes since its baseline: A new.txt");

		const second = await generationEvidence(runDir, 1, { transcript, startedAt: at(0) });
		expect(second.report).toBeUndefined();
		expect(second.commands).toEqual({ ran: [{ command: "git diff", ended: "exit 0" }] });
	});
});

describe("what the runtime saw of a Generation stored before Admission kept when it admitted it", () => {
	it("counts its commands from its reader's own start for it, while it is the run's latest", async () => {
		const { runDir } = await runWithWorktree();
		admit(runDir, 0, { tools: ["bash"] });
		const transcript = storeTranscript(runDir, [...ran(5, "before"), ...ran(25, "after")]);

		expect((await generationEvidence(runDir, 0, { transcript, startedAt: at(20) })).commands).toEqual({
			ran: [{ command: "after", ended: "exit 0" }],
		});
		// One not admitted here at all, as a fake orchestrator's, counts the same.
		expect((await generationEvidence(runDir, 3, { transcript, startedAt: at(20) })).commands).toEqual({
			ran: [{ command: "after", ended: "exit 0" }],
		});
	});

	it("does not know its commands once its run was resumed since", async () => {
		const { runDir } = await runWithWorktree();
		admit(runDir, 0, { tools: ["bash"] });
		admit(runDir, 1, { tools: ["bash"] });
		const transcript = storeTranscript(runDir, ran(5, "either"));

		expect((await generationEvidence(runDir, 0, { transcript, startedAt: at(0) })).commands).toEqual({
			unknown: "resumed",
		});
	});
});

describe("what the runtime saw of a Generation, as far as it can", () => {
	it("does not know its commands when its transcript cannot be read, or none was stored", async () => {
		const { runDir } = await runWithWorktree();
		admit(runDir, 0, { tools: ["bash"], admittedAt: at(0) });

		const unread = { unknown: "unreadable" };
		expect((await generationEvidence(runDir, 0, { transcript: join(runDir, "missing.jsonl") })).commands).toEqual(
			unread,
		);
		expect((await generationEvidence(runDir, 0, {})).commands).toEqual(unread);
	});

	it("has no worktree for a role with no tool that changes files", async () => {
		const { runDir } = await runWithWorktree();
		admit(runDir, 0, { tools: ["read"], admittedAt: at(0) });
		storeRunReport(runDir, { text: "Read it.", outcome: { status: "completed" }, generation: 0 });

		const evidence = await generationEvidence(runDir, 0, { transcript: storeTranscript(runDir, []) });
		expect(evidence).toMatchObject({ tools: ["read"], commands: { ran: [] } });
		expect(evidence.workspace).toBeUndefined();
	});
});

describe("a single Run's checks", () => {
	it("are the same counted from its Generation's admission as from when its run queued", async () => {
		const { runDir, workspace } = await runWithWorktree();
		admit(runDir, 0, { tools: ["edit", "bash"], workspace, admittedAt: at(0) });
		admit(runDir, 1, { tools: ["edit", "bash"], workspace, admittedAt: at(30) });
		const queuedAt = at(31);
		const transcript = storeTranscript(runDir, [
			...ran(10, "earlier"),
			...ran(35, "npm test", 2),
			...ran(36, "npm test"),
		]);

		const { commands } = await generationEvidence(runDir, 1, { transcript, startedAt: queuedAt });
		const lines = checksLines(["edit", "bash"], "ran" in commands ? commands.ran : []);
		expect(lines).toEqual([
			"Checks: the commands its transcript shows it ran, 2:",
			"- `npm test`: exit 2",
			"- `npm test`: exit 0",
		]);
		const entries = sessionFileEntries(transcript) ?? [];
		expect(checksLines(["edit", "bash"], commandsRun(entries, queuedAt))).toEqual(lines);
	});
});
