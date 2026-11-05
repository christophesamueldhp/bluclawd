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
		changes: 0,
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
		onChange: () => {
			world.changes++;
		},
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

	it("awaits every open Run that is working, and is Waiting for them between turns", () => {
		const { launch, views, world, scheduler, controllers } = setup();
		const live = launch();
		const foreground = launch({ deliveryMode: "foreground" });
		const stopping = launch();
		const idle = launch();
		const asking = launch();
		controllers.get(live.runId)?.markRunning();
		controllers.get(foreground.runId)?.updateActivity("working");
		scheduler.cancelRun(stopping.runId, "user");
		controllers.get(idle.runId)?.updateActivity("idle");
		controllers.get(asking.runId)?.updateActivity("awaiting_input");

		expect(ids(views.awaited())).toEqual([live.runId, foreground.runId]);
		expect(views.waitingFor()).toBe(2);
		expect(views.footer()).toEqual({ running: 4, stopping: 1 });
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
		"hides a Run dismissed from the %s until it is resumed, then shows its new Generation and lists its second finish",
		async (from) => {
			const { launch, finish, views, scheduler } = setup();
			const run = launch();
			await finish(run.runId);
			expect(views.dismiss(from, run.runId)).toBe(true);
			expect(views.panel()).toEqual([]);

			scheduler.resume(run.runId, {});
			expect(ids(views.panel())).toEqual([run.runId]);
			expect(views.waitingFor()).toBe(1);

			await finish(run.runId);
			expect(ids(views.panel())).toEqual([run.runId]);
			expect(ids(views.done())).toEqual([run.runId]);
		},
	);

	it("hides a Run dismissed from /tasks from the panel too, and one dismissed from the panel only there", async () => {
		const { launch, finish, views } = setup();
		const fromTasks = launch();
		const fromPanel = launch();
		await finish(fromTasks.runId);
		await finish(fromPanel.runId);

		views.dismiss("tasks", fromTasks.runId);
		views.dismiss("panel", fromPanel.runId);
		expect(views.panel()).toEqual([]);
		expect(ids(views.done())).toEqual([fromPanel.runId]);
	});

	it("dismisses only a final Run the surface shows, and signals each dismissal at once", async () => {
		const { launch, finish, views, world } = setup();
		const live = launch();
		const done = launch();
		const otherSession = launch({ parentSessionId: "sess_other" });
		await finish(done.runId);
		await finish(otherSession.runId);

		expect(views.dismiss("panel", live.runId)).toBe(false);
		expect(views.dismiss("tasks", live.runId)).toBe(false);
		expect(views.dismiss("tasks", otherSession.runId)).toBe(false);
		expect(views.dismiss("tasks", otherSession.runId, "sess_other")).toBe(false);
		expect(views.dismiss("tasks", "sub_missing")).toBe(false);
		expect(world.changes).toBe(0);

		expect(views.dismiss("panel", done.runId)).toBe(true);
		expect(world.changes).toBe(1);
		expect(views.dismiss("panel", done.runId)).toBe(false);
		expect(views.dismiss("tasks", done.runId, "sess_main")).toBe(true);
		expect(world.changes).toBe(2);
		expect(views.dismiss("tasks", done.runId)).toBe(false);
		expect(world.changes).toBe(2);
	});

	it("lists as Done the final Runs this instance ran in the current scope that /tasks did not dismiss", async () => {
		const { agentDir, launch, finish, views, scheduler } = setup();
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
		views.dismiss("tasks", dismissedFromTasks.runId);
		views.dismiss("panel", dismissedFromPanel.runId);

		expect(ids(views.done())).toEqual([kept.runId, dismissedFromPanel.runId]);
		expect(ids(views.done("sess_main"))).toEqual([kept.runId, dismissedFromPanel.runId]);
		expect(views.done("sess_other")).toEqual([]);
	});

	it("looks a Run up for /tasks by its owner, whatever its epoch, or on disk when this instance never ran it", async () => {
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
		// An earlier epoch's Run is found as it is after a restart, from disk: only the owner is checked.
		expect(views.lookup(earlierEpoch.runId)?.record.runId).toBe(earlierEpoch.runId);
		expect(views.lookup(otherSession.runId)).toBeUndefined();
		expect(views.lookup(otherSession.runId, "sess_other")?.record.runId).toBe(otherSession.runId);
		expect(views.lookup("sub_from_disk")).toMatchObject({ record: { runId: "sub_from_disk" }, state: "finished" });
		expect(views.lookup("sub_from_disk", "sess_other")).toBeUndefined();
		expect(views.lookup("sub_missing")).toBeUndefined();
	});

	it("lets stop all reach every open Run of the owner's scope", () => {
		const { launch, views, scheduler, controllers } = setup();
		const starting = launch();
		const live = launch();
		const stopping = launch();
		launch({ sessionEpoch: 0 });
		controllers.get(live.runId)?.markRunning();
		scheduler.cancelRun(stopping.runId, "user");

		expect(ids(views.stoppable())).toEqual([starting.runId, live.runId, stopping.runId]);
		expect(views.stoppable("sess_other")).toEqual([]);
	});

	it("finds an open Run by name or run id", async () => {
		const { launch, finish, views } = setup();
		const scout = launch({ name: "scout" });
		const done = launch({ name: "done" });
		launch({ name: "old", sessionEpoch: 0 });
		await finish(done.runId);

		expect(views.findOpen("scout")?.record.runId).toBe(scout.runId);
		expect(views.findOpen(scout.runId)?.record.runId).toBe(scout.runId);
		expect(views.findOpen("done")).toBeUndefined();
		expect(views.findOpen("old")).toBeUndefined();
	});
});
