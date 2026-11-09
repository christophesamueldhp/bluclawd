import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentRunRecord } from "../ext/subagents/runs.ts";
import {
	appendParentRunReference,
	ensureRunStorageDir,
	getSubagentsRootDir,
	readBoundedSubagentReport,
	readPersistedRunRecord,
	readRunUsageLedger,
	reconcileInterruptedRuns,
	recordCountedSessionUsage,
	recordRunSessionUsage,
	SUBAGENT_RUN_CUSTOM_ENTRY,
	writeFullSubagentReport,
	writePersistedRunRecord,
} from "../ext/subagents/storage.ts";
import { createEmptySubagentUsage } from "../ext/subagents/usage.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-storage-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			try {
				chmodSync(dir, 0o700);
			} catch {
				// ignore
			}
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

function makeRecord(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
	return {
		runId: "sub_store_1",
		parentSessionId: "sess_abc_123",
		sessionEpoch: 1,
		parentTurnId: "turn_1",
		originToolCallId: "call_1",
		generation: 0,
		originEntryId: "entry_origin_1",
		agentName: "explorer",
		definitionSource: "bundled",
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
		thinkingLevel: "low",
		cwd: "/proj",
		taskSummary: "Explore storage",
		startSnapshot: { headCommit: "1234567", dirty: false, statusDigest: "" },
		snapshotDrifted: false,
		admittedAt: 1000,
		startedAt: 1050,
		deliveryMode: "foreground",
		status: "running",
		complete: false,
		usage: {
			...createEmptySubagentUsage(),
			input: 200,
			output: 80,
			totalTokens: 280,
			cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
		},
		backgroundDeliveryAttempted: false,
		...overrides,
	};
}

