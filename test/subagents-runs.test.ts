import { describe, expect, it, vi } from "vitest";
import {
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
		sessionEpoch: 1,
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
		...overrides,
	};
}

describe("Ticket #8 — Every requested run starts immediately with no child quotas", () => {
	it("starts 20 runs admitted in one parent turn before any of them finishes", async () => {
		const gates: ReturnType<typeof deferred<SubagentRunnerOutcome>>[] = [];
		const started: string[] = [];
		const scheduler = new SubagentRunScheduler({
			executeRun: (params) => {
				started.push(params.record.runId);
				const gate = deferred<SubagentRunnerOutcome>();
				gates.push(gate);
				return gate.promise;
			},
		});

		const handles = Array.from({ length: 20 }, (_, i) => {
			const admitted = scheduler.admit(makeRequest({ originToolCallId: `call_${i}` }));
			expect(admitted.ok, `run ${i}: ${admitted.error}`).toBe(true);
			return admitted.handle!;
		});

		expect(started).toEqual(handles.map((h) => h.runId));
		for (const handle of handles) {
			expect(handle.record.status).toBe("starting");
			for (const quotaField of ["deadlineAt", "repeatedCallCount", "repeatedDenialCount"]) {
				expect(handle.record).not.toHaveProperty(quotaField);
			}
		}

		for (const gate of gates) gate.resolve({ status: "completed", complete: true, summaryText: "done" });
		const finished = await Promise.all(handles.map((h) => h.completion));
		expect(finished.every((r) => r.status === "completed")).toBe(true);
	});

	it("does not auto-stop a run past former turn, tool-call, token, repetition and time limits", async () => {
		vi.useFakeTimers();
		try {
			const gates = new Map<string, ReturnType<typeof deferred<SubagentRunnerOutcome>>>();
			const scheduler = new SubagentRunScheduler({
				executeRun: (params: SubagentRunnerExecuteParams) => {
					const gate = deferred<SubagentRunnerOutcome>();
					gates.set(params.record.originToolCallId, gate);
					params.controller.markRunning();
					for (let i = 0; i < 13; i++) params.controller.recordTurn();
					for (let i = 0; i < 41; i++) params.controller.recordToolCall();
					params.controller.recordUsage({ input: 100_001, totalTokens: 100_001 });
					return gate.promise;
				},
			});

			const handles = ["heavy_1", "heavy_2", "heavy_3"].map(
				(id) => scheduler.admit(makeRequest({ originToolCallId: id })).handle!,
			);
			vi.advanceTimersByTime(6 * 60 * 1000);

			for (const handle of handles) {
				const live = scheduler.getRun(handle.runId)!;
				expect(live.status).toBe("running");
				expect(live.turnCount).toBe(13);
				expect(live.toolCallCount).toBe(41);
				expect(live.usage.totalTokens).toBe(100_001);
			}

			for (const gate of gates.values()) gate.resolve({ status: "completed", complete: true, summaryText: "done" });
			for (const handle of handles) {
				const done = await handle.completion;
				expect(done.status).toBe("completed");
				expect(done.stopReason).toBeUndefined();
			}
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("Task 3 (M1) — Run state and cancellation", () => {
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

	it("handles cancellation before admission, by explicit stop while running, and by the caller signal", async () => {
		const scheduler = new SubagentRunScheduler({
			executeRun: (params) => {
				const gate = deferred<SubagentRunnerOutcome>();
				params.signal.addEventListener(
					"abort",
					() => gate.resolve({ status: "cancelled", complete: false, summaryText: "Partial before abort" }),
					{ once: true },
				);
				return gate.promise;
			},
		});

		const preAborted = new AbortController();
		preAborted.abort();
		const preRes = scheduler.admit(makeRequest({ signal: preAborted.signal }));
		expect(preRes.ok).toBe(false);
		expect(preRes.error).toMatch(/aborted/i);

		const stopped = scheduler.admit(makeRequest()).handle!;
		expect(scheduler.cancelRun(stopped.runId, "remote")).toBe(true);
		const stoppedResult = await stopped.completion;
		expect(stoppedResult.status).toBe("cancelled");
		expect(stoppedResult.stopSource).toBe("remote");
		expect(stoppedResult.summaryText).toBe("Partial before abort");

		const caller = new AbortController();
		const callerRun = scheduler.admit(makeRequest({ signal: caller.signal })).handle!;
		caller.abort();
		const callerResult = await callerRun.completion;
		expect(callerResult.status).toBe("cancelled");
		expect(callerResult.stopSource).toBe("caller");
	});

	it("ignores stop requests after a run has finished", async () => {
		const scheduler = new SubagentRunScheduler({
			executeRun: async () => ({ status: "completed", complete: true, summaryText: "ok" }),
		});
		const handle = scheduler.admit(makeRequest()).handle!;
		await handle.completion;

		expect(scheduler.cancelRun(handle.runId, "user")).toBe(false);
		expect(scheduler.getRun(handle.runId)?.status).toBe("completed");
	});

	it("keeps a stopping run active until a non-cooperating runner actually returns", async () => {
		const stuckGate = deferred<SubagentRunnerOutcome>();
		const scheduler = new SubagentRunScheduler({
			// Intentionally ignores the abort signal until stuckGate resolves
			executeRun: () => stuckGate.promise,
		});

		const run = scheduler.admit(makeRequest()).handle!;
		scheduler.cancelRun(run.runId, "user");
		expect(scheduler.getRun(run.runId)?.status).toBe("stopping");
		expect(scheduler.listActiveRuns().map((r) => r.runId)).toEqual([run.runId]);

		stuckGate.resolve({ status: "completed", complete: true, summaryText: "late" });
		const done = await run.completion;
		expect(done.status).toBe("cancelled");
		expect(scheduler.listActiveRuns()).toEqual([]);
	});
});

describe("Ticket #12 — Completion resolves only after durable finalization", () => {
	const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

	it("keeps a run active and its completion pending until the finalizer finishes", async () => {
		const finalizerGate = deferred();
		let finalizerCalls = 0;
		const scheduler = new SubagentRunScheduler({
			executeRun: async () => ({ status: "completed", complete: true, summaryText: "done" }),
			onFinalize: async (record) => {
				finalizerCalls++;
				await finalizerGate.promise;
				return { ...record, reportPath: "/durable/report.md" };
			},
		});
		const handle = scheduler.admit(makeRequest()).handle!;
		let resolved = false;
		void handle.completion.then(() => {
			resolved = true;
		});

		await tick();
		expect(finalizerCalls).toBe(1);
		expect(resolved).toBe(false);
		expect(scheduler.listActiveRuns().map((r) => r.runId)).toEqual([handle.runId]);
		// A stop that arrives while the run is being stored is acknowledged but cannot change the outcome
		expect(scheduler.cancelRun(handle.runId, "user")).toBe(true);

		finalizerGate.resolve();
		const done = await handle.completion;
		expect(done).toMatchObject({ status: "completed", reportPath: "/durable/report.md" });
		expect(finalizerCalls).toBe(1);
		expect(scheduler.listActiveRuns()).toEqual([]);
	});

	it("turns a failing finalizer into a failed durable outcome", async () => {
		const changes: string[] = [];
		const finalized: string[] = [];
		const scheduler = new SubagentRunScheduler({
			executeRun: async () => ({ status: "completed", complete: true, summaryText: "done" }),
			onFinalize: async (record) => {
				finalized.push(record.status);
				if (record.status === "completed") throw new Error("disk full");
				return record;
			},
			onStateChange: (record) => changes.push(record.status),
		});
		const done = await scheduler.admit(makeRequest()).handle!.completion;
		expect(done).toMatchObject({ status: "failed", complete: false });
		expect(done.errorMessage).toMatch(/finaliz.*disk full/i);
		expect(changes.at(-1)).toBe("failed");
		expect(changes).not.toContain("completed");
		// The failed outcome goes through the same durable path, replacing anything the first attempt stored
		expect(finalized).toEqual(["completed", "failed"]);
	});

	it("waits for runners and finalizers to settle and writes nothing afterwards", async () => {
		const runnerGate = deferred<SubagentRunnerOutcome>();
		const finalizerGate = deferred();
		let changesAfterSettled = 0;
		let settled = false;
		const scheduler = new SubagentRunScheduler({
			// Ignores the abort signal, like a runner whose child is still unwinding
			executeRun: () => runnerGate.promise,
			onFinalize: async (record) => {
				await finalizerGate.promise;
				return record;
			},
			onStateChange: () => {
				if (settled) changesAfterSettled++;
			},
		});
		const handle = scheduler.admit(makeRequest()).handle!;
		scheduler.cancelRuns((record) => record.parentSessionId === "sess_1", "Parent session changed");
		const drained = scheduler.waitForSettled().then(() => {
			settled = true;
		});

		runnerGate.resolve({ status: "completed", complete: true, summaryText: "late" });
		await tick();
		expect(settled).toBe(false);
		finalizerGate.resolve();
		await drained;
		expect((await handle.completion).status).toBe("cancelled");
		await tick();
		expect(changesAfterSettled).toBe(0);
	});
});

describe("Issue #63 — A run's controller only affects its own generation", () => {
	function exercise(controller: SubagentRunnerExecuteParams["controller"], tag: string) {
		controller.markRunning(`child_${tag}`, `thinking_${tag}`);
		controller.recordTurn();
		controller.recordToolCall(`tool_${tag}`);
		controller.recordToolExecution(`tool_${tag}`, false);
		controller.recordUsage({ input: 10 });
		controller.recordNestedUsage({ input: 5 });
		controller.updateProgress(`progress_${tag}`);
	}

	it("ignores an earlier generation's controller after a resume", async () => {
		let clock = 0;
		const controllers: SubagentRunnerExecuteParams["controller"][] = [];
		const gates: ReturnType<typeof deferred<SubagentRunnerOutcome>>[] = [];
		const scheduler = new SubagentRunScheduler({
			now: () => ++clock,
			executeRun: ({ controller }) => {
				controllers.push(controller);
				const gate = deferred<SubagentRunnerOutcome>();
				gates.push(gate);
				return gate.promise;
			},
		});
		const handle = scheduler.admit(makeRequest()).handle!;
		gates[0].resolve({ status: "completed", complete: true, summaryText: "first" });
		await handle.completion;

		const resumed = scheduler.resume(handle.runId, undefined).handle!;
		const before = scheduler.getRun(handle.runId);
		exercise(controllers[0], "old");
		expect(scheduler.getRun(handle.runId)).toEqual(before);

		exercise(controllers[1], "new");
		expect(scheduler.getRun(handle.runId)).toMatchObject({
			generation: 1,
			status: "running",
			childSessionId: "child_new",
			thinkingLevel: "thinking_new",
			turnCount: 1,
			toolCallCount: 1,
			toolExecutions: { tool_new: { ok: 1, error: 0 } },
			lastActivity: { kind: "tool", detail: "tool_new" },
			lastProgressText: "progress_new",
			usage: { input: 15 },
		});

		gates[1].resolve({ status: "completed", complete: true, summaryText: "second" });
		expect(await resumed.completion).toMatchObject({
			status: "completed",
			usage: { input: 15 },
			usageAttribution: "ledger",
		});
	});
});
