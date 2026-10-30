import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunExecutionContext } from "../ext/subagents/admission.ts";
import { createGenerations, type ParentNotice } from "../ext/subagents/generations.ts";
import { SubagentMessageBus } from "../ext/subagents/messages.ts";
import { createParentScope, type ParentInboxItem } from "../ext/subagents/parent-scope.ts";
import type { ChildSession, RunSubagentOptions } from "../ext/subagents/runner.ts";
import type { AdmitSubagentRunRequest, AdmittedSubagentHandle, SubagentRunnerOutcome } from "../ext/subagents/runs.ts";
import {
	readBackgroundUsageLedger,
	readPersistedRunRecord,
	SUBAGENT_RUN_CUSTOM_ENTRY,
	subagentReportPath,
	writePersistedRunRecord,
} from "../ext/subagents/storage.ts";
import { waitFor } from "./helpers/wait-for.ts";

// Record writes go to disk as usual; the spy only counts them.
vi.mock("../ext/subagents/storage.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../ext/subagents/storage.ts")>();
	return { ...actual, writePersistedRunRecord: vi.fn(actual.writePersistedRunRecord) };
});

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-generations-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	vi.mocked(writePersistedRunRecord).mockClear();
});

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** A child as the fake runner started it, held until the test finishes it. */
interface FakeChild {
	readonly options: RunSubagentOptions;
	/** Messages steered into the child, as text. */
	readonly inbox: string[];
	/** Runs one of the child's tools as its model would, and returns the result text. */
	call(toolName: string, params: object): Promise<string>;
	/** Ends the child's last turn and returns this outcome. */
	finish(outcome?: Partial<SubagentRunnerOutcome>): void;
}

function fakeRunner() {
	const children: FakeChild[] = [];
	const run = (options: RunSubagentOptions) =>
		new Promise<SubagentRunnerOutcome>((resolve) => {
			const listeners = new Set<(event: AgentSessionEvent) => void>();
			const inbox: string[] = [];
			const session: ChildSession = {
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				sendCustomMessage: async (message) => {
					inbox.push(
						typeof message.content === "string"
							? message.content
							: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
					);
				},
			};
			options.onChildSessionCreated?.(session);
			options.signal.addEventListener(
				"abort",
				() => resolve({ status: "cancelled", complete: false, summaryText: "", stopReason: "aborted" }),
				{ once: true },
			);
			children.push({
				options,
				inbox,
				call: async (toolName, params) => {
					const tool = options.childTools.find((candidate) => candidate.name === toolName);
					if (!tool) throw new Error(`The child has no ${toolName} tool.`);
					const result = await tool.execute(
						`call_${toolName}`,
						params as never,
						undefined,
						undefined,
						{} as never,
					);
					return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
				},
				finish: (outcome = {}) => {
					for (const listener of listeners) listener({ type: "agent_end", messages: [], willRetry: false });
					resolve({ status: "completed", complete: true, summaryText: "", ...outcome });
				},
			});
		});
	/** The child the runner started `index`-th, once it has started. */
	const child = async (index: number) => {
		await waitFor(() => children.length > index);
		return children[index];
	};
	return { run, child };
}

