import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type SubagentRunController,
	type SubagentRunnerOutcome,
	type SubagentRunRecord,
	SubagentRunScheduler,
} from "../ext/subagents/runs.ts";
import { writeFullSubagentReport, writePersistedRunRecord } from "../ext/subagents/storage.ts";
import { createAgentTaskSource } from "../ext/subagents/task-source.ts";
import { createEmptySubagentUsage } from "../ext/subagents/usage.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "bluclawd-task-source-"));
	tempDirs.push(dir);
	return dir;
}

function persistedRecord(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
	return {
		runId: "sub_done",
		parentSessionId: "sess_main",
		runtimeGeneration: 1,
		parentTurnId: "turn_1",
		originToolCallId: "call_1",
		agentName: "explorer",
		definitionSource: "bundled",
		provider: "faux",
		modelId: "faux-1",
		thinkingLevel: "low",
		cwd: "/proj",
		taskSummary: "Inspect architecture",
		startSnapshot: { headCommit: null, dirty: false, statusDigest: "" },
		snapshotDrifted: false,
		admittedAt: 1000,
		startedAt: 1010,
		endedAt: 2000,
		deliveryMode: "background",
		status: "completed",
		complete: true,
		turnCount: 1,
		toolCallCount: 0,
		usage: createEmptySubagentUsage(),
		backgroundDeliveryAttempted: true,
		...overrides,
	};
}

/** A source over a real scheduler whose runs wait until the test settles them. */
function setup(activeParentSessionId: string | undefined = "sess_main") {
	const agentDir = makeAgentDir();
	const controllers = new Map<string, SubagentRunController>();
	const settle = new Map<string, (outcome: SubagentRunnerOutcome) => void>();
	const scheduler = new SubagentRunScheduler({
		executeRun: ({ record, controller, signal }) => {
			controllers.set(record.runId, controller);
			return new Promise<SubagentRunnerOutcome>((resolve) => {
				settle.set(record.runId, resolve);
				signal.addEventListener("abort", () =>
					resolve({ status: "cancelled", complete: false, summaryText: "stopped" }),
				);
			});
		},
	});
	const launch = (parentSessionId = "sess_main", taskSummary = "Scan auth") => {
		const admitted = scheduler.admit({
			parentSessionId,
			runtimeGeneration: 1,
			parentTurnId: "turn_1",
			originToolCallId: `call_${Math.random().toString(36).slice(2, 8)}`,
			agentName: "explorer",
			definitionSource: "bundled",
			provider: "faux",
			modelId: "faux-1",
			thinkingLevel: "low",
			cwd: "/proj",
			taskSummary,
			deliveryMode: "background",
		});
		if (!admitted.ok || !admitted.handle) throw new Error(admitted.error);
		return admitted.handle;
	};
	const source = createAgentTaskSource({
		scheduler,
		agentDir: () => agentDir,
		activeParentSessionId: () => activeParentSessionId,
	});
	return { agentDir, scheduler, controllers, settle, launch, source };
}

