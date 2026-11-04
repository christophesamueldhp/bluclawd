import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunDirectory } from "../ext/subagents/directory.ts";
import type { ParentScope } from "../ext/subagents/parent-scope.ts";
import { type SubagentRunController, type SubagentRunnerOutcome, SubagentRunScheduler } from "../ext/subagents/runs.ts";
import { writePersistedRunRecord } from "../ext/subagents/storage.ts";
import { createParentScopeViews } from "../ext/subagents/views.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The views over a real scheduler whose Runs wait until the test settles them. */
function setup() {
	const agentDir = mkdtempSync(join(tmpdir(), "bluclawd-views-"));
	tempDirs.push(agentDir);
	const controllers = new Map<string, SubagentRunController>();
	const settle = new Map<string, (outcome: SubagentRunnerOutcome) => void>();
	const scheduler = new SubagentRunScheduler<{ resume?: { toolCallId: string } }>({
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
	const world = {
		scope: { parentSessionId: "sess_main", sessionEpoch: 1 } as ParentScope | undefined,
		idle: true,
		now: 0,
		dismissedFromPanel: new Map<string, number>(),
		dismissedFromTasks: new Map<string, number>(),
	};
	const launch = (
		options: {
			parentSessionId?: string;
			sessionEpoch?: number;
			deliveryMode?: "foreground" | "background";
			toolCallId?: string;
			name?: string;
		} = {},
	) => {
		const admitted = scheduler.admit({
			parentSessionId: options.parentSessionId ?? "sess_main",
			sessionEpoch: options.sessionEpoch ?? 1,
			parentTurnId: "turn_1",
			originToolCallId: options.toolCallId ?? `call_${Math.random().toString(36).slice(2, 8)}`,
			name: options.name,
			agentName: "explorer",
			definitionSource: "bundled",
			provider: "faux",
			modelId: "faux-1",
			thinkingLevel: "low",
			cwd: "/proj",
			taskSummary: "Scan auth",
			deliveryMode: options.deliveryMode ?? "background",
		});
		if (!admitted.ok) throw new Error(admitted.error);
		return admitted.handle;
	};
	/** Settles a Run with `status` at the clock's current time. */
	const finish = async (runId: string, status: "completed" | "failed" = "completed") => {
		settle.get(runId)?.({ status, complete: status === "completed", summaryText: status });
		await scheduler.whenFinal(runId);
	};
	const views = createParentScopeViews({
		scheduler,
		directory: createRunDirectory({ scheduler, agentDir: () => agentDir }),
		agentDir: () => agentDir,
		scope: () => world.scope,
		idle: () => world.idle,
		now: () => world.now,
		dismissed: { panel: world.dismissedFromPanel, tasks: world.dismissedFromTasks },
	});
	return { agentDir, scheduler, controllers, world, launch, finish, views };
}

const ids = (entries: readonly { record: { runId: string } }[]) => entries.map((entry) => entry.record.runId);

describe("the Parent scope's views", () => {
	it("shows open only the Runs of the current Parent scope that are not final", async () => {
		const { launch, finish, views, world } = setup();
		const mine = launch();
		launch({ parentSessionId: "sess_other" });
		launch({ sessionEpoch: 0 });
		const done = launch();
		await finish(done.runId);

		expect(ids(views.open())).toEqual([mine.runId]);
		world.scope = undefined;
		expect(views.open()).toEqual([]);
	});

	it("awaits every open Run but a stopping one, and is Waiting only for the background ones between turns", () => {
		const { launch, views, world, scheduler, controllers } = setup();
		const live = launch();
		const finishing = launch();
		const foreground = launch({ deliveryMode: "foreground" });
		const stopping = launch();
		controllers.get(live.runId)?.markRunning();
		controllers.get(finishing.runId)?.markFinishing();
		scheduler.cancelRun(stopping.runId, "user");

		expect(ids(views.awaited())).toEqual([live.runId, finishing.runId, foreground.runId]);
		expect(views.waitingFor()).toBe(2);
		expect(views.footer()).toEqual({ running: 3, stopping: 1 });
		world.idle = false;
		expect(views.waitingFor()).toBe(0);
	});

	it("keeps a Run that succeeded in the panel for 30 seconds after it ends, and any other final Run for good", async () => {
		const { launch, finish, views, world, scheduler } = setup();
		const live = launch();
		const succeeded = launch();
		const failed = launch();
		const stopped = launch();
		launch({ sessionEpoch: 0 });
		await finish(succeeded.runId);
		await finish(failed.runId, "failed");
		scheduler.cancelRun(stopped.runId, "user");
		await scheduler.whenFinal(stopped.runId);
		const endedAt = scheduler.getRun(succeeded.runId)?.endedAt ?? 0;

		world.now = endedAt + 29_999;
		expect(ids(views.panel())).toEqual([live.runId, succeeded.runId, failed.runId, stopped.runId]);
		world.now = endedAt + 30_000;
		expect(ids(views.panel())).toEqual([live.runId, failed.runId, stopped.runId]);
		world.now = endedAt + 60 * 60_000;
		expect(ids(views.panel())).toEqual([live.runId, failed.runId, stopped.runId]);
	});

	it.each(["panel", "tasks"] as const)(
		"hides a Run dismissed from the %s until it is resumed, then shows its new Generation",
		async (from) => {
			const { launch, finish, views, world, scheduler } = setup();
			const run = launch();
			await finish(run.runId);
			(from === "panel" ? world.dismissedFromPanel : world.dismissedFromTasks).set(run.runId, 0);
			expect(views.panel()).toEqual([]);

			scheduler.resume(run.runId, {});
			expect(ids(views.panel())).toEqual([run.runId]);
		},
	);

	it("lists as Done the final Runs this instance ran in the current scope that /tasks did not dismiss", async () => {
		const { agentDir, launch, finish, views, world, scheduler } = setup();
		launch();
		const kept = launch();
		const dismissedFromTasks = launch();
		const dismissedFromPanel = launch();
		const earlierEpoch = launch({ sessionEpoch: 0 });
		const otherSession = launch({ parentSessionId: "sess_other" });
		for (const run of [kept, dismissedFromTasks, dismissedFromPanel, earlierEpoch, otherSession]) {
			await finish(run.runId);
		}
		const stored = scheduler.getRun(kept.runId);
		if (!stored) throw new Error("no record");
		writePersistedRunRecord(agentDir, { ...stored, runId: "sub_from_disk" });
		world.dismissedFromTasks.set(dismissedFromTasks.runId, 0);
		world.dismissedFromPanel.set(dismissedFromPanel.runId, 0);

		expect(ids(views.done())).toEqual([kept.runId, dismissedFromPanel.runId]);
		expect(ids(views.done("sess_main"))).toEqual([kept.runId, dismissedFromPanel.runId]);
		expect(views.done("sess_other")).toEqual([]);
	});

	it("looks a Run up for /tasks in the owner's current scope, or on disk when this instance never ran it", async () => {
		const { agentDir, launch, finish, views, scheduler } = setup();
		const mine = launch();
		const earlierEpoch = launch({ sessionEpoch: 0 });
		const otherSession = launch({ parentSessionId: "sess_other" });
		await finish(mine.runId);
		const stored = scheduler.getRun(mine.runId);
		if (!stored) throw new Error("no record");
		writePersistedRunRecord(agentDir, { ...stored, runId: "sub_from_disk" });

		expect(views.lookup(mine.runId)?.record.runId).toBe(mine.runId);
		expect(views.lookup(mine.runId, "sess_main")?.record.runId).toBe(mine.runId);
		expect(views.lookup(earlierEpoch.runId)).toBeUndefined();
		expect(views.lookup(otherSession.runId)).toBeUndefined();
		expect(views.lookup(otherSession.runId, "sess_other")).toBeUndefined();
		expect(views.lookup("sub_from_disk")).toMatchObject({ record: { runId: "sub_from_disk" }, state: "finished" });
		expect(views.lookup("sub_from_disk", "sess_other")).toBeUndefined();
		expect(views.lookup("sub_missing")).toBeUndefined();
	});

	it("lets stop all reach every open Run of the owner's scope but a finishing one", () => {
		const { launch, views, scheduler, controllers } = setup();
		const starting = launch();
		const live = launch();
		const finishing = launch();
		const stopping = launch();
		launch({ sessionEpoch: 0 });
		controllers.get(live.runId)?.markRunning();
		controllers.get(finishing.runId)?.markFinishing();
		scheduler.cancelRun(stopping.runId, "user");

		expect(ids(views.stoppable())).toEqual([starting.runId, live.runId, stopping.runId]);
		expect(views.stoppable("sess_other")).toEqual([]);
	});

	it("finds an open Run by name or run id, and the open Run a tool call launched or resumed", async () => {
		const { launch, finish, views, scheduler } = setup();
		const scout = launch({ name: "scout", toolCallId: "call_scout" });
		const resumed = launch({ name: "mapper", toolCallId: "call_mapper" });
		const done = launch({ name: "done", toolCallId: "call_done" });
		launch({ name: "old", toolCallId: "call_old", sessionEpoch: 0 });
		await finish(resumed.runId);
		await finish(done.runId);
		scheduler.resume(resumed.runId, { resume: { toolCallId: "call_more" } });

		expect(views.findOpen("scout")?.record.runId).toBe(scout.runId);
		expect(views.findOpen(scout.runId)?.record.runId).toBe(scout.runId);
		expect(views.findOpen("done")).toBeUndefined();
		expect(views.findOpen("old")).toBeUndefined();

		expect(views.launchedBy("call_scout")?.runId).toBe(scout.runId);
		expect(views.launchedBy("call_more")?.runId).toBe(resumed.runId);
		expect(views.launchedBy("call_mapper")).toBeUndefined();
		expect(views.launchedBy("call_done")).toBeUndefined();
		expect(views.launchedBy("call_old")).toBeUndefined();
	});
});
