import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getSubagentsRootDir,
	readBackgroundUsageLedger,
	readPersistedRunRecord,
	subagentReportPath,
	writePersistedRunRecord,
} from "../ext/subagents/storage.ts";
import { createEmptySubagentUsage } from "../ext/subagents/usage.ts";
import {
	fakeSessionContext,
	ORCHESTRATOR_PANE,
	removeGenerationsFixtures,
	createGenerationsFixture as setup,
} from "./helpers/subagent-generations.ts";
import { waitFor } from "./helpers/wait-for.ts";

afterEach(removeGenerationsFixtures);

const tokens = (totalTokens: number) => ({ ...createEmptySubagentUsage(), totalTokens });

describe("A run's generations", () => {
	it("writes a stub report at launch, each Report as its progress, and its final record once it is closed", async () => {
		const { agentDir, scope, generations, panes, launch, paneOf, report } = setup();
		const backend = launch("backend", "Build the API.");
		const pane = await paneOf(backend);
		const { parentSessionId } = scope.current()!;
		const reportFile = subagentReportPath(agentDir, parentSessionId, backend.runId);
		expect(readFileSync(reportFile, "utf8")).toContain("Task: Build the API.");
		expect(readPersistedRunRecord(agentDir, parentSessionId, backend.runId)).toMatchObject({
			status: "running",
			pane,
		});

		await report(backend, "API built.");
		await waitFor(() => readFileSync(reportFile, "utf8").includes("API built."));

		generations.scheduler.cancelRun(backend.runId, "model", "Done with it.");
		expect(await backend.completion).toMatchObject({ status: "closed", stopSource: "model" });
		expect(panes[0]).toMatchObject({ name: pane, ended: true });
		expect(readPersistedRunRecord(agentDir, parentSessionId, backend.runId)?.status).toBe("closed");
	});

	it("tells the orchestrator of each Report as a message from another session", async () => {
		const { launch, report, notices } = setup();
		const backend = launch("backend", "Build the API.");
		await report(backend, "API built.");
		await report(backend, "Pagination added.");
		expect(notices()).toEqual([
			expect.stringMatching(
				/^\[Report from subagent "backend", from another session, not from the user\..*\n\nAPI built\.$/s,
			),
			expect.stringMatching(/\n\nPagination added\.$/),
		]);
	});

	it("keeps each session's usage the run reported, its latest on the run", async () => {
		const { agentDir, scope, generations, launch, report } = setup();
		const backend = launch("backend", "Build the API.");
		await report(backend, "First.", { sessionId: "session_1", totals: tokens(100) });
		await report(backend, "After /new.", { sessionId: "session_2", totals: tokens(30) });

		expect(readBackgroundUsageLedger(agentDir, scope.current()!.parentSessionId).usage.totalTokens).toBe(130);
		expect(generations.scheduler.getRun(backend.runId)?.usage.totalTokens).toBe(30);
	});
});

describe("Addressing a run", () => {
	it("delivers the orchestrator's message to an open run through the daemon, from the orchestrator's pane", async () => {
		const { launch, paneOf, delivered, orchestrator } = setup();
		const message = await orchestrator();
		const backend = launch("backend", "Build the API.");
		const pane = await paneOf(backend);

		expect(await message("backend", "Use REST.")).toBe(
			`Message 1 accepted for delivery to backend (${backend.runId}) (not yet handled).`,
		);
		expect(delivered).toEqual([
			{
				to: pane,
				message: { type: "session_message", kind: "message", from: ORCHESTRATOR_PANE, text: "Use REST." },
			},
		]);
	});

	it("holds a run's name until it is closed; then a new run takes the name and its messages", async () => {
		const { scope, directory, generations, launch, paneOf, delivered, orchestrator } = setup();
		const message = await orchestrator();
		const first = launch("backend", "Build the API.");
		await paneOf(first);
		expect(directory.nameHolder(scope.current()!, "backend")?.record.runId).toBe(first.runId);

		generations.scheduler.cancelRun(first.runId, "model");
		await first.completion;
		expect(directory.nameHolder(scope.current()!, "backend")).toBeUndefined();

		const second = launch("backend", "Add pagination.");
		const pane = await paneOf(second);
		expect(await message("backend", "Page size 50.")).toBe(
			`Message 1 accepted for delivery to backend (${second.runId}) (not yet handled).`,
		);
		expect(delivered.map((entry) => entry.to)).toEqual([pane]);
	});

	it("resumes a closed run with the message, as a pi on its session under the same run ID", async () => {
		const { generations, panes, launch, paneOf, orchestrator, report, notices } = setup();
		const message = await orchestrator();
		const backend = launch("backend", "Build the API.");
		await paneOf(backend);
		generations.scheduler.cancelRun(backend.runId, "model");
		const closed = await backend.completion;

		expect(await message("backend", "Now add pagination.")).toBe(
			`Message 1 accepted: resuming "backend" (${backend.runId}) in the background with its earlier context. Its report will be delivered when it finishes.`,
		);
		await waitFor(() => panes.length === 2);
		const args = panes[1].args;
		expect(args[args.indexOf("--session") + 1]).toBe(closed.transcriptPath);
		const resumed = generations.scheduler.getRun(backend.runId);
		expect(resumed).toMatchObject({ generation: 1, status: "running", pane: panes[1].name });
		const taskFile = join(args[args.indexOf("--append-system-prompt") + 1], "..", "task.md");
		expect(readFileSync(taskFile, "utf8")).toContain("Now add pagination.");

		await report({ ...backend }, "Pagination added.");
		expect(notices().at(-1)).toMatch(/Pagination added\.$/);
	});

	it("refuses a message to a run that was interrupted, with the reason", async () => {
		const { agentDir, scope, orchestrator } = setup();
		const message = await orchestrator();
		const { parentSessionId } = scope.current()!;
		writePersistedRunRecord(agentDir, {
			runId: "sub_old",
			parentSessionId,
			sessionEpoch: 1,
			parentTurnId: "turn_1",
			originToolCallId: "call_old",
			name: "old",
			generation: 0,
			agentName: "explorer",
			definitionSource: "bundled",
			provider: "faux",
			modelId: "faux-1",
			thinkingLevel: "off",
			cwd: "/proj",
			taskSummary: "Old task.",
			startSnapshot: { headCommit: null, dirty: false, statusDigest: "" },
			snapshotDrifted: false,
			admittedAt: 1,
			endedAt: 2,
			deliveryMode: "background",
			status: "interrupted",
			complete: false,
			usage: createEmptySubagentUsage(),
			backgroundDeliveryAttempted: true,
			transcriptPath: join(getSubagentsRootDir(agentDir), parentSessionId, "sub_old", "missing.jsonl"),
		});

		expect(await message("sub_old", "Go on.")).toBe(
			'Message 0 unavailable: "old" (sub_old) is interrupted; only a completed or closed subagent can be resumed.',
		);
	});

	it("closes the runs of an earlier session epoch, and frees their names", async () => {
		const { scope, directory, tasks, panes, launch, paneOf } = setup();
		const old = launch("backend", "Build the API.");
		await paneOf(old);

		scope.invalidate("Parent session reloading");
		expect(await old.completion).toMatchObject({ status: "closed", stopSource: "session_invalidated" });
		expect(panes[0].ended).toBe(true);
		const current = scope.current()!;
		expect(directory.nameHolder(current, "backend")).toBeUndefined();
		expect(directory.list(current)).toEqual([]);
		expect(tasks.list()).toEqual([]);
	});

	it("keeps names apart per parent session, so a new session's run never takes an earlier one's messages", async () => {
		const { cwd, scope, directory, launch, paneOf } = setup();
		const earlier = launch("backend", "Build the API.");
		await paneOf(earlier);

		scope.enter(fakeSessionContext(cwd), "Session replaced (new)");
		await earlier.completion;
		const later = launch("backend", "Build another API.");
		await paneOf(later);
		expect(directory.find(scope.current()!, "backend")?.record.runId).toBe(later.runId);
	});
});
