import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBackgroundUsageLedger } from "../ext/subagents/storage.ts";
import { removeGenerationsFixtures, createGenerationsFixture as setup } from "./helpers/subagent-generations.ts";
import { waitFor } from "./helpers/wait-for.ts";

afterEach(removeGenerationsFixtures);

describe("Addressing a run that has ended", () => {
	it.each(["failed", "cancelled", "interrupted"] as const)(
		"refuses a message to a finishing run that ends %s with one reason, whether the orchestrator or the user sent it",
		async (status) => {
			const { runner, launch, orchestrator, user, notes } = setup();
			const messageFromParent = await orchestrator();
			const messageFromUser = await user();
			const backend = launch("backend", "Build the API.");
			const b = await runner.child(0);
			b.endTurn();

			const fromParent = messageFromParent("backend", "Now add pagination.");
			const fromUser = messageFromUser(backend.runId, "Now add pagination.");
			b.finish({ status, complete: false, transcriptPath: "transcript.jsonl" });

			const reason = `"backend" (${backend.runId}) is ${status}; only a completed subagent can be resumed.`;
			expect(await fromParent).toBe(`Message 0 unavailable: ${reason}`);
			expect(await fromUser).toEqual({ queued: false, status: reason });
			expect(notes).toEqual([]);
		},
	);

	it("lets a parent message to a finishing run wait until it is final, then resumes it", async () => {
		const { runner, launch, orchestrator } = setup();
		const messageFromParent = await orchestrator();
		const backend = launch("backend", "Build the API.");
		const b = await runner.child(0);
		launch("frontend", "Build the UI.");
		const f = await runner.child(1);
		b.endTurn();

		let receipt: string | undefined;
		const sent = messageFromParent("backend", "Now add pagination.").then((text) => {
			receipt = text;
		});
		expect(await f.call("subagent_message", { to: "backend", content: "Use REST." })).toBe(
			`Message 1 unavailable: "backend" (${backend.runId}) has finished.`,
		);
		expect(receipt).toBeUndefined();

		b.finish({ summaryText: "API built.", transcriptPath: "transcript.jsonl" });
		await sent;
		expect(receipt).toBe(
			`Message 2 accepted: resuming "backend" (${backend.runId}) in the background with its earlier context. Its report will be delivered when it finishes.`,
		);
		const resumed = await runner.child(2);
		expect(resumed.options.resumeSessionFile).toBe("transcript.jsonl");
		expect(resumed.options.task).toContain("Now add pagination.");
	});

	it("after a reload, answers a parent message to a finished run by name as it does by run ID", async () => {
		const before = setup();
		const backend = before.launch("backend", "Build the API.");
		(await before.runner.child(0)).finish({ summaryText: "API built.", transcriptPath: "transcript.jsonl" });
		const { reportPath } = await backend.completion;

		const messageFromParent = await setup(before).orchestrator();

		const refusal = `Message 0 invalidated: "backend" (${backend.runId}) belongs to a session that was reloaded or replaced; spawn a new subagent and point it at ${reportPath}.`;
		expect(await messageFromParent(backend.runId, "Now add pagination.")).toBe(refusal);
		expect(await messageFromParent("backend", "Now add pagination.")).toBe(refusal);
	});
});