function setup(options: { batchWindowMs?: number } = {}) {
	const cwd = makeTempDir("cwd");
	const agentDir = makeTempDir("agent");
	const bus = new SubagentMessageBus();
	const sent: ParentInboxItem<ParentNotice>[][] = [];
	const scope = createParentScope<ParentNotice>({
		bus,
		cancelRuns: (where, reason) => generations.scheduler.cancelRuns(where, reason),
		send: (items) => sent.push([...items]),
		onChange: () => {},
		batchWindowMs: options.batchWindowMs ?? 0,
	});
	scope.enter({ sessionManager: SessionManager.inMemory(cwd) } as unknown as ExtensionContext, "replaced");
	const entries: { customType: string; data: unknown }[] = [];
	const runner = fakeRunner();
	const generations = createGenerations({
		agentDir: () => agentDir,
		runner: runner.run,
		bus,
		scope,
		pi: { appendEntry: (customType, data) => entries.push({ customType, data }) },
		launchesSettled: () => Promise.resolve(),
		onChange: () => {},
	});
	const parentSessionId = scope.current()!.parentSessionId;
	const context = {
		agentDir,
		definition: { name: "general-purpose" },
		task: "Build the API.",
		parent: { executeTool: async () => ({ content: [], details: undefined }) },
		parentTools: [],
		activeToolNames: [],
		builtinExtensions: [],
		childModel: {},
		projectTrusted: false,
	} as unknown as RunExecutionContext;
	let calls = 0;
	const launch = (overrides: Partial<AdmitSubagentRunRequest<RunExecutionContext>> = {}): AdmittedSubagentHandle => {
		const admitted = generations.scheduler.admit({
			parentSessionId,
			sessionEpoch: scope.current()!.sessionEpoch,
			parentTurnId: "turn_1",
			originToolCallId: `call_${++calls}`,
			name: "backend",
			agentName: "general-purpose",
			definitionSource: "bundled",
			provider: "faux",
			modelId: "faux-1",
			thinkingLevel: "off",
			cwd,
			taskSummary: "Build the API.",
			deliveryMode: "foreground",
			context,
			...overrides,
		});
		if (!admitted.ok) throw new Error(admitted.error);
		return admitted.handle;
	};
	const recordWrites = (runId: string) =>
		vi
			.mocked(writePersistedRunRecord)
			.mock.calls.filter(([, record]) => record.runId === runId)
			.map(([, record]) => record.status);
	const report = (runId: string) => readFileSync(subagentReportPath(agentDir, parentSessionId, runId), "utf8");
	const notices = () => sent.flat().flatMap((item) => (item.kind === "notice" ? [item.notice.parentText] : []));
	const ledger = () => readBackgroundUsageLedger(agentDir, parentSessionId);
	return {
		agentDir,
		parentSessionId,
		scope,
		generations,
		runner,
		context,
		sent,
		entries,
		launch,
		recordWrites,
		report,
		notices,
		ledger,
	};
}

describe("Generations persist each transition once", () => {
	it("writes the record once per transition, with a stub report and a start reference at launch", async () => {
		const { launch, runner, recordWrites, report, entries } = setup();
		const handle = launch();
		const { runId } = handle;
		expect(recordWrites(runId)).toEqual(["starting"]);
		expect(report(runId)).toBe(`Run: ${runId} (general-purpose)\nStatus: starting\nTask: Build the API.\n`);
		expect(entries).toEqual([
			{ customType: SUBAGENT_RUN_CUSTOM_ENTRY, data: expect.objectContaining({ runId, status: "starting" }) },
		]);

		const child = await runner.child(0);
		child.options.controller.markRunning("child_1");
		expect(recordWrites(runId)).toEqual(["starting", "running"]);
		child.options.controller.updateProgress("Halfway there.");
		expect(recordWrites(runId)).toEqual(["starting", "running", "running"]);
		expect(report(runId)).toContain("Halfway there.");

		child.finish({ summaryText: "API built." });
		await handle.completion;
		expect(recordWrites(runId)).toEqual(["starting", "running", "running", "completed"]);
		expect(report(runId)).toContain("API built.");
		expect(entries.map((entry) => (entry.data as { status: string }).status)).toEqual(["starting", "completed"]);
	});
});

