/**
 * Runs in tmux from before runs ran on pi's RPC (ADR-0006, ADR-0010): what an orchestrator does with them once it
 * runs every new run on RPC. A legacy run is planted as the earlier bluclawd started one: an interactive pi in a pane
 * of its own, told its orchestrator's pane, run directory and task, with the record that orchestrator stored.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PARENT_ENV, RUN_DIR_ENV, RUN_TASK_ENV } from "../daemon/tmux.ts";
import type { SubagentRunRecord } from "../ext/subagents/runs.ts";
import {
	ensureRunStorageDir,
	listPersistedRunRecords,
	readPersistedRunRecord,
	writePersistedRunRecord,
} from "../ext/subagents/storage.ts";
import { createEmptySubagentUsage } from "../ext/subagents/usage.ts";
import { readinessMs } from "./helpers/heartbeats.ts";
import {
	conversation,
	DEFAULT_EXTENSIONS,
	FAUX,
	type FauxRequest,
	hasTmux,
	PI_CLI,
	type RealPi,
	startRealPi,
	toolNames,
} from "./helpers/real-pi.ts";
import { waitFor } from "./helpers/wait-for.ts";

/** The last tool result the model was given. */
const lastToolResult = (request: FauxRequest) =>
	conversation(request)
		.filter((message) => message.role === "toolResult")
		.at(-1);

/** The orchestrator in `pane`, as the daemon lists it once it has a session. */
const sessionOf = (real: RealPi, pane: string) =>
	waitFor(async () => {
		const row = (await real.rows()).find((candidate) => candidate.pane === pane);
		expect(row?.sessionId).toBeDefined();
		expect(row?.sessionFile).toBeDefined();
		return { sessionId: row?.sessionId ?? "", sessionFile: row?.sessionFile ?? "" };
	});

/**
 * A run "legacy" of the orchestrator in `parent`, started as bluclawd started runs in tmux: its pi in a pane of its
 * own, which stores and sends each Report, and its record, open, under the orchestrator's session.
 */
function plantLegacyRun(real: RealPi, parent: string, parentSessionId: string) {
	const runId = `sub_${randomUUID()}`;
	const storage = ensureRunStorageDir(real.agentDir, parentSessionId, runId);
	if (!storage.ok) throw new Error(storage.error);
	const { runDir } = storage;
	const task = join(runDir, "task.md");
	writeFileSync(task, "Look around.");
	const pane = real.tmux.newSession({
		cwd: real.cwd,
		command: [process.execPath, PI_CLI],
		args: ["--model", "faux/faux-1", "--name", "legacy", "--session-dir", runDir, "--approve"],
		env: { [PARENT_ENV]: parent, [RUN_DIR_ENV]: runDir, [RUN_TASK_ENV]: task },
	});
	const record: SubagentRunRecord = {
		runId,
		parentSessionId,
		sessionEpoch: 1,
		parentTurnId: "turn_1",
		originToolCallId: "call_legacy",
		name: "legacy",
		generation: 0,
		pane,
		agentName: "explorer",
		definitionSource: "bundled",
		provider: "faux",
		modelId: "faux-1",
		thinkingLevel: "off",
		cwd: real.cwd,
		taskSummary: "Look around.",
		startSnapshot: { headCommit: null, dirty: false, statusDigest: "" },
		admittedAt: Date.now(),
		startedAt: Date.now(),
		deliveryMode: "background",
		status: "running",
		usage: createEmptySubagentUsage(),
		backgroundDeliveryAttempted: false,
	};
	writePersistedRunRecord(real.agentDir, record);
	return { runId, pane, runDir };
}