describe("Spec #52 — the run-to-task translation behind the agent-task seam", () => {
	it("lists the owner's live runs as running tasks, defaulting to the orchestrator's session", () => {
		const { launch, source, controllers } = setup();
		const mine = launch("sess_main", "Scan auth");
		launch("sess_other", "Elsewhere");
		controllers.get(mine.runId)?.markRunning();

		const tasks = source.list();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toMatchObject({
			id: mine.runId,
			owner: "sess_main",
			agent: "explorer",
			task: "Scan auth",
			state: "running",
			status: "running",
			model: "faux/faux-1",
		});
		expect(source.list("sess_other").map((task) => task.task)).toEqual(["Elsewhere"]);
	});

	it("gets a live or a finished run as the same task, and hides another session's run", () => {
		const { agentDir, launch, source } = setup();
		const live = launch();
		const foreign = launch("sess_other");
		for (const [runId, status] of [
			["sub_completed", "completed"],
			["sub_failed", "failed"],
			["sub_interrupted", "interrupted"],
			["sub_cancelled", "cancelled"],
		] as const) {
			writePersistedRunRecord(agentDir, persistedRecord({ runId, status }));
		}

		expect(source.get(live.runId)).toMatchObject({ id: live.runId, state: "running", status: "starting" });
		expect(source.get(foreign.runId)).toBeUndefined();
		expect(source.get(foreign.runId, "sess_other")?.id).toBe(foreign.runId);
		expect(
			["sub_completed", "sub_failed", "sub_interrupted", "sub_cancelled"].map((id) => {
				const task = source.get(id);
				return [task?.state, task?.status];
			}),
		).toEqual([
			["completed", "completed"],
			["failed", "failed"],
			["failed", "interrupted"],
			["stopped", "cancelled"],
		]);
		expect(source.get("sub_completed")).toMatchObject({ startedAt: 1010, endedAt: 2000 });
		expect(source.get("sub_missing")).toBeUndefined();
	});

	it("keeps a stopping run in the running state", async () => {
		const { launch, source, scheduler } = setup();
		const run = launch();
		scheduler.cancelRun(run.runId, "user");
		expect(source.get(run.runId)).toMatchObject({ state: "running", status: "stopping" });
		await run.completion;
		expect(source.get(run.runId)).toMatchObject({ state: "stopped", status: "cancelled" });
	});

	it("says why a stop failed: an unknown, foreign or orphaned id is not found, a finished run is not running", async () => {
		const { agentDir, launch, source, settle } = setup();
		const running = launch();
		const foreign = launch("sess_other");
		const finished = launch();
		settle.get(finished.runId)?.({ status: "completed", complete: true, summaryText: "done" });
		await finished.completion;
		writePersistedRunRecord(agentDir, persistedRecord({ runId: "sub_earlier", status: "completed" }));
		writePersistedRunRecord(
			agentDir,
			persistedRecord({ runId: "sub_orphan", status: "running", endedAt: undefined }),
		);

		expect(source.stop("sub_missing")).toEqual({ ok: false, reason: "not_found" });
		expect(source.stop(foreign.runId, { owner: "sess_main" })).toEqual({ ok: false, reason: "not_found" });
		expect(source.stop(finished.runId)).toMatchObject({
			ok: false,
			reason: "not_running",
			task: { id: finished.runId, status: "completed" },
		});
		expect(source.stop("sub_earlier")).toMatchObject({
			ok: false,
			reason: "not_running",
			task: { status: "completed" },
		});

		// A run a crashed process never ended has nothing to stop.
		expect(source.stop("sub_orphan")).toEqual({ ok: false, reason: "not_found" });

		const stopped = source.stop(running.runId, { source: "model" });
		expect(stopped).toMatchObject({ ok: true, task: { id: running.runId } });
		expect(await running.completion).toMatchObject({ status: "cancelled", stopSource: "model" });
	});

	it("stops a run by its id only, not by its name", () => {
		const { scheduler, source } = setup();
		const admitted = scheduler.admit({
			parentSessionId: "sess_main",
			runtimeGeneration: 1,
			parentTurnId: "turn_1",
			originToolCallId: "call_named",
			name: "api",
			agentName: "explorer",
			definitionSource: "bundled",
			provider: "faux",
			modelId: "faux-1",
			thinkingLevel: "low",
			cwd: "/proj",
			deliveryMode: "background",
		});
		expect(admitted.ok).toBe(true);
		expect(source.stop("api")).toEqual({ ok: false, reason: "not_found" });
	});

	it("stops every running run of the owner", () => {
		const { launch, source } = setup();
		launch();
		launch();
		launch("sess_other");
		expect(source.stopAll({ source: "user" })).toBe(2);
		expect(setup(undefined).source.stopAll()).toBe(0);
	});

	it("reads the bounded report as output, falling back to the latest progress", () => {
		const { agentDir, launch, source, controllers } = setup();
		const live = launch();
		controllers.get(live.runId)?.updateProgress("Scanning src/auth.ts");
		expect(source.get(live.runId)?.output()).toBe("Scanning src/auth.ts");

		writePersistedRunRecord(agentDir, persistedRecord({ runId: "sub_unreported", summaryText: "Summary only" }));
		expect(source.get("sub_unreported")?.output()).toBe("Summary only");

		const done = persistedRecord({ runId: "sub_reported" });
		writePersistedRunRecord(agentDir, done);
		writeFullSubagentReport(agentDir, done, `Final report\n${"x".repeat(10_000)}`);
		const task = source.get("sub_reported");
		expect(task?.outputFile).toBe(join(agentDir, "bluclawd", "subagents", "sess_main", "sub_reported", "report.md"));
		const output = task?.output() ?? "";
		expect(output.startsWith("Final report")).toBe(true);
		expect(output).toContain("[Report view truncated at 8192 bytes]");
	});
});
