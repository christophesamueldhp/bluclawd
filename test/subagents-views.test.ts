import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunDirectory } from "../ext/subagents/directory.ts";
import type { ParentScope } from "../ext/subagents/parent-scope.ts";
import { type SubagentRunController, type SubagentRunOutcome, SubagentRunScheduler } from "../ext/subagents/runs.ts";
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
	const settle = new Map<string, (outcome: SubagentRunOutcome) => void>();
	const scheduler = new SubagentRunScheduler<{ resume?: { toolCallId: string } }>({
		executeRun: ({ record, controller, signal }) => {
			controllers.set(record.runId, controller);
			return new Promise<SubagentRunOutcome>((resolve) => {
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
		expect(views.footer()).toEqual({ running: 4, closing: 1 });
		world.idle = false;
		expect(views.waitingFor()).toBe(0);
	});

	it("hides a Run dismissed from /tasks until it is resumed, then lists its second finish", async () => {
		const { launch, finish, views, scheduler } = setup();
		const run = launch();
		await finish(run.runId);
		expect(views.dismiss(run.runId)).toBe(true);
		expect(views.done()).toEqual([]);

		scheduler.resume(run.runId, {});
		expect(ids(views.open())).toEqual([run.runId]);
		expect(views.waitingFor()).toBe(1);

		await finish(run.runId);
		expect(views.open()).toEqual([]);
		expect(ids(views.done())).toEqual([run.runId]);
	});

	it("dismisses only a final Run /tasks lists, and signals each dismissal at once", async () => {
		const { launch, finish, views, world } = setup();
		const live = launch();
		const done = launch();
		const otherSession = launch({ parentSessionId: "sess_other" });
		await finish(done.runId);
		await finish(otherSession.runId);

		expect(views.dismiss(live.runId)).toBe(false);
		expect(views.dismiss(otherSession.runId)).toBe(false);
		expect(views.dismiss(otherSession.runId, "sess_other")).toBe(false);
		expect(views.dismiss("sub_missing")).toBe(false);
		expect(world.changes).toBe(0);

		expect(views.dismiss(done.runId, "sess_main")).toBe(true);
		expect(world.changes).toBe(1);
		expect(views.dismiss(done.runId)).toBe(false);
		expect(world.changes).toBe(1);
	});

	it("lists as Done the final Runs this instance ran in the current scope that /tasks did not dismiss", async () => {
		const { agentDir, launch, finish, views, scheduler } = setup();
		launch();
		const kept = launch();
		const dismissed = launch();
		const earlierEpoch = launch({ sessionEpoch: 0 });
		const otherSession = launch({ parentSessionId: "sess_other" });
		for (const run of [kept, dismissed, earlierEpoch, otherSession]) {
			await finish(run.runId);
		}
		const stored = scheduler.getRun(kept.runId);
		if (!stored) throw new Error("no record");
		writePersistedRunRecord(agentDir, { ...stored, runId: "sub_from_disk" });
		views.dismiss(dismissed.runId);

		expect(ids(views.done())).toEqual([kept.runId]);
		expect(ids(views.done("sess_main"))).toEqual([kept.runId]);
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

	it("lets close all reach every open Run of the owner's scope", () => {
		const { launch, views, scheduler, controllers } = setup();
		const starting = launch();
		const live = launch();
		const stopping = launch();
		launch({ sessionEpoch: 0 });
		controllers.get(live.runId)?.markRunning();
		scheduler.cancelRun(stopping.runId, "user");

		expect(ids(views.closable())).toEqual([starting.runId, live.runId, stopping.runId]);
		expect(views.closable("sess_other")).toEqual([]);
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