describe.skipIf(!hasTmux)("runs in tmux from before runs ran on pi's RPC", () => {
	let pi: RealPi | undefined;
	afterEach(async () => {
		await pi?.stop();
		pi = undefined;
	});

	it(
		"keeps an open one working until it is stopped, refuses to resume it, and starts its continuation on pi's RPC",
		async () => {
			// No switch: every new run is on pi's RPC. Its pi loads the faux provider, which `-ne` leaves out.
			vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", FAUX);
			const real = await startRealPi({ extensions: [...DEFAULT_EXTENSIONS, "background-bash"] });
			pi = real;
			real.script("main", [{ text: "ready" }]);
			const orchestrator = real.start(["--", "hello"]);
			await real.waitForRequests("main", 1);
			const { sessionId } = await sessionOf(real, orchestrator);
			real.script("legacy", [{ text: "Legacy looked." }]);
			const legacy = plantLegacyRun(real, orchestrator, sessionId);
			await real.waitForRequests("legacy", 1);

			real.script("main", [
				{ text: "ready" },
				// Woken by the old run's Report, once this orchestrator takes the run over.
				{ tool: "subagent_status", args: {} },
				{ tool: "subagent_stop", args: { agent: "legacy" } },
				{ tool: "subagent_resume", args: { agent: "legacy", task: "Go on." } },
				{ tool: "subagent_message", args: { to: "legacy", content: "Go on." } },
				{
					tool: "subagent",
					args: { agent: "explorer", name: "fresh", task: `Continue the work of run ${legacy.runId}.` },
				},
				{ text: "done" },
			]);
			real.script("fresh", [{ text: "Continued." }]);
			// The orchestrator takes the new runtime: the old run is taken over, never ended.
			real.tmux.sendKeys(orchestrator, ["/reload", "Enter"]);
			const requests = await real.waitForRequests("main", 7);

			expect(conversation(requests[1]).some((message) => message.text.includes("Legacy looked."))).toBe(true);
			const status = lastToolResult(requests[2]);
			expect(status?.text).toMatch(/^legacy \(explorer, sub_[0-9a-f-]+\): (idle|working), in tmux/m);

			// Stopped only when asked: its pi in tmux ends then, its session and Report kept.
			const stop = lastToolResult(requests[3]);
			expect(stop?.text).toMatch(/^Stopped "legacy" \(sub_[0-9a-f-]+\): its pi in tmux ended/);
			expect(real.tmux.hasSession(legacy.pane)).toBe(false);
			const stored = readPersistedRunRecord(real.agentDir, sessionId, legacy.runId);
			expect(stored).toMatchObject({ status: "closed" });
			expect(stored?.transcriptPath && existsSync(stored.transcriptPath)).toBe(true);
			expect(stored?.reportPath && readFileSync(stored.reportPath, "utf8")).toContain("Legacy looked.");

			// Neither a Resume nor a message continues it on pi's RPC: they point at its history instead.
			for (const refused of [lastToolResult(requests[4]), lastToolResult(requests[5])]) {
				expect(refused?.text).toContain("ran in tmux, before runs ran on pi's RPC, and is not resumed");
				expect(refused?.text).toContain(stored?.reportPath ?? "no report");
				expect(refused?.text).toContain(stored?.transcriptPath ?? "no transcript");
			}

			// Its continuation is a new run, admitted afresh, on pi's RPC.
			const [fresh] = await real.waitForRequests("fresh", 1);
			expect(conversation(fresh).at(0)?.text).toContain(legacy.runId);
			expect(lastToolResult(requests[6])?.text).toContain("Continued.");
			const freshRecord = listPersistedRunRecords(real.agentDir, sessionId).find((run) => run.name === "fresh");
			expect(freshRecord).toMatchObject({ backend: "rpc", status: "closed" });
			expect(freshRecord?.pane).toBeUndefined();
			expect(toolNames(requests[6])).not.toContain("subagent_close");
			expect(toolNames(requests[6])).toEqual(expect.arrayContaining(["subagent_resume", "subagent_integrate"]));

			// Its history stays readable: Enter on it in /tasks shows its conversation, and opens no pane.
			real.tmux.sendKeys(orchestrator, ["/tasks", "Enter"]);
			const screen = () => real.tmux.capture(orchestrator, 80).join("\n");
			// Listed after its continuation, the latest first.
			await waitFor(() => expect(screen()).toMatch(/explorer: Look around\..*closed/));
			real.tmux.sendKeys(orchestrator, ["Down"]);
			await waitFor(() => expect(screen()).toMatch(/❯ +explorer: Look around\./));
			real.tmux.sendKeys(orchestrator, ["Enter"]);
			await waitFor(() => expect(screen()).toContain("assistant: Legacy looked."));
			expect(real.tmux.hasSession(legacy.pane)).toBe(false);
		},
		4 * readinessMs,
	);

	// Two pis one after another (the open run's pi, then the /reload): a readiness bound for each to start, and one for
	// the rest.
	it(
		"switches the terminal to an open one's pane, with Enter on it in /tasks",
		{ timeout: 3 * readinessMs },
		async () => {
			const real = await startRealPi({ extensions: [...DEFAULT_EXTENSIONS, "background-bash"] });
			pi = real;
			real.script("main", [{ text: "ready" }, { text: "read the report" }]);
			const orchestrator = real.start(["--", "hello"]);
			await real.waitForRequests("main", 1);
			const { sessionId } = await sessionOf(real, orchestrator);
			real.script("legacy", [{ text: "Legacy looked." }]);
			const legacy = plantLegacyRun(real, orchestrator, sessionId);
			await real.waitForRequests("legacy", 1);
			real.tmux.sendKeys(orchestrator, ["/reload", "Enter"]);
			// Taken over: its Report wakes the orchestrator.
			await real.waitForRequests("main", 2);

			real.attach(orchestrator);
			await waitFor(() => expect(real.shown()).toBe(orchestrator));
			real.tmux.sendKeys(orchestrator, ["/tasks", "Enter"]);
			const screen = () => real.tmux.capture(orchestrator, 80).join("\n");
			await waitFor(() => expect(screen()).toMatch(/❯ +⏺ explorer: Look around\..*idle/));
			real.tmux.sendKeys(orchestrator, ["Enter"]);
			await waitFor(() => expect(real.shown()).toBe(legacy.pane));
		},
	);
});