describe("Generations are delivered per kind", () => {
	it("returns a foreground generation as the launch's result without a notice", async () => {
		const { launch, runner, generations, notices, ledger } = setup();
		const handle = launch();
		const delivered = generations.deliver(handle);
		const child = await runner.child(0);
		child.options.controller.recordUsage({ input: 100, totalTokens: 100 });
		child.finish({ summaryText: "API built." });

		const envelope = await delivered;
		expect(envelope.parentText).toContain(`name=backend`);
		expect(envelope.parentText).toContain("API built.");
		expect(envelope.usage?.totalTokens).toBe(100);
		expect(notices()).toEqual([]);
		expect(ledger().recordedRunIds).toEqual([]);
	});

	it("tells the orchestrator once when a background generation is final, and counts its usage in the ledger", async () => {
		const { launch, runner, generations, notices, ledger, recordWrites } = setup();
		const handle = launch({ deliveryMode: "background" });
		void generations.deliver(handle);
		const child = await runner.child(0);
		child.options.controller.recordUsage({ input: 70, totalTokens: 70 });
		child.finish({ summaryText: "API built in the background." });
		await handle.completion;

		await waitFor(() => notices().length === 1);
		expect(notices()[0]).toContain("Execution: completed");
		expect(notices()[0]).toContain("API built in the background.");
		expect(ledger()).toMatchObject({ recordedRunIds: [handle.runId], usage: { totalTokens: 70 } });
		expect(recordWrites(handle.runId)).toEqual(["starting", "completed"]);
	});

	it.each(["user", "remote"] as const)("sends no notice when the %s stops a background generation", async (source) => {
		const { launch, runner, generations, notices, recordWrites } = setup();
		const handle = launch({ deliveryMode: "background" });
		const delivered = generations.deliver(handle);
		await runner.child(0);
		generations.scheduler.cancelRun(handle.runId, source, "Stopped.");

		const envelope = await delivered;
		expect(envelope.details.status).toBe("cancelled");
		expect(notices()).toEqual([]);
		expect(recordWrites(handle.runId)).toEqual(["starting", "stopping", "cancelled"]);
	});

	it("sends no notice when the session is switched under a background generation", async () => {
		const { launch, runner, generations, scope, notices } = setup();
		const handle = launch({ deliveryMode: "background" });
		const delivered = generations.deliver(handle);
		await runner.child(0);
		scope.invalidate("Parent session switching");

		expect((await delivered).details.status).toBe("cancelled");
		expect(notices()).toEqual([]);
	});

	it("tells the orchestrator when the model stopped a background generation", async () => {
		const { launch, runner, generations, notices } = setup();
		const handle = launch({ deliveryMode: "background" });
		const delivered = generations.deliver(handle);
		await runner.child(0);
		generations.scheduler.cancelRun(handle.runId, "model", "No longer needed.");

		await delivered;
		expect(notices()).toHaveLength(1);
		expect(notices()[0]).toContain("cancelled");
	});
});

describe("A resume is the run's next generation", () => {
	it("continues the run's transcript under its identity, with the message alone as its prompt, and counts each generation once", async () => {
		const {
			launch,
			runner,
			generations,
			context,
			agentDir,
			parentSessionId,
			notices,
			ledger,
			recordWrites,
			entries,
		} = setup();
		const first = launch();
		const firstDelivered = generations.deliver(first);
		const v1 = await runner.child(0);
		v1.options.controller.recordUsage({ input: 100, totalTokens: 100 });
		v1.finish({ summaryText: "v1 done.", transcriptPath: join(agentDir, "transcript.jsonl") });
		expect((await firstDelivered).usage?.totalTokens).toBe(100);
		launch({ name: "frontend", taskSummary: "Build the UI.", deliveryMode: "background" });
		await runner.child(1);

		const resumed = generations.scheduler.resume(first.runId, {
			...context,
			resume: {
				transcriptPath: join(agentDir, "transcript.jsonl"),
				prompt: "Now add tests.",
				toolCallId: "call_resume",
			},
		});
		if (!resumed.ok) throw new Error(resumed.error);
		void generations.deliver(resumed.handle);
		const v2 = await runner.child(2);
		expect(v2.options.record).toMatchObject({ runId: first.runId, name: "backend", generation: 1 });
		expect(v2.options.resumeSessionFile).toBe(join(agentDir, "transcript.jsonl"));
		expect(v2.options.task).toBe("Now add tests.");
		v2.options.controller.recordUsage({ input: 50, totalTokens: 50 });
		v2.finish({ summaryText: "v2 done." });
		await resumed.handle.completion;

		expect(readPersistedRunRecord(agentDir, parentSessionId, first.runId)).toMatchObject({
			runId: first.runId,
			name: "backend",
			generation: 1,
			status: "completed",
			summaryText: "v2 done.",
			deliveryMode: "background",
		});
		// The first, foreground generation was attributed to the parent; only the resumed one is in the ledger.
		expect(ledger()).toMatchObject({ recordedRunIds: [`${first.runId}#1`], usage: { totalTokens: 50 } });
		await waitFor(() => notices().length === 1);
		expect(notices()[0]).toContain("v2 done.");
		expect(recordWrites(first.runId)).toEqual(["starting", "completed", "starting", "completed"]);
		const references = entries.filter((entry) => (entry.data as { runId: string }).runId === first.runId);
		expect(references.map((entry) => (entry.data as { status: string }).status)).toEqual([
			"starting",
			"completed",
			"completed",
		]);
	});
});