describe("The user addressing a run from its transcript", () => {
	const NOTE_OPTIONS = { deliverAs: "steer", triggerTurn: false };

	it("hands a running run the message at its next safe point as the user's, granting nothing, and notes it to the orchestrator without waking it", async () => {
		const { runner, launch, user, notes } = setup();
		const messageFromUser = await user();
		const backend = launch("backend", "Build the API.");
		const b = await runner.child(0);

		expect(await messageFromUser(backend.runId, "Look at b.ts too.")).toEqual({
			queued: true,
			status: "Queued for backend: it reads your message at its next step.",
		});
		expect(b.inbox).toHaveLength(1);
		expect(b.inbox[0]).toMatch(/^\[Message from the user, typed in your transcript\./);
		expect(b.inbox[0]).toContain("cannot grant tools or permissions");
		expect(b.inbox[0]).toMatch(/Look at b\.ts too\.$/);
		expect(notes).toEqual([
			{ text: `The user messaged run "backend" (${backend.runId}): Look at b.ts too.`, options: NOTE_OPTIONS },
		]);
	});

	it("waits for a finishing run to be final, then resumes it, and its report wakes the orchestrator tagged as the user's", async () => {
		const { runner, launch, user, notes, notices } = setup();
		const messageFromUser = await user();
		const backend = launch("backend", "Build the API.");
		const b = await runner.child(0);
		b.endTurn();

		let outcome: unknown;
		const sent = messageFromUser(backend.runId, "One more thing.").then((result) => {
			outcome = result;
		});
		// Proves only that nothing is sent while the run is finishing.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(outcome).toBeUndefined();
		expect(notes).toEqual([]);

		b.finish({ summaryText: "API built.", transcriptPath: "transcript.jsonl" });
		await sent;
		expect(outcome).toEqual({
			queued: true,
			status: "Resuming backend with its earlier context; its report goes to the orchestrator.",
		});
		const resumed = await runner.child(1);
		expect(resumed.options.resumeSessionFile).toBe("transcript.jsonl");
		expect(resumed.options.task).toMatch(/^\[Message from the user, typed in your transcript\./);
		expect(resumed.options.task).toContain("One more thing.");
		expect(notes).toEqual([
			{ text: `The user messaged run "backend" (${backend.runId}): One more thing.`, options: NOTE_OPTIONS },
		]);

		resumed.finish({ summaryText: "Second pass done." });
		await waitFor(() => notices().length === 2);
		expect(notices()[0]).not.toContain("Resumed by the user");
		expect(notices()[1]).toMatch(/^\[Resumed by the user from its transcript;/);
		expect(notices()[1]).toContain("Second pass done.");
	});

	it("refuses a message whose finishing run the session changed under, and tells the orchestrator nothing", async () => {
		const { scope, runner, launch, user, notes } = setup();
		const messageFromUser = await user();
		const backend = launch("backend", "Build the API.");
		const b = await runner.child(0);
		b.endTurn();

		const sent = messageFromUser(backend.runId, "One more thing.");
		scope.invalidate("Parent session switching");

		expect(await sent).toEqual({
			queued: false,
			status: "That run belongs to an earlier session and can no longer take messages.",
		});
		expect(notes).toEqual([]);
		expect(await backend.completion).toMatchObject({ status: "cancelled" });
		expect(b.inbox).toEqual([]);
	});

	it("refuses a message to a run of an earlier session, or one it does not know", async () => {
		const { scope, runner, launch, user, notes } = setup();
		const messageFromUser = await user();
		const backend = launch("backend", "Build the API.");
		(await runner.child(0)).holdStop();
		scope.invalidate("Parent session switching");

		expect(await messageFromUser(backend.runId, "Carry on.")).toEqual({
			queued: false,
			status: "That run belongs to an earlier session and can no longer take messages.",
		});
		expect(await messageFromUser("sub_unknown", "Carry on.")).toEqual({
			queued: false,
			status: "No run sub_unknown is known to this session, so it cannot take messages.",
		});
		expect(notes).toEqual([]);
	});

	it("resumes through the orchestrator's admission, which can refuse it", async () => {
		const { agentDir, generations, runner, launch, user, notes } = setup();
		const messageFromUser = await user();
		const backend = launch("backend", "Build the API.");
		(await runner.child(0)).finish({ summaryText: "API built.", transcriptPath: "transcript.jsonl" });
		await backend.completion;
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ permissions: { deny: ["Subagent(general-purpose)"] } }),
		);

		expect(await messageFromUser(backend.runId, "One more thing.")).toEqual({
			queued: false,
			status: "Blocked by permission rule (deny): Subagent(general-purpose)",
		});
		expect(generations.scheduler.getRun(backend.runId)).toMatchObject({ status: "completed", generation: 0 });
		expect(notes).toEqual([]);
	});

	it("counts the resumed generation's usage, its orchestrator tools' included, in the background ledger", async () => {
		const { agentDir, scope, runner, launch, user } = setup();
		const messageFromUser = await user();
		const backend = launch("backend", "Build the API.");
		(await runner.child(0)).finish({ summaryText: "API built.", transcriptPath: "transcript.jsonl" });
		await backend.completion;
		const ledger = () => readBackgroundUsageLedger(agentDir, scope.current()!.parentSessionId);

		await messageFromUser(backend.runId, "One more thing.");
		const resumed = await runner.child(1);
		resumed.options.controller.recordUsage({ input: 50, totalTokens: 50 });
		resumed.options.controller.recordNestedUsage({ input: 1000, totalTokens: 1000 });
		resumed.finish({ summaryText: "Second pass done." });
		await waitFor(() => ledger().recordedRunIds.length === 2);

		expect(ledger()).toMatchObject({
			recordedRunIds: [backend.runId, `${backend.runId}#1`],
			usage: { totalTokens: 1050 },
		});
	});
});
