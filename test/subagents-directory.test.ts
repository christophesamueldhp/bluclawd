import { afterEach, describe, expect, it } from "vitest";
import {
	fakeSessionContext,
	removeGenerationsFixtures,
	createGenerationsFixture as setup,
} from "./helpers/subagent-generations.ts";

afterEach(removeGenerationsFixtures);

describe("The run directory", () => {
	it("calls a run whose last turn ended finishing everywhere, and keeps its name until it is final", async () => {
		const { scope, directory, tasks, runner, launch } = setup();
		const backend = launch("backend", "Build the API.");
		const b = await runner.child(0);
		launch("frontend", "Build the UI.");
		const f = await runner.child(1);

		b.endTurn();

		expect(directory.find(scope.current()!, "backend")).toMatchObject({ state: "finishing" });
		expect(tasks.get(backend.runId)).toMatchObject({ state: "running", status: "finishing" });
		expect(tasks.stop(backend.runId)).toMatchObject({ ok: false, reason: "not_running" });
		expect(await f.call("subagent_roster", {})).not.toContain("backend");
		expect(await f.call("subagent_message", { to: "backend", content: "Use REST." })).toBe(
			`Message 1 unavailable: "backend" (${backend.runId}) has finished.`,
		);
		expect(directory.nameHolder(scope.current()!, "backend")?.record.runId).toBe(backend.runId);

		b.finish({ summaryText: "API built." });
		expect(await backend.completion).toMatchObject({ status: "completed" });
		expect(directory.find(scope.current()!, "backend")).toMatchObject({ state: "finished" });
		expect(directory.nameHolder(scope.current()!, "backend")).toBeUndefined();
	});

	it("keeps a run whose turn pi will retry reachable by a message and stoppable", async () => {
		const { tasks, runner, launch } = setup();
		const backend = launch("backend", "Build the API.");
		const b = await runner.child(0);
		b.holdStop();
		launch("frontend", "Build the UI.");
		const f = await runner.child(1);

		b.endTurn(true);

		expect(await f.call("subagent_roster", {})).toContain("backend");
		expect(await f.call("subagent_message", { to: "backend", content: "Use REST." })).toBe(
			`Message 1 accepted for delivery to backend (${backend.runId}) (not yet handled).`,
		);
		expect(b.inbox).toHaveLength(1);
		expect(tasks.stop(backend.runId)).toMatchObject({ ok: true, task: { status: "stopping" } });
	});

	it("offers a name for reuse as soon as its run is final", async () => {
		const { runner, launch } = setup();
		const first = launch("backend", "Build the API.");
		const b1 = await runner.child(0);
		launch("frontend", "Build the UI.");
		const f = await runner.child(1);
		b1.finish({ summaryText: "API built." });
		await first.completion;

		const second = launch("backend", "Add pagination.");
		const b2 = await runner.child(2);
		expect(await f.call("subagent_message", { to: "backend", content: "Page size 50." })).toBe(
			`Message 1 accepted for delivery to backend (${second.runId}) (not yet handled).`,
		);
		expect(b2.inbox).toHaveLength(1);
	});

	it("tells a sibling that a stopping run is stopping, and never offers it as reachable", async () => {
		const { scope, generations, directory, runner, launch } = setup();
		const backend = launch("backend", "Build the API.");
		const b = await runner.child(0);
		b.holdStop();
		launch("frontend", "Build the UI.");
		const f = await runner.child(1);

		generations.scheduler.cancelRun(backend.runId, "model", "No longer needed.");

		expect(directory.find(scope.current()!, "backend")).toMatchObject({ state: "stopping" });
		expect(await f.call("subagent_roster", {})).not.toContain("backend");
		expect(await f.call("subagent_message", { to: "backend", content: "Use REST." })).toBe(
			`Message 1 unavailable: "backend" (${backend.runId}) is stopping.`,
		);
		expect(await f.call("subagent_message", { to: "nobody", content: "?" })).toBe(
			'Message 2 unavailable: No running agent "nobody" is reachable. Reachable now: parent.',
		);
		expect(b.inbox).toEqual([]);
	});

	it("hides the runs of an earlier session epoch and frees their names", async () => {
		const { scope, directory, tasks, runner, launch } = setup();
		const old = launch("backend", "Build the API.");
		(await runner.child(0)).holdStop();

		scope.invalidate("Parent session reloading");
		const current = scope.current()!;
		expect(directory.find(current, "backend")).toBeUndefined();
		expect(directory.nameHolder(current, "backend")).toBeUndefined();
		expect(tasks.list()).toEqual([]);

		const fresh = launch("backend", "Rebuild the API.");
		const b = await runner.child(1);
		launch("frontend", "Build the UI.");
		const f = await runner.child(2);
		expect(b.options.task).toBe("Rebuild the API.");
		expect(await f.call("subagent_roster", {})).not.toContain(old.runId);
		expect(directory.list(current).map((entry) => entry.record.runId)).not.toContain(old.runId);
		expect(await f.call("subagent_message", { to: "backend", content: "Use REST." })).toBe(
			`Message 1 accepted for delivery to backend (${fresh.runId}) (not yet handled).`,
		);
	});

	it("keeps names apart per parent session, so a new session's name never takes over an earlier one's", async () => {
		const { cwd, scope, directory, runner, launch } = setup();
		const earlier = launch("backend", "Build the API.");
		(await runner.child(0)).holdStop();
		launch("frontend", "Build the UI.");
		const earlierFrontend = await runner.child(1);
		earlierFrontend.holdStop();

		scope.enter(fakeSessionContext(cwd), "Session replaced (new)");
		const later = launch("backend", "Build another API.");
		await runner.child(2);

		expect(directory.find(scope.current()!, "backend")?.record.runId).toBe(later.runId);
		expect(await earlierFrontend.call("subagent_message", { to: "backend", content: "Use REST." })).toBe(
			`Message 1 unavailable: "backend" (${earlier.runId}) is stopping.`,
		);
	});

	it("lists the same agents in a child's first prompt, its roster and the reachable list", async () => {
		const { generations, runner, launch } = setup();
		const backend = launch("backend", "Build the API.");
		const b = await runner.child(0);
		b.options.controller.markRunning("child_backend");
		launch("docs", "Write the docs.");
		(await runner.child(1)).endTurn();
		const ops = launch("ops", "Deploy.");
		const o = await runner.child(2);
		o.holdStop();
		generations.scheduler.cancelRun(ops.runId, "model", "No longer needed.");

		const tester = launch("tester", "Run the tests.");
		const t = await runner.child(3);

		const backendLine = `- backend (general-purpose, ${backend.runId}, running): Build the API.`;
		expect(t.options.task).toBe(
			[
				"Run the tests.",
				"",
				"## Agents working now",
				backendLine,
				"Coordinate with them through subagent_message; subagent_roster shows the current list.",
			].join("\n"),
		);
		expect(await t.call("subagent_roster", {})).toBe(
			[
				"- parent: the orchestrator",
				backendLine,
				`- tester (general-purpose, ${tester.runId}, starting): Run the tests. (you)`,
			].join("\n"),
		);
		expect(await t.call("subagent_message", { to: "nobody", content: "?" })).toBe(
			`Message 1 unavailable: No running agent "nobody" is reachable. Reachable now: parent, backend (${backend.runId}).`,
		);
	});
});
