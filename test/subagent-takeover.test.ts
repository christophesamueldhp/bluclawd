import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentRunRecord } from "../ext/subagents/runs.ts";
import {
	readPersistedRunRecord,
	SUBAGENT_RUN_CUSTOM_ENTRY,
	writePersistedRunRecord,
} from "../ext/subagents/storage.ts";
import { type TakeoverContext, takeOverRuns } from "../ext/subagents/takeover.ts";
import { fakeScheduler, runRecord, SESSION } from "./helpers/fake-runs.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** What a session that starts again takes over of `stored`, the runs its earlier instance left in its run directory. */
function start(
	stored: SubagentRunRecord[],
	options: {
		/** This pi's tmux session; none outside tmux. */
		pane?: string;
		/** The tmux sessions still up. */
		up?: string[];
		/** The runs Admission cannot take over, by ID. */
		unrecoverable?: string[];
		/** The runs the branch references, by ID. */
		referenced?: string[];
		/** Runs the scheduler of this instance runs already. */
		running?: SubagentRunRecord[];
	} = {},
) {
	const agentDir = mkdtempSync(join(tmpdir(), "bc-takeover-"));
	dirs.push(agentDir);
	for (const run of stored) writePersistedRunRecord(agentDir, run);
	const scheduler = fakeScheduler(options.running);
	const adopted: string[] = [];
	const recovered: string[] = [];
	const ended: string[] = [];
	const notices: string[] = [];
	const pulled: number[] = [];
	const chains: string[] = [];
	const retold: { runId: string; sessionEpoch: number }[] = [];
	const scope = { parentSessionId: SESSION, sessionEpoch: 2 };
	const ctx = {
		sessionManager: {
			getSessionId: () => SESSION,
			getBranch: () =>
				(options.referenced ?? []).map((runId) => ({
					type: "custom",
					customType: SUBAGENT_RUN_CUSTOM_ENTRY,
					data: { runId },
				})),
		},
		hasUI: true,
		ui: { notify: (text: string) => notices.push(text) },
	} as unknown as TakeoverContext;
	takeOverRuns(
		{
			agentDir: () => agentDir,
			pane: options.pane,
			scope: { current: () => scope, onBranch: (entryId) => entryId !== "off" },
			admission: {
				adopt: (run) => {
					adopted.push(run.runId);
					scheduler.put({ ...run, sessionEpoch: scope.sessionEpoch });
				},
				recover: (run) => {
					recovered.push(run.runId);
					if (options.unrecoverable?.includes(run.runId)) return false;
					scheduler.put({ ...run, sessionEpoch: scope.sessionEpoch });
					return true;
				},
			},
			scheduler,
			tmux: () => ({
				hasSession: (name) => options.up?.includes(name) ?? false,
				end: (name) => {
					ended.push(name);
				},
			}),
			pullReports: (pulledFor) => pulled.push(pulledFor.sessionEpoch),
			resumeChains: (sessionId) => chains.push(sessionId),
			retellReport: (run) => retold.push({ runId: run.runId, sessionEpoch: run.sessionEpoch }),
		},
		ctx,
	);
	const stored_ = (runId: string) => readPersistedRunRecord(agentDir, SESSION, runId);
	return { scheduler, adopted, recovered, ended, notices, pulled, chains, retold, stored: stored_ };
}

const legacy = (name: string, overrides: Partial<SubagentRunRecord> = {}) =>
	runRecord({ name, backend: undefined, kind: undefined, pane: `pi-${name}`, ...overrides });

