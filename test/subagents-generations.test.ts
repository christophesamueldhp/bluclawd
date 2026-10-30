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
import { SUBAGENT_RUN_CUSTOM_ENTRY, subagentReportPath, writePersistedRunRecord } from "../ext/subagents/storage.ts";
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

function setup() {
	const cwd = makeTempDir("cwd");
	const agentDir = makeTempDir("agent");
	const bus = new SubagentMessageBus();
	const sent: ParentInboxItem<ParentNotice>[][] = [];
	const scope = createParentScope<ParentNotice>({
		bus,
		cancelRuns: (where, reason) => generations.scheduler.cancelRuns(where, reason),
		send: (items) => sent.push([...items]),
		onChange: () => {},
		batchWindowMs: 0,
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
