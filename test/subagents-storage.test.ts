import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentRunRecord } from "../ext/subagents/runs.ts";
import {
	appendParentRunReference,
	ensureRunStorageDir,
	getSubagentsRootDir,
	readBackgroundUsageLedger,
	readBoundedSubagentReport,
	readPersistedRunRecord,
	reconcileInterruptedRuns,
	recordBackgroundUsageInLedger,
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
		turnCount: 1,
		toolCallCount: 2,
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
		expect(dirRes.ok).toBe(true);
		expect(existsSync(dirRes.runDir!)).toBe(true);

		if (process.platform !== "win32") {
			const mode = statSync(dirRes.runDir!).mode & 0o777;
			expect(mode).toBe(0o700);
		}

		const writeRec = writePersistedRunRecord(agentDir, record);
		expect(writeRec.ok).toBe(true);

		const loaded = readPersistedRunRecord(agentDir, record.parentSessionId, record.runId);
		expect(loaded).toBeDefined();
		expect(loaded?.errorMessage).not.toContain("sk-secret-token-999999");
		expect(loaded?.errorMessage).not.toContain("my_secret_123");
		expect(loaded?.errorMessage).toContain("[REDACTED]");

		const rawDiskJson = readFileSync(writeRec.recordPath!, "utf8");
		expect(rawDiskJson).not.toContain("sk-secret-token-999999");
		expect(rawDiskJson).not.toContain("my_secret_123");

		const reportRes = writeFullSubagentReport(agentDir, record, "# Full Report\n\nDetailed findings with path:line.");
		expect(reportRes.ok).toBe(true);
		expect(existsSync(reportRes.reportPath!)).toBe(true);

		const bounded = readBoundedSubagentReport(agentDir, record.parentSessionId, record.runId, 1024);
		expect(bounded.ok).toBe(true);
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
		expect(failedReport.reportPath).toBeUndefined();
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

	it("reads the legacy foreground attribution flag as where the usage went", () => {
		const agentDir = makeTempDir("legacy-usage");
		const parentSessionId = "sess_legacy_usage";
		const readLegacy = (runId: string, deliveryMode: string, foregroundUsageAttributed: boolean) => {
			const dir = join(getSubagentsRootDir(agentDir), parentSessionId, runId);
			mkdirSync(dir, { recursive: true });
			const legacy = { ...makeRecord({ runId, parentSessionId }), deliveryMode, foregroundUsageAttributed };
			writeFileSync(join(dir, "record.json"), JSON.stringify(legacy));
			return readPersistedRunRecord(agentDir, parentSessionId, runId);
		};

		const foreground = readLegacy("sub_legacy_fg", "foreground", true);
		expect(foreground?.usageAttribution).toBe("tool_result");
		expect(foreground).not.toHaveProperty("foregroundUsageAttributed");
		expect(readLegacy("sub_legacy_fg_unsettled", "foreground", false)?.usageAttribution).toBe("tool_result");
		expect(readLegacy("sub_legacy_bg", "background", false)?.usageAttribution).toBe("ledger");
	});

	it("records each generation's usage in the ledger once", () => {
		const agentDir = makeTempDir("ledger");
		const parentSessionId = "sess_ledger_1";
		const launch = makeRecord({ runId: "sub_bg_1", parentSessionId, deliveryMode: "background" });
		const resumed = { ...launch, generation: 1 };

		recordBackgroundUsageInLedger(agentDir, launch);
		recordBackgroundUsageInLedger(agentDir, launch);
		recordBackgroundUsageInLedger(agentDir, resumed);
		const ledger = readBackgroundUsageLedger(agentDir, parentSessionId);
		expect(ledger.recordedRunIds).toEqual(["sub_bg_1", "sub_bg_1#1"]);
		expect(ledger.usage.totalTokens).toBe(560);
		expect(ledger.usage.cost.total).toBeCloseTo(0.004, 6);
	});
});