describe("Children see each other by name", () => {
	it("shows a later child the live agents in its prompt and roster, routes its messages by name, and says when a run has finished", async () => {
		const { launch, runner, context } = setup();
		const backend = launch({ deliveryMode: "background" });
		const b = await runner.child(0);
		const frontend = launch({
			name: "frontend",
			taskSummary: "Build the UI.",
			context: { ...context, task: "Build the UI." },
		});
		const f = await runner.child(1);
		const backendLine = `- backend (general-purpose, ${backend.runId}, starting): Build the API.`;
		expect(b.options.task).toBe("Build the API.");
		expect(f.options.task).toBe(
			[
				"Build the UI.",
				"",
				"## Agents working now",
				backendLine,
				"Coordinate with them through subagent_message; subagent_roster shows the current list.",
			].join("\n"),
		);
		expect(await f.call("subagent_roster", {})).toBe(
			[
				"- parent: the orchestrator",
				backendLine,
				`- frontend (general-purpose, ${frontend.runId}, starting): Build the UI. (you)`,
			].join("\n"),
		);

		expect(await f.call("subagent_message", { to: "backend", content: "Use REST." })).toBe(
			`Message 1 accepted for delivery to backend (${backend.runId}) (not yet handled).`,
		);
		expect(b.inbox).toHaveLength(1);
		expect(b.inbox[0]).toMatch(/^\[Message from sibling agent frontend \(general-purpose, sub_/);
		expect(b.inbox[0]).toMatch(/Use REST\.$/);

		b.finish({ summaryText: "Backend done." });
		await backend.completion;
		expect(await f.call("subagent_message", { to: "backend", content: "Still there?" })).toMatch(
			/^Message 2 unavailable: .*backend.* has finished/,
		);
	});
});

describe("One orchestrator wake-up for close child messages and completion", () => {
	it("sends a child's messages and then its completion notice to the orchestrator together, once the batch window ends", async () => {
		const { launch, runner, generations, sent } = setup({ batchWindowMs: 400 });
		const handle = launch({ deliveryMode: "background" });
		const delivered = generations.deliver(handle);
		const child = await runner.child(0);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			for (const content of ["M1", "M2", "M3"]) await child.call("subagent_message", { to: "parent", content });
			child.finish({ summaryText: "Child finished." });
			await delivered;
			expect(sent).toEqual([]);

			vi.advanceTimersByTime(400);
			expect(sent).toHaveLength(1);
			expect(
				sent[0].map((item) => (item.kind === "message" ? item.message.content : item.notice.details.status)),
			).toEqual(["M1", "M2", "M3", "completed"]);
		} finally {
			vi.useRealTimers();
		}
	});
});
