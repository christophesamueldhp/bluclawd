import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentRunRecord } from "../ext/subagents/runs.ts";
import {
	getSubagentsRootDir,
	readPersistedRunRecord,
	readRunUsageLedger,
	subagentReportPath,
	writePersistedRunRecord,
} from "../ext/subagents/storage.ts";
import { sendRetrying } from "../ext/subagents/tmux-runs.ts";
import { createEmptySubagentUsage } from "../ext/subagents/usage.ts";
import {
	fakeSessionContext,
	ORCHESTRATOR_PANE,
	removeGenerationsFixtures,
	createGenerationsFixture as setup,
} from "./helpers/subagent-generations.ts";
import { waitFor } from "./helpers/wait-for.ts";

afterEach(removeGenerationsFixtures);

/** The file a cut Report's pointer names. */
const fullTextFile = (notice: string) => /\[Report truncated, full text: ([^\]]+)\]$/.exec(notice)?.[1] ?? "";

const tokens = (totalTokens: number) => ({ ...createEmptySubagentUsage(), totalTokens });

/** A run an earlier instance stored, interrupted. */
const storedRun = (parentSessionId: string): SubagentRunRecord => ({
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
});

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

	it("closes a run whose own pi exits, keeping its session to resume", async () => {
		const { panes, launch, paneOf, tasks } = setup();
		const backend = launch("backend", "Build the API.");
		await paneOf(backend);

		// Its pi quit or crashed: tmux no longer has its session.
		panes[0].ended = true;
		expect(await backend.completion).toMatchObject({
			status: "closed",
			transcriptPath: expect.stringMatching(/pi-run1\.jsonl$/),
		});
		expect(tasks.list()).toEqual([]);
		expect(tasks.listDone?.()).toEqual([expect.objectContaining({ id: backend.runId, status: "closed" })]);
	});

	it("tells the orchestrator of each Report as a message from another session", async () => {
		const { launch, report, notices } = setup();
		const backend = launch("backend", "Build the API.");
		await report(backend, "API built.");
		await report(backend, "Pagination added.");
		expect(notices()).toEqual([
			expect.stringMatching(
				/^\[Report from subagent "backend" \(sub_backend_1\), from another session, not from the user\..*\n\nAPI built\.$/s,
			),
			expect.stringMatching(/\n\nPagination added\.$/),
		]);
	});

	it("tells the orchestrator only the end of a Report over 2000 lines, and the file that holds its full text", async () => {
		const { launch, storeReport, sendReport, notices, noticeDetails } = setup();
		const backend = launch("backend", "Build the API.");
		const long = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
		await sendReport(backend, storeReport(backend, long), long);
		await sendReport(backend, storeReport(backend, "Pagination added."), "Pagination added.");

		const [cut, short] = notices();
		expect(cut).toMatch(/\n\nline 501\n/);
		expect(cut).not.toMatch(/\nline 500\n/);
		expect(cut).toMatch(/\nline 2500\n\n\[Report truncated, full text: [^\]]+\]$/);
		expect(readFileSync(fullTextFile(cut), "utf8")).toBe(`${long}\n`);
		expect(short).toMatch(/\n\nPagination added\.$/);
		expect(noticeDetails().map((details) => details.truncated)).toEqual([true, false]);
	});

	it("tells the orchestrator only the end of a Report over 50 KB, and the file that holds its full text", async () => {
		const { launch, storeReport, sendReport, notices } = setup();
		const backend = launch("backend", "Build the API.");
		const long = Array.from({ length: 100 }, (_, i) => `${i + 1} ${"x".repeat(1000)}`).join("\n");
		await sendReport(backend, storeReport(backend, long), long);

		const [cut] = notices();
		expect(cut).not.toContain("\n\n1 x");
		expect(cut).toMatch(/\n100 x+\n\n\[Report truncated, full text: [^\]]+\]$/);
		expect(Buffer.byteLength(cut)).toBeLessThan(52 * 1024);
		expect(readFileSync(fullTextFile(cut), "utf8")).toBe(`${long}\n`);
	});

	it("keeps each session's usage the run reported, its latest on the run", async () => {
		const { agentDir, scope, generations, launch, report } = setup();
		const backend = launch("backend", "Build the API.");
		await report(backend, "First.", { sessionId: "session_1", totals: tokens(100) });
		await report(backend, "After /new.", { sessionId: "session_2", totals: tokens(30) });

		expect(readRunUsageLedger(agentDir, scope.current()!.parentSessionId).usage.totalTokens).toBe(130);
		expect(generations.scheduler.getRun(backend.runId)?.usage.totalTokens).toBe(30);
	});
});

