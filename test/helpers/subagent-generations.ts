import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createRunAdmission,
	type InProcessRunContext,
	type RunExecutionContext,
} from "../../ext/subagents/admission.ts";
import { createGenerations, type ParentNotice } from "../../ext/subagents/generations.ts";
import { SubagentMessageBus } from "../../ext/subagents/messages.ts";
import { createParentScope, type ParentInboxItem } from "../../ext/subagents/parent-scope.ts";
import type { ChildSession, RunSubagentOptions } from "../../ext/subagents/runner.ts";
import type {
	AdmitSubagentRunRequest,
	AdmittedSubagentHandle,
	SubagentRunnerOutcome,
} from "../../ext/subagents/runs.ts";
import { createAgentTaskSource } from "../../ext/subagents/task-source.ts";
import { RunReports } from "../../ext/subagents/tmux-runs.ts";
import { createParentScopeViews } from "../../ext/subagents/views.ts";
import { waitFor } from "./wait-for.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-generations-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

/** Removes the directories of every fixture made so far; for `afterEach`. */
export function removeGenerationsFixtures(): void {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
}

/** A child as the fake runner started it, held until the test ends it. */
export interface FakeChild {
	readonly options: RunSubagentOptions;
	/** Messages steered into the child, as text. */
	readonly inbox: string[];
	/** Runs one of the child's tools as its model would, and returns the result text. */
	call(toolName: string, params: object): Promise<string>;
	/** Ends the child's turn, its last unless pi will retry it; the run is final only once `finish` returns its outcome. */
	endTurn(willRetry?: boolean): void;
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
				messages: [],
				sessionFile: undefined,
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
			const endTurn = (willRetry = false) => {
				for (const listener of listeners) listener({ type: "agent_end", messages: [], willRetry });
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
				endTurn: (willRetry) => endTurn(willRetry),
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

/** An orchestrator's session as admission reads it; its models are set by `loadModels`. */
export function fakeSessionContext(cwd: string) {
	return {
		sessionManager: SessionManager.inMemory(cwd),
		cwd,
		mode: "tui",
		isProjectTrusted: () => false,
	} as unknown as ExtensionContext;
}

/** A note the generations sent to the orchestrator through `pi.sendMessage`. */
export interface SentNote {
	readonly text: string;
	readonly options: unknown;
}

/**
 * An orchestrator's subagents over the generations factory and a fake runner; given an earlier one's, a reload of
 * it: the same parent session and agent dir.
 */
export function createGenerationsFixture(earlier?: { cwd: string; agentDir: string; session: ExtensionContext }) {
	const cwd = earlier?.cwd ?? makeTempDir("cwd");
	const agentDir = earlier?.agentDir ?? makeTempDir("agent");
	const bus = new SubagentMessageBus(undefined, {
		find: (scope, to) => generations.directory.find(scope, to),
		reachable: (scope) => generations.directory.reachable(scope),
	});
	const sent: ParentInboxItem<ParentNotice>[][] = [];
	const scope = createParentScope<ParentNotice>({
		bus,
		cancelRuns: (where, reason) => generations.scheduler.cancelRuns(where, reason),
		send: (items) => sent.push([...items]),
		onChange: () => {},
		batchWindowMs: 0,
	});
	const session = earlier?.session ?? fakeSessionContext(cwd);
	scope.enter(session, "replaced");
	const runner = fakeRunner();
	const notes: SentNote[] = [];
	const pi = {
		appendEntry: () => {},
		sendMessage: (message, options) => {
			const text = message.content;
			notes.push({
				text:
					typeof text === "string" ? text : text.map((part) => (part.type === "text" ? part.text : "")).join(""),
				options,
			});
		},
	} satisfies Pick<ExtensionAPI, "appendEntry" | "sendMessage">;
	const generations = createGenerations({
		agentDir: () => agentDir,
		runner: runner.run,
		bus,
		scope,
		pi,
		launchesSettled: () => Promise.resolve(),
		onChange: () => {},
		reports: new RunReports(),
	});
	const { directory } = generations;
	const tasks = createAgentTaskSource({
		views: createParentScopeViews({
			scheduler: generations.scheduler,
			directory,
			agentDir: () => agentDir,
			scope: () => scope.current(),
			idle: () => true,
			now: Date.now,
			onChange: () => {},
		}),
		directory,
		scheduler: generations.scheduler,
		agentDir: () => agentDir,
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
	} as unknown as InProcessRunContext;
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
	/** Gives the orchestrator's session the one model the test runs launch with, as a resume needs it. */
	const loadModels = async () => {
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
		Object.assign(session, { model: faux.getModel("faux-1"), modelRegistry: new ModelRegistry(runtime) });
	};
	/**
	 * The orchestrator, once its models are loaded: sends a message as its subagent_message tool does, and returns
	 * the receipt text.
	 */
	const orchestrator = async () => {
		await loadModels();
		const ctx = Object.assign(Object.create(session), {
			executeTool: async () => {
				throw new Error("the fake children never run the orchestrator's tools");
			},
		});
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
	/** The user, once the orchestrator's models are loaded: types a message in a run's transcript. */
	const user = async () => {
		await loadModels();
		return (runId: string, content: string) => generations.messageFromUser(runId, content, admission);
	};
	const notices = () => sent.flat().flatMap((item) => (item.kind === "notice" ? [item.notice.parentText] : []));
	return {
		cwd,
		agentDir,
		session,
		scope,
		generations,
		directory,
		tasks,
		runner,
		notes,
		notices,
		launch,
		orchestrator,
		user,
	};
}