describe("Taking a session's runs over as it starts again", () => {
	it("follows each RPC and Pane run Admission takes over, and closes as interrupted one it cannot", () => {
		const s = start(
			[
				runRecord({ name: "working" }),
				runRecord({ name: "queued", status: "starting" }),
				runRecord({ name: "pane", kind: "pane" }),
				runRecord({ name: "lost" }),
				runRecord({ name: "done", status: "closed" }),
			],
			{ unrecoverable: ["sub_lost"] },
		);
		expect(s.recovered.sort()).toEqual(["sub_lost", "sub_pane", "sub_queued", "sub_working"]);
		expect(
			s.scheduler
				.listActiveRuns()
				.map(({ runId }) => runId)
				.sort(),
		).toEqual(["sub_pane", "sub_queued", "sub_working"]);
		expect(s.stored("sub_lost")).toMatchObject({ status: "interrupted", stopReason: "orphaned_on_restart" });
		expect(s.stored("sub_working")?.status).toBe("running");
		expect(s.scheduler.cancelled).toEqual([]);
	});

	it("leaves alone a run this instance runs already", () => {
		const running = runRecord({ name: "mine" });
		const s = start([running], { running: [running] });
		expect(s.recovered).toEqual([]);
		expect(s.stored("sub_mine")?.status).toBe("running");
	});

	it("keeps a stop asked for before, with its source and reason, and stops a run off the branch", () => {
		const s = start([
			runRecord({
				name: "stopping",
				status: "stopping",
				stopSource: "model",
				stopReason: "Stopped by its orchestrator",
			}),
			runRecord({ name: "stopping2", status: "stopping" }),
			runRecord({ name: "elsewhere", originEntryId: "off" }),
		]);
		expect(s.scheduler.cancelled.sort((x, y) => x.runId.localeCompare(y.runId))).toEqual([
			{
				runId: "sub_elsewhere",
				source: "session_invalidated",
				reason: "Originating branch is no longer active after tree navigation",
			},
			{ runId: "sub_stopping", source: "model", reason: "Stopped by its orchestrator" },
			{ runId: "sub_stopping2", source: "user", reason: "Subagent run cancelled" },
		]);
	});

	it("follows a Legacy run on the branch whose pi still runs, and closes the others, ending their panes", () => {
		const s = start(
			[legacy("up"), legacy("gone"), legacy("off", { originEntryId: "off" }), legacy("ended", { status: "closed" })],
			{
				pane: "pi-orchestrator",
				up: ["pi-up", "pi-off"],
			},
		);
		expect(s.adopted).toEqual(["sub_up"]);
		expect(s.recovered).toEqual([]);
		expect(s.stored("sub_up")?.status).toBe("running");
		expect(s.stored("sub_gone")).toMatchObject({
			status: "closed",
			deliveryMode: "background",
			stopReason: "orphaned_on_restart",
		});
		expect(s.stored("sub_off")?.status).toBe("closed");
		expect(s.ended.sort()).toEqual(["pi-gone", "pi-off"]);
		expect(s.notices).toEqual([]);
	});

	it("outside tmux, leaves a Legacy run whose pi still runs running, and says so", () => {
		const s = start([legacy("up"), legacy("gone")], { up: ["pi-up"] });
		expect(s.adopted).toEqual([]);
		expect(s.notices).toEqual([
			`subagents: "up" (sub_up) still run in tmux, from before runs ran on pi's RPC, and this pi has no pane to take them over: they are left running. Open this session in agent view to stop them.`,
		]);
		expect(s.stored("sub_up")?.status).toBe("running");
		expect(s.stored("sub_gone")?.status).toBe("closed");
		expect(s.ended).toEqual(["pi-gone"]);
	});

	it("lists again the finished runs the branch references, which can be resumed, and goes on with Reports and Chains", () => {
		const s = start(
			[
				runRecord({ name: "closed", status: "closed" }),
				runRecord({ name: "stopped", status: "cancelled" }),
				runRecord({ name: "failed", status: "failed" }),
				runRecord({ name: "unreferenced", status: "closed" }),
			],
			{ referenced: ["sub_closed", "sub_stopped", "sub_failed", "sub_unknown"] },
		);
		expect(s.scheduler.reopened).toEqual([
			{ runId: "sub_closed", sessionEpoch: 2 },
			{ runId: "sub_stopped", sessionEpoch: 2 },
		]);
		expect(s.pulled).toEqual([2]);
		expect(s.chains).toEqual([SESSION]);
	});

	it("tells again of the ended members of a Batch that never settled, and of none of a settled one", () => {
		const s = start([
			runRecord({ name: "a1", batch: "batch_open", status: "closed" }),
			runRecord({ name: "a2", batch: "batch_open", status: "failed" }),
			runRecord({ name: "a3", batch: "batch_open" }),
			runRecord({ name: "b1", batch: "batch_settled", status: "closed" }),
		]);
		expect(s.retold.sort((x, y) => x.runId.localeCompare(y.runId))).toEqual([
			{ runId: "sub_a1", sessionEpoch: 2 },
			{ runId: "sub_a2", sessionEpoch: 2 },
		]);
	});
});
