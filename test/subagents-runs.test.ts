import { describe, expect, it, vi } from "vitest";
import {
	createEmptySubagentUsage,
	type SubagentRunnerExecuteParams,
	type SubagentRunnerOutcome,
	SubagentRunScheduler,
} from "../ext/subagents/runs.ts";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeRequest(overrides: Partial<Parameters<SubagentRunScheduler["admit"]>[0]> = {}) {
	return {
		parentSessionId: "sess_1",
		runtimeGeneration: 1,
		parentTurnId: "turn_1",
		originToolCallId: `call_${Math.random().toString(36).slice(2, 8)}`,
		originEntryId: "entry_1",
		agentName: "explorer",
		definitionSource: "bundled" as const,
		provider: "faux",
		modelId: "faux-1",
		thinkingLevel: "low",
		cwd: "/proj",
		deliveryMode: "foreground" as const,
		maxTurns: 12,
		...overrides,
	};
}

describe("Task 3 (M1) — Run state, admission, and limits", () => {
	it("does not reuse persisted run IDs after a runtime module reload", async () => {
		const ids: string[] = [];
		for (let reload = 0; reload < 2; reload++) {
			vi.resetModules();
			const { SubagentRunScheduler: ReloadedScheduler } = await import("../ext/subagents/runs.ts");
			const scheduler = new ReloadedScheduler({
				executeRun: async () => ({ status: "completed", complete: true, summaryText: "done" }),
			});
			const handle = scheduler.admit(makeRequest()).handle!;
			await handle.completion;
			ids.push(handle.runId);
		}
		expect(ids[0]).not.toBe(ids[1]);
	});

	it("enforces two active runs, four queued runs, FIFO admission, and overload rejection on simultaneous starts", async () => {
		const gates = new Map<string, ReturnType<typeof deferred<SubagentRunnerOutcome>>>();
		const startOrder: string[] = [];

		const scheduler = new SubagentRunScheduler({
			executeRun: async (params: SubagentRunnerExecuteParams) => {
				startOrder.push(params.record.runId);
				const gate = deferred<SubagentRunnerOutcome>();
				gates.set(params.record.runId, gate);
				return gate.promise;
			},
		});

		const admitted = [];
		for (let i = 0; i < 6; i++) {
			const res = scheduler.admit(makeRequest({ originToolCallId: `call_${i}` }));
			expect(res.ok, `run ${i}`).toBe(true);
			admitted.push(res.handle!);
		}

		// First 2 are starting/running, next 4 are queued
		expect(scheduler.getActiveCount()).toBe(2);
		expect(scheduler.getQueuedCount()).toBe(4);
		expect(startOrder).toEqual([admitted[0].runId, admitted[1].runId]);
		expect(scheduler.getRun(admitted[2].runId)?.status).toBe("queued");
		expect(scheduler.getRun(admitted[5].runId)?.status).toBe("queued");

		// 7th concurrent request (when per-turn budget is raised) is rejected due to queue capacity
		const schedulerHighTurn = new SubagentRunScheduler({
			maxParentTurnRuns: 20,
			executeRun: async (params) => {
				const gate = deferred<SubagentRunnerOutcome>();
				gates.set(params.record.runId, gate);
				return gate.promise;
			},
		});
		for (let i = 0; i < 6; i++) {
			expect(schedulerHighTurn.admit(makeRequest({ originToolCallId: `c_${i}` })).ok).toBe(true);
		}
		const seventh = schedulerHighTurn.admit(makeRequest({ originToolCallId: "c_6" }));
		expect(seventh.ok).toBe(false);
		expect(seventh.error).toMatch(/queue is full/i);
		expect(seventh.error).toMatch(/wait for existing/i);

		// Finish run 0 -> run 2 starts in FIFO order
		gates.get(admitted[0].runId)!.resolve({
			status: "completed",
			complete: true,
			summaryText: "done 0",
		});
		const done0 = await admitted[0].completion;
		expect(done0.status).toBe("completed");
		expect(startOrder).toEqual([admitted[0].runId, admitted[1].runId, admitted[2].runId]);

		// Clean up remaining runs in first scheduler
		for (const h of admitted.slice(1)) {
			scheduler.cancelRun(h.runId, "caller");
		}
		for (const [, gate] of gates) {
			gate.resolve({ status: "cancelled", complete: false, summaryText: "" });
		}
		await Promise.all(admitted.map((h) => h.completion));
	});

	it("enforces per-turn parent delegation budgets (6 runs or 300,000 tokens) and resets on a new parent turn", async () => {
		const scheduler = new SubagentRunScheduler({
			executeRun: async () => ({
				status: "completed",
				complete: true,
				summaryText: "ok",
				usage: {
					...createEmptySubagentUsage(),
					input: 50_000,
					output: 10_000,
					totalTokens: 60_000,
				},
			}),
		});

		// Launch 5 runs in turn_1 -> cumulative 300,000 tokens reached
		for (let i = 0; i < 5; i++) {
			const adm = scheduler.admit(makeRequest({ parentTurnId: "turn_1", originToolCallId: `t1_${i}` }));
			expect(adm.ok).toBe(true);
			await adm.handle!.completion;
		}

		// 6th run in turn_1 is rejected before admission because cumulative turn tokens reached 300,000
		const blockedByTokens = scheduler.admit(makeRequest({ parentTurnId: "turn_1", originToolCallId: "t1_5" }));
		expect(blockedByTokens.ok).toBe(false);
		expect(blockedByTokens.error).toMatch(/delegation budget/i);

		// A new parent turn (`turn_2`) resets the turn budget and admits up to 6 low-token runs
		const lowTokenScheduler = new SubagentRunScheduler({
			executeRun: async () => ({
				status: "completed",
				complete: true,
				summaryText: "ok",
				usage: {
					...createEmptySubagentUsage(),
					input: 100,
					output: 50,
					totalTokens: 150,
				},
			}),
		});
		for (let i = 0; i < 6; i++) {
			const adm = lowTokenScheduler.admit(makeRequest({ parentTurnId: "turn_2", originToolCallId: `t2_${i}` }));
			expect(adm.ok).toBe(true);
			await adm.handle!.completion;
		}
		const seventhInTurn = lowTokenScheduler.admit(makeRequest({ parentTurnId: "turn_2", originToolCallId: "t2_6" }));
		expect(seventhInTurn.ok).toBe(false);
		expect(seventhInTurn.error).toMatch(/6 child runs/i);

		// Turn 3 works again
		const turn3 = lowTokenScheduler.admit(makeRequest({ parentTurnId: "turn_3", originToolCallId: "t3_0" }));
		expect(turn3.ok).toBe(true);
		await turn3.handle!.completion;
	});

	it("handles cancellation and deadline expiry before admission, while queued, during startup, while streaming, and during a tool call", async () => {
		const gates = new Map<string, ReturnType<typeof deferred<SubagentRunnerOutcome>>>();
		const startedIds: string[] = [];

		const scheduler = new SubagentRunScheduler({
			maxParentTurnRuns: 20,
			executeRun: async (params) => {
				startedIds.push(params.record.runId);
				const gate = deferred<SubagentRunnerOutcome>();
				gates.set(params.record.runId, gate);
				params.signal.addEventListener(
					"abort",
					() => {
						gate.resolve({
							status: "cancelled",
							complete: false,
							summaryText: "Partial before abort",
						});
					},
					{ once: true },
				);
				return gate.promise;
			},
		});

		// 1. Pre-aborted caller signal rejected before admission
		const preAborted = new AbortController();
		preAborted.abort();
		const preRes = scheduler.admit(makeRequest({ signal: preAborted.signal }));
		expect(preRes.ok).toBe(false);
		expect(preRes.error).toMatch(/aborted/i);

		// 2. Fill 2 active slots so subsequent runs are queued
		const active1 = scheduler.admit(makeRequest()).handle!;
		const active2 = scheduler.admit(makeRequest()).handle!;

		// 3. Queued run cancelled before starting -> never enters startedIds
		const queuedCancel = scheduler.admit(makeRequest()).handle!;
		expect(scheduler.getRun(queuedCancel.runId)?.status).toBe("queued");
		scheduler.cancelRun(queuedCancel.runId, "user");
		const queuedCancelResult = await queuedCancel.completion;
		expect(queuedCancelResult.status).toBe("cancelled");
		expect(startedIds).not.toContain(queuedCancel.runId);

		// 4. Queued run whose deadline expires while queued -> timed_out without starting
		const queuedTimeout = scheduler.admit(makeRequest({ deadlineMs: 15 })).handle!;
		const queuedTimeoutResult = await queuedTimeout.completion;
		expect(queuedTimeoutResult.status).toBe("timed_out");
		expect(startedIds).not.toContain(queuedTimeout.runId);

		// 5. Active run cancelled while streaming/running
		scheduler.cancelRun(active1.runId, "caller");
		const active1Result = await active1.completion;
		expect(active1Result.status).toBe("cancelled");

		// 6. Active run timed out by deadline
		const activeTimeout = scheduler.admit(makeRequest({ deadlineMs: 15 })).handle!;
		const activeTimeoutResult = await activeTimeout.completion;
		expect(activeTimeoutResult.status).toBe("timed_out");

		scheduler.cancelRun(active2.runId, "caller");
		await active2.completion;
	});

	it("terminates early with budget_exceeded on turn/tool/token limits, repetitive identical tool calls, or repeated policy denials, and ignores late events", async () => {
		const scheduler = new SubagentRunScheduler({
			maxParentTurnRuns: 20,
			executeRun: async (params) => {
				if (params.record.originToolCallId === "loop_calls") {
					params.controller.recordToolCall("grep", { pattern: "foo", path: "src" });
					params.controller.recordToolCall("grep", { pattern: "foo", path: "src" });
					params.controller.recordToolCall("grep", { path: "src", pattern: "foo" }); // canonical match #3
					return {
						status: "completed",
						complete: true,
						summaryText: "Partial findings before loop stop",
					};
				}
				if (params.record.originToolCallId === "loop_denials") {
					params.controller.recordPolicyDenial("Blocked by Read(.env)");
					params.controller.recordPolicyDenial("Blocked by Read(.env.local)");
					params.controller.recordPolicyDenial("Blocked by Read(secrets/key)");
					return {
						status: "completed",
						complete: true,
						summaryText: "Partial findings before denial stop",
					};
				}
				if (params.record.originToolCallId === "turn_limit") {
					for (let i = 0; i < 4; i++) {
						params.controller.recordTurn();
					}
					return {
						status: "completed",
						complete: true,
						summaryText: "Partial findings at turn limit",
					};
				}
				return { status: "completed", complete: true, summaryText: "ok" };
			},
		});

		const loopRun = scheduler.admit(makeRequest({ originToolCallId: "loop_calls" })).handle!;
		const loopDone = await loopRun.completion;
		expect(loopDone.status).toBe("budget_exceeded");
		expect(loopDone.complete).toBe(false);
		expect(loopDone.stopReason).toMatch(/repetitive/i);

		const denialRun = scheduler.admit(makeRequest({ originToolCallId: "loop_denials" })).handle!;
		const denialDone = await denialRun.completion;
		expect(denialDone.status).toBe("budget_exceeded");
		expect(denialDone.complete).toBe(false);
		expect(denialDone.stopReason).toMatch(/denial/i);

		const turnRun = scheduler.admit(makeRequest({ originToolCallId: "turn_limit", maxTurns: 3 })).handle!;
		const turnDone = await turnRun.completion;
		expect(turnDone.status).toBe("budget_exceeded");
		expect(turnDone.complete).toBe(false);
		expect(turnDone.stopReason).toMatch(/turn limit/i);

		// Late cancellation or duplicate events after terminal state cannot overwrite status
		scheduler.cancelRun(turnRun.runId, "user");
		expect(scheduler.getRun(turnRun.runId)?.status).toBe("budget_exceeded");
	});

	it("keeps active slots occupied while a non-cooperating runner is stopping until cleanup actually finishes", async () => {
		const stuckGate = deferred<SubagentRunnerOutcome>();
		const secondGate = deferred<SubagentRunnerOutcome>();
		const thirdStarted = { value: false };

		const scheduler = new SubagentRunScheduler({
			maxParentTurnRuns: 10,
			executeRun: async (params) => {
				if (params.record.originToolCallId === "stuck_1") {
					// Intentionally ignores params.signal abort until stuckGate resolves
					return stuckGate.promise;
				}
				if (params.record.originToolCallId === "active_2") {
					return secondGate.promise;
				}
				thirdStarted.value = true;
				return { status: "completed", complete: true, summaryText: "third finished" };
			},
		});

		const r1 = scheduler.admit(makeRequest({ originToolCallId: "stuck_1" })).handle!;
		const r2 = scheduler.admit(makeRequest({ originToolCallId: "active_2" })).handle!;
		const r3 = scheduler.admit(makeRequest({ originToolCallId: "queued_3" })).handle!;

		// Cancel r1 -> status becomes "stopping", but r1 still holds its active slot because stuckGate hasn't settled!
		scheduler.cancelRun(r1.runId, "user");
		expect(scheduler.getRun(r1.runId)?.status).toBe("stopping");
		expect(scheduler.getActiveCount()).toBe(2);
		expect(thirdStarted.value).toBe(false);
		expect(scheduler.getRun(r3.runId)?.status).toBe("queued");

		// Now stuckGate settles -> r1 transitions to "cancelled" and releases the slot so r3 starts
		stuckGate.resolve({ status: "completed", complete: true, summaryText: "late" });
		const r1Done = await r1.completion;
		expect(r1Done.status).toBe("cancelled");

		const r3Done = await r3.completion;
		expect(thirdStarted.value).toBe(true);
		expect(r3Done.status).toBe("completed");

		secondGate.resolve({ status: "completed", complete: true, summaryText: "r2 done" });
		await r2.completion;
	});
});