describe("Task 5 (M1) — Subagent storage, atomic records, reconciliation, and ledger", () => {
	it("persists run records and full reports outside the repository with restrictive permissions and sanitizes diagnostic secrets", () => {
		const agentDir = makeTempDir("agent");
		const record = makeRecord({
			status: "failed",
			errorMessage: "Provider error with Bearer sk-secret-token-999999 and api_key=my_secret_123",
		});

		const dirRes = ensureRunStorageDir(agentDir, record.parentSessionId, record.runId);
		if (!dirRes.ok) throw new Error(dirRes.error);
		expect(existsSync(dirRes.runDir)).toBe(true);

		if (process.platform !== "win32") {
			const mode = statSync(dirRes.runDir).mode & 0o777;
			expect(mode).toBe(0o700);
		}

		const writeRec = writePersistedRunRecord(agentDir, record);
		if (!writeRec.ok) throw new Error(writeRec.error);

		const loaded = readPersistedRunRecord(agentDir, record.parentSessionId, record.runId);
		expect(loaded).toBeDefined();
		expect(loaded?.errorMessage).not.toContain("sk-secret-token-999999");
		expect(loaded?.errorMessage).not.toContain("my_secret_123");
		expect(loaded?.errorMessage).toContain("[REDACTED]");

		const rawDiskJson = readFileSync(writeRec.recordPath, "utf8");
		expect(rawDiskJson).not.toContain("sk-secret-token-999999");
		expect(rawDiskJson).not.toContain("my_secret_123");

		const reportRes = writeFullSubagentReport(agentDir, record, "# Full Report\n\nDetailed findings with path:line.");
		if (!reportRes.ok) throw new Error(reportRes.error);
		expect(existsSync(reportRes.reportPath)).toBe(true);

		const bounded = readBoundedSubagentReport(agentDir, record.parentSessionId, record.runId, 1024);
		if (!bounded.ok) throw new Error(bounded.error);
		expect(bounded.content).toContain("Detailed findings with path:line.");
	});

	it("rejects path traversal in session or run IDs and reports storage write failures without fictitious paths", () => {
		const agentDir = makeTempDir("invalid-paths");

		expect(ensureRunStorageDir(agentDir, "../escape", "sub_1").ok).toBe(false);
		expect(ensureRunStorageDir(agentDir, "sess_1", "../sub_escape").ok).toBe(false);
		expect(ensureRunStorageDir(agentDir, "sess/slash", "sub_1").ok).toBe(false);

		// Simulate inaccessible storage by using a file where a directory is required
		const blockedAgentDir = join(agentDir, "not-a-dir");
		writePersistedRunRecord(agentDir, makeRecord());
		const fileBlocker = join(agentDir, "blocker-file");
		rmSync(fileBlocker, { force: true });
		// Write a regular file at `blockedAgentDir`
		const fs = require("node:fs");
		fs.writeFileSync(blockedAgentDir, "file", "utf8");

		const failedReport = writeFullSubagentReport(blockedAgentDir, makeRecord(), "Report content");
		expect(failedReport.ok).toBe(false);
		expect(failedReport).not.toHaveProperty("reportPath");
	});

	it("records parent references via pi.appendEntry and reconciles orphaned nonterminal runs on restart as interrupted without replaying work", () => {
		const agentDir = makeTempDir("reconcile");
		const appendedEntries: Array<{ type: string; customType: string; data: unknown }> = [];
		const fakePi = {
			appendEntry: (customType: string, data: unknown) => {
				appendedEntries.push({ type: "custom", customType, data });
			},
		};

		const runningRec = makeRecord({ runId: "sub_orphan_1", status: "running" });
		const completedRec = makeRecord({
			runId: "sub_done_2",
			status: "completed",
			complete: true,
			endedAt: 2000,
		});
		const abandonedBranchRec = makeRecord({ runId: "sub_abandoned_3", status: "running" });

		writePersistedRunRecord(agentDir, runningRec);
		writePersistedRunRecord(agentDir, completedRec);
		writePersistedRunRecord(agentDir, abandonedBranchRec);

		appendParentRunReference(fakePi, runningRec);
		appendParentRunReference(fakePi, completedRec);
		expect(appendedEntries).toHaveLength(2);
		expect(appendedEntries[0].customType).toBe(SUBAGENT_RUN_CUSTOM_ENTRY);

		// Reconcile only the active branch entries (runningRec and completedRec; abandonedBranchRec is not on branch)
		const reconciled = reconcileInterruptedRuns(
			agentDir,
			runningRec.parentSessionId,
			appendedEntries,
			new Set(), // no live runs after restart
		);

		expect(reconciled.map((r) => r.runId)).toEqual(["sub_orphan_1"]);
		expect(reconciled[0].status).toBe("interrupted");
		expect(reconciled[0].complete).toBe(false);

		const reloadedOrphan = readPersistedRunRecord(agentDir, runningRec.parentSessionId, "sub_orphan_1");
		expect(reloadedOrphan?.status).toBe("interrupted");

		const reloadedCompleted = readPersistedRunRecord(agentDir, completedRec.parentSessionId, "sub_done_2");
		expect(reloadedCompleted?.status).toBe("completed");
	});

	it("reconciles a run in tmux its orchestrator never closed as closed, resumable from the session it kept, and in the background", () => {
		const agentDir = makeTempDir("reconcile-tmux");
		// No foreground call waits for it once its orchestrator crashed: a Report it stored comes as a notice.
		const run = makeRecord({ runId: "sub_tmux_1", status: "running", pane: "pi-run", deliveryMode: "foreground" });
		writePersistedRunRecord(agentDir, run);
		const runDir = join(getSubagentsRootDir(agentDir), run.parentSessionId, run.runId);
		writeFileSync(join(runDir, "a.jsonl"), "");
		utimesSync(join(runDir, "a.jsonl"), 1, 1);
		writeFileSync(join(runDir, "b.jsonl"), "");
		const entries = [{ type: "custom", customType: SUBAGENT_RUN_CUSTOM_ENTRY, data: { runId: run.runId } }];

		const reconciled = reconcileInterruptedRuns(agentDir, run.parentSessionId, entries, new Set());

		expect(reconciled).toEqual([
			expect.objectContaining({ runId: run.runId, status: "closed", transcriptPath: join(runDir, "b.jsonl") }),
		]);
		expect(readPersistedRunRecord(agentDir, run.parentSessionId, run.runId)).toMatchObject({
			status: "closed",
			transcriptPath: join(runDir, "b.jsonl"),
			deliveryMode: "background",
		});
	});

	it("reads legacy quota stops as cancelled and reconciles a legacy queued run as interrupted without restarting it", () => {
		const agentDir = makeTempDir("legacy");
		const parentSessionId = "sess_legacy_1";
		const writeLegacy = (runId: string, status: string, stopSource?: string, stopReason?: string) => {
			const legacy = {
				...makeRecord({ runId, parentSessionId }),
				status,
				stopSource,
				stopReason,
				deadlineAt: 301000,
				repeatedCallCount: 3,
				repeatedDenialCount: 0,
			};
			const dir = join(getSubagentsRootDir(agentDir), parentSessionId, runId);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "record.json"), JSON.stringify(legacy));
			return { type: "custom", customType: SUBAGENT_RUN_CUSTOM_ENTRY, data: { runId } };
		};
		const entries = [
			writeLegacy("sub_legacy_queued", "queued"),
			writeLegacy("sub_legacy_timeout", "timed_out", "deadline"),
			writeLegacy("sub_legacy_budget", "budget_exceeded", "budget"),
			writeLegacy("sub_legacy_aborted", "timed_out", "deadline", "aborted"),
		];

		const reconciled = reconcileInterruptedRuns(agentDir, parentSessionId, entries, new Set());

		expect(reconciled.map((r) => [r.runId, r.status])).toEqual([["sub_legacy_queued", "interrupted"]]);
		const timeout = readPersistedRunRecord(agentDir, parentSessionId, "sub_legacy_timeout");
		expect(timeout).toMatchObject({ status: "cancelled", stopReason: "Stopped by a deadline (legacy)" });
		expect(timeout?.stopSource).toBeUndefined();
		const budget = readPersistedRunRecord(agentDir, parentSessionId, "sub_legacy_budget");
		expect(budget).toMatchObject({ status: "cancelled", stopReason: "Stopped by a budget (legacy)" });
		expect(budget?.stopSource).toBeUndefined();
		expect(readPersistedRunRecord(agentDir, parentSessionId, "sub_legacy_aborted")).toMatchObject({
			status: "cancelled",
			stopReason: "aborted",
		});
		const onDisk = join(getSubagentsRootDir(agentDir), parentSessionId, "sub_legacy_timeout", "record.json");
		expect(JSON.parse(readFileSync(onDisk, "utf8"))).toMatchObject({ status: "timed_out", stopSource: "deadline" });
	});

	it("reads a record stored before generations were always recorded as the launch's generation", () => {
		const agentDir = makeTempDir("legacy-generation");
		const parentSessionId = "sess_legacy_generation";
		const { generation: _, ...legacy } = makeRecord({ runId: "sub_legacy_gen", parentSessionId });
		const dir = join(getSubagentsRootDir(agentDir), parentSessionId, "sub_legacy_gen");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "record.json"), JSON.stringify(legacy));

		expect(readPersistedRunRecord(agentDir, parentSessionId, "sub_legacy_gen")?.generation).toBe(0);
	});

	const tokens = (totalTokens: number, cost: number) => ({
		...createEmptySubagentUsage(),
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	});

	/** The ledger as runs from before runs were pis of their own left it: their usage, already added up. */
	const writeEarlierLedger = (agentDir: string, parentSessionId: string) => {
		const dir = join(getSubagentsRootDir(agentDir), parentSessionId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "background-usage-ledger.json"),
			JSON.stringify({
				parentSessionId,
				runCount: 2,
				recordedRunIds: ["sub_in_process", "sub_in_process#1"],
				usage: tokens(280, 0.002),
			}),
		);
	};

	it("keeps a run's own session total, which a resumed generation of that session carries on", () => {
		const agentDir = makeTempDir("ledger");
		const parentSessionId = "sess_ledger_2";
		writeEarlierLedger(agentDir, parentSessionId);
		recordRunSessionUsage(agentDir, { parentSessionId, runId: "sub_tmux_1" }, "session_1", tokens(100, 0.01));
		recordRunSessionUsage(agentDir, { parentSessionId, runId: "sub_tmux_2" }, "session_2", tokens(50, 0.005));
		// Resumed into the same session file, the run's next Report holds its first generation's 100 tokens too.
		recordRunSessionUsage(agentDir, { parentSessionId, runId: "sub_tmux_1" }, "session_1", tokens(160, 0.016));

		const ledger = readRunUsageLedger(agentDir, parentSessionId);
		expect(ledger.runCount).toBe(3);
		expect(ledger.usage.totalTokens).toBe(280 + 160 + 50);
		expect(ledger.usage.cost.total).toBeCloseTo(0.002 + 0.016 + 0.005, 6);
	});

	it("keeps each session a run has had, so a new session inside the run never shrinks what it counted", () => {
		const agentDir = makeTempDir("ledger");
		const parentSessionId = "sess_ledger_3";
		const run = { parentSessionId, runId: "sub_tmux_1" };
		recordRunSessionUsage(agentDir, run, "session_1", tokens(100, 0.01));
		// `/new` inside the run: its next Report carries the new session's total only.
		recordRunSessionUsage(agentDir, run, "session_2", tokens(20, 0.002));
		recordRunSessionUsage(agentDir, run, "session_2", tokens(30, 0.003));

		const ledger = readRunUsageLedger(agentDir, parentSessionId);
		expect(ledger.runCount).toBe(1);
		expect(ledger.usage.totalTokens).toBe(130);
		expect(ledger.usage.cost.total).toBeCloseTo(0.013, 6);
	});

	it("leaves out what a session from before runs were pis of their own had counted already, when a run resumes it", () => {
		const agentDir = makeTempDir("ledger");
		const parentSessionId = "sess_ledger_4";
		writeEarlierLedger(agentDir, parentSessionId);
		const session = SessionManager.create("/proj", makeTempDir("old-run"));
		session.appendMessage({ role: "user", content: "Old task.", timestamp: Date.now() });
		session.appendMessage({ ...fauxAssistantMessage("Old answer."), usage: { ...tokens(280, 0.002), input: 280 } });
		const sessionFile = session.getSessionFile()!;

		recordCountedSessionUsage(agentDir, parentSessionId, sessionFile);
		// A second resume of the same old run must not count it twice either.
		recordCountedSessionUsage(agentDir, parentSessionId, sessionFile);
		// Its Report holds the old turns as well as the new ones.
		recordRunSessionUsage(
			agentDir,
			{ parentSessionId, runId: "sub_in_process" },
			session.getSessionId(),
			tokens(330, 0.005),
		);

		const ledger = readRunUsageLedger(agentDir, parentSessionId);
		expect(ledger.runCount).toBe(1);
		expect(ledger.usage.totalTokens).toBe(330);
		expect(ledger.usage.cost.total).toBeCloseTo(0.005, 6);
	});
});
