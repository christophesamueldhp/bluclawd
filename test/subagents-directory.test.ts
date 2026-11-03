import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { type AdmissionContext, createRunAdmission, type RunExecutionContext } from "../ext/subagents/admission.ts";
import { createGenerations, type ParentNotice } from "../ext/subagents/generations.ts";
import { SubagentMessageBus } from "../ext/subagents/messages.ts";
import { createParentScope } from "../ext/subagents/parent-scope.ts";
import type { ChildSession, RunSubagentOptions } from "../ext/subagents/runner.ts";
import type { AdmitSubagentRunRequest, AdmittedSubagentHandle, SubagentRunnerOutcome } from "../ext/subagents/runs.ts";
import { createAgentTaskSource } from "../ext/subagents/task-source.ts";
import { waitFor } from "./helpers/wait-for.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-directory-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** A child as the fake runner started it, held until the test ends it. */
interface FakeChild {
	readonly options: RunSubagentOptions;
	/** Messages steered into the child, as text. */
	readonly inbox: string[];
	/** Runs one of the child's tools as its model would, and returns the result text. */
	call(toolName: string, params: object): Promise<string>;
	/** Ends the child's last turn; the run is final only once `finish` returns its outcome. */
	endTurn(): void;
	/** Keeps the child running when it is stopped, until `finish`. */
	holdStop(): void;
	finish(outcome?: Partial<SubagentRunnerOutcome>): void;
}

function fakeRunner() {
	const children: FakeChild[] = [];
	const run = (options: RunSubagentOptions) =>
		new Promise<SubagentRunnerOutcome>((resolve) => {
			const listeners = new Set<(event: AgentSessionEvent) => void>();
			const inbox: string[] = [];
			let holdingStop = false;
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
				() => {
					if (!holdingStop)
						resolve({ status: "cancelled", complete: false, summaryText: "", stopReason: "aborted" });
				},
				{ once: true },
			);
			const endTurn = () => {
				for (const listener of listeners) listener({ type: "agent_end", messages: [], willRetry: false });
			};
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
				endTurn,
				holdStop: () => {
					holdingStop = true;
				},
				finish: (outcome = {}) => {
					endTurn();
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

function fakeSessionContext(cwd: string) {
	return { sessionManager: SessionManager.inMemory(cwd) } as unknown as ExtensionContext;
}

/** The orchestrator's model registry, holding the one model the test runs launch with. */
async function fauxModelRegistry(agentDir: string) {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", reasoning: false }] });
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	return { registry: new ModelRegistry(runtime), model: faux.getModel("faux-1") };
}

/** An orchestrator's subagents; given an earlier one's, a reload of it: the same parent session and agent dir. */
function setup(earlier?: { cwd: string; agentDir: string; session: ExtensionContext }) {
	const cwd = earlier?.cwd ?? makeTempDir("cwd");
	const agentDir = earlier?.agentDir ?? makeTempDir("agent");
	const bus = new SubagentMessageBus(undefined, {
		find: (scope, to) => generations.directory.find(scope, to),
		reachable: (scope) => generations.directory.reachable(scope),
	});
	const scope = createParentScope<ParentNotice>({
		bus,
		cancelRuns: (where, reason) => generations.scheduler.cancelRuns(where, reason),
		send: () => {},
		onChange: () => {},
		batchWindowMs: 0,
	});
	const session = earlier?.session ?? fakeSessionContext(cwd);
	scope.enter(session, "replaced");
	const runner = fakeRunner();
	const generations = createGenerations({
		agentDir: () => agentDir,
		runner: runner.run,
		bus,
		scope,
		pi: { appendEntry: () => {} },
		launchesSettled: () => Promise.resolve(),
		onChange: () => {},
	});
	const { directory } = generations;
	const tasks = createAgentTaskSource({
		directory,
		scheduler: generations.scheduler,
		agentDir: () => agentDir,
		activeScope: () => scope.current(),
	});
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
	/** Launches a background run in the current parent scope, named and tasked as given. */
	const launch = (
		name: string,
		task: string,
		overrides: Partial<AdmitSubagentRunRequest<RunExecutionContext>> = {},
	): AdmittedSubagentHandle => {
		const current = scope.current()!;
		const admitted = generations.scheduler.admit({
			parentSessionId: current.parentSessionId,
			sessionEpoch: current.sessionEpoch,
			parentTurnId: "turn_1",
			originToolCallId: `call_${++calls}`,
			name,
			agentName: "general-purpose",
			definitionSource: "bundled",
			provider: "faux",
			modelId: "faux-1",
			thinkingLevel: "off",
			cwd,
			taskSummary: task,
			deliveryMode: "background",
			context: { ...context, task },
			...overrides,
		});
		if (!admitted.ok) throw new Error(admitted.error);
		void generations.deliver(admitted.handle);
		return admitted.handle;
	};
	const admission = createRunAdmission({
		scheduler: generations.scheduler,
		directory,
		agentDir: () => agentDir,
		catalog: () => undefined,
		loadout: () => ({
			declared: [],
			callable: [],
			registered: [],
			getExposure: () => "direct",
			getNamespace: () => undefined,
			getPromptGuidelines: () => [],
		}),
		parentThinkingLevel: () => "off",
		scope,
	});
	/**
	 * The orchestrator, once its models are loaded: sends a message as its subagent_message tool does, and returns
	 * the receipt text.
	 */
	const orchestrator = async () => {
		const { registry, model } = await fauxModelRegistry(agentDir);
		const ctx: AdmissionContext = {
			cwd,
			mode: "tui",
			model,
			modelRegistry: registry,
			isProjectTrusted: () => false,
			sessionManager: session.sessionManager,
			executeTool: async () => {
				throw new Error("the fake children never run the orchestrator's tools");
			},
		};
		return async (to: string, content: string) => {
			const result = await generations.messageFromParent(
				scope.current()!,
				to,
				content,
				`call_message_${++calls}`,
				admission,
				ctx,
			);
			return result.content.map((part) => part.text).join("");
		};
	};
	return { cwd, agentDir, session, scope, generations, directory, tasks, runner, launch, orchestrator };
}

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

	it.each(["failed", "cancelled"] as const)(
		"tells a parent message to a finishing run that ends %s why it cannot resume",
		async (status) => {
			const { runner, launch, orchestrator } = setup();
			const messageFromParent = await orchestrator();
			const backend = launch("backend", "Build the API.");
			const b = await runner.child(0);
			b.endTurn();

			const receipt = messageFromParent("backend", "Now add pagination.");
			b.finish({ status, complete: false, transcriptPath: "transcript.jsonl" });

			expect(await receipt).toBe(
				`Message 0 unavailable: "backend" (${backend.runId}) is ${status}; only a completed subagent can be resumed.`,
			);
		},
	);

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