describe("Delivering a run's Reports", () => {
	it("tells the orchestrator of a Report once, however often it is sent", async () => {
		const { launch, sendReport, notices } = setup();
		const backend = launch("backend", "Build the API.");
		await sendReport(backend, 1, "API built.");
		// Sent again by a retry whose first try had reached the daemon.
		await sendReport(backend, 1, "API built.");
		await sendReport(backend, 2, "Pagination added.");
		await sendReport(backend, 1, "API built.");
		expect(notices()).toEqual([
			expect.stringMatching(/\n\nAPI built\.$/),
			expect.stringMatching(/\n\nPagination added\.$/),
		]);
	});

	it("gives a foreground call the Report its run stored but could not send, once the run's pane is gone", async () => {
		const { launch, paneOf, panes, storeReport, reports, notices } = setup();
		const backend = launch("backend", "Build the API.");
		await paneOf(backend);
		const waiting = reports.next(backend.runId);
		// Its send failed: the Report is only on disk.
		storeReport(backend, "API built.");
		panes[0].ended = true;

		expect(await waiting).toMatchObject({ kind: "report", text: "API built.", seq: 1 });
		expect(notices()).toEqual([]);
	});

	it("tells the orchestrator's session, reloaded, of the Report its open run stored meanwhile, and of no earlier one", async () => {
		const first = setup();
		const backend = first.launch("backend", "Build the API.");
		first.storeReport(backend, "API built.");
		await first.sendReport(backend, 1, "API built.");
		// The orchestrator is reloading: the run's next Report is only on disk.
		first.storeReport(backend, "Pagination added.");

		const next = setup(first);
		const { parentSessionId } = next.scope.current()!;
		next.admission.adopt(readPersistedRunRecord(first.agentDir, parentSessionId, backend.runId)!, next.session);
		expect(next.notices()).toEqual([expect.stringMatching(/\n\nPagination added\.$/)]);
	});

	it("adopts an open foreground run into the orchestrator's session reopened after a crash: in the background, told the new pane, its stored Report a notice", async () => {
		const first = setup();
		const backend = first.launch("backend", "Build the API.", { deliveryMode: "foreground" });
		const pane = await first.paneOf(backend);
		// The orchestrator crashed while the run worked; the run stored its Report, which reached no one.
		first.storeReport(backend, "API built.");

		const next = setup(first);
		const { parentSessionId } = next.scope.current()!;
		next.admission.adopt(readPersistedRunRecord(first.agentDir, parentSessionId, backend.runId)!, next.session);
		expect(next.generations.scheduler.getRun(backend.runId)?.deliveryMode).toBe("background");
		expect(next.notices()).toEqual([expect.stringMatching(/\n\nAPI built\.$/)]);
		await waitFor(() =>
			expect(next.delivered).toContainEqual({
				to: pane,
				message: { type: "session_message", kind: "adopt", from: ORCHESTRATOR_PANE, sessionId: parentSessionId },
			}),
		);
	});

	it("tells the orchestrator's session, reopened, of the Report its closed run stored, once", async () => {
		const first = setup();
		const backend = first.launch("backend", "Build the API.");
		first.storeReport(backend, "API built.");
		await first.sendReport(backend, 1, "API built.");
		first.storeReport(backend, "Pagination added.");
		first.generations.scheduler.cancelRun(backend.runId, "model", "Done with it.");
		await backend.completion;

		const next = setup(first);
		const scope = next.scope.current()!;
		next.generations.scheduler.reopen(
			readPersistedRunRecord(first.agentDir, scope.parentSessionId, backend.runId)!,
			scope.sessionEpoch,
		);
		next.generations.pullReports(scope);
		next.generations.pullReports(scope);
		expect(next.notices()).toEqual([expect.stringMatching(/\n\nPagination added\.$/)]);
		expect(readPersistedRunRecord(first.agentDir, scope.parentSessionId, backend.runId)?.lastDeliveredSeq).toBe(2);
	});

	it("tells the orchestrator's session, reopened, of a long Report its closed run stored, and the file that holds it", async () => {
		const first = setup();
		const backend = first.launch("backend", "Build the API.");
		const long = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n");
		first.storeReport(backend, long);
		first.storeReport(backend, "Pagination added.");
		first.generations.scheduler.cancelRun(backend.runId, "model", "Done with it.");
		await backend.completion;

		const next = setup(first);
		const scope = next.scope.current()!;
		next.generations.scheduler.reopen(
			readPersistedRunRecord(first.agentDir, scope.parentSessionId, backend.runId)!,
			scope.sessionEpoch,
		);
		next.generations.pullReports(scope);
		const [cut, short] = next.notices();
		expect(cut).toMatch(/\nline 2500\n\n\[Report truncated, full text: [^\]]+\]$/);
		expect(readFileSync(fullTextFile(cut), "utf8")).toBe(`${long}\n`);
		expect(short).toMatch(/\n\nPagination added\.$/);
	});

	it("reads the Reports that never came from disk, in order, before a later one that did", async () => {
		const { launch, storeReport, sendReport, notices } = setup();
		const backend = launch("backend", "Build the API.");
		// Sent, then lost with the daemon's inbox, which no failed heartbeat told of.
		storeReport(backend, "API built.");
		storeReport(backend, "Pagination added.");
		await sendReport(backend, 2, "Pagination added.");
		expect(notices()).toEqual([
			expect.stringMatching(/\n\nAPI built\.$/),
			expect.stringMatching(/\n\nPagination added\.$/),
		]);
	});

	it("numbers a run's Report after its last one, even one that cannot be read back", async () => {
		const { launch, storeReport, agentDir } = setup();
		const backend = launch("backend", "Build the API.");
		expect(storeReport(backend, "API built.")).toBe(1);
		const runDir = join(getSubagentsRootDir(agentDir), backend.record.parentSessionId, backend.runId);
		writeFileSync(join(runDir, "reports", "1.json"), "{ torn");
		expect(storeReport(backend, "Pagination added.")).toBe(2);
	});

	it("has a run send its Report again, whatever failed, until the daemon takes it or the tries run out", async () => {
		let failures = 2;
		const sends: string[] = [];
		const send = async () => {
			sends.push("try");
			if (failures-- > 0) throw new Error("connect ECONNREFUSED");
		};
		await sendRetrying(send, [0, 0, 0]);
		expect(sends).toHaveLength(3);

		failures = Number.POSITIVE_INFINITY;
		sends.length = 0;
		await expect(sendRetrying(send, [0, 0])).rejects.toThrow("ECONNREFUSED");
		expect(sends).toHaveLength(3);
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

	it("delivers a message to a run whose pi has not registered with the daemon yet, once it has", async () => {
		const { launch, paneOf, delivered, orchestrator, unregistered } = setup();
		const message = await orchestrator();
		const backend = launch("backend", "Build the API.");
		await paneOf(backend);
		// Its pi is still starting: the daemon does not know its pane for the first two tries.
		unregistered(2);

		expect(await message("backend", "Use REST.")).toBe(
			`Message 1 accepted for delivery to backend (${backend.runId}) (not yet handled).`,
		);
		expect(delivered).toHaveLength(1);
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

	it("resumes a run known only from disk with its inline role's instructions and tools, from the call that launched it", async () => {
		const { agentDir, scope, session, panes, orchestrator } = setup();
		const message = await orchestrator();
		const { parentSessionId } = scope.current()!;
		// The orchestrator's session keeps the launch call, its inline role with it.
		const role = { name: "checker", description: "Checks.", instructions: "INLINE-MARKER: check.", tools: ["read"] };
		(session.sessionManager as SessionManager).appendMessage(
			fauxAssistantMessage([fauxToolCall("subagent", { agent: role, task: "Check." }, { id: "call_inline" })]),
		);
		const runDir = join(getSubagentsRootDir(agentDir), parentSessionId, "sub_inline");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(join(runDir, "old.jsonl"), "");
		writePersistedRunRecord(agentDir, {
			...storedRun(parentSessionId),
			runId: "sub_inline",
			originToolCallId: "call_inline",
			name: "checker-1",
			agentName: "checker",
			definitionSource: "inline",
			status: "completed",
			transcriptPath: join(runDir, "old.jsonl"),
		});

		expect(await message("checker-1", "Check again.")).toMatch(/^Message 1 accepted: resuming/);
		await waitFor(() => panes.length === 1);
		const args = panes[0].args;
		expect(args[args.indexOf("--tools") + 1]).toBe("read");
		expect(readFileSync(args[args.indexOf("--append-system-prompt") + 1], "utf8")).toBe("INLINE-MARKER: check.");
	});

	it("refuses a message to a run that was interrupted, with the reason", async () => {
		const { agentDir, scope, orchestrator } = setup();
		const message = await orchestrator();
		const { parentSessionId } = scope.current()!;
		writePersistedRunRecord(agentDir, {
			...storedRun(parentSessionId),
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
