import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionMessage, SessionUsage } from "../../daemon/ipc/protocol.ts";
import { createRunAdmission, type RunExecutionContext } from "../../ext/subagents/admission.ts";
import { createGenerations, type ParentNotice } from "../../ext/subagents/generations.ts";
import { SubagentMessageBus } from "../../ext/subagents/messages.ts";
import { createParentScope, type ParentInboxItem } from "../../ext/subagents/parent-scope.ts";
import type { AdmitSubagentRunRequest, AdmittedSubagentHandle } from "../../ext/subagents/runs.ts";
import { ensureRunStorageDir, storeRunReport, subagentRunDir } from "../../ext/subagents/storage.ts";
import { createAgentTaskSource } from "../../ext/subagents/task-source.ts";
import { RunReports } from "../../ext/subagents/tmux-runs.ts";
import { createParentScopeViews } from "../../ext/subagents/views.ts";
import { waitFor } from "./wait-for.ts";

/** The orchestrator's own tmux session in these tests. */
export const ORCHESTRATOR_PANE = "pi-orchestrator";

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

/** A run's pi as the fake tmux started it: a pane that never runs anything. */
export interface FakePane {
	readonly name: string;
	readonly args: readonly string[];
	/** Whether its session is gone: ended by a close, or its pi exited. */
	ended: boolean;
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

/**
 * An orchestrator's subagents over the generations factory, a fake tmux server and a fake daemon; given an earlier
 * one's, a reload of it: the same parent session and agent dir.
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
	const panes: FakePane[] = [];
	/** What the orchestrator sent other sessions through the daemon. */
	const delivered: { to: string; message: SessionMessage }[] = [];
	/** How many more sends the daemon refuses, as it does for a pane whose pi has not registered yet. */
	let refusals = 0;
	const reports = new RunReports();
	const generations = createGenerations({
		agentDir: () => agentDir,
		bus,
		scope,
		pi: { appendEntry: () => {}, sendMessage: () => {} },
		onChange: () => {},
		reports,
		tmux: () => ({
			newSession: (spec) => {
				const name = `pi-run${panes.length + 1}`;
				panes.push({ name, args: spec.args, ended: false });
				// As pi does, it keeps a session in its session directory, which a resume reopens.
				const sessionDir = spec.args.indexOf("--session-dir");
				if (sessionDir >= 0) writeFileSync(join(spec.args[sessionDir + 1], `${name}.jsonl`), "");
				return name;
			},
			end: (name) => {
				for (const pane of panes) if (pane.name === name) pane.ended = true;
			},
			hasSession: (name) => panes.some((pane) => pane.name === name && !pane.ended),
			shown: () => false,
			moveClients: () => {},
		}),
		handOff: new AbortController().signal,
		send: async (to, message) => {
			if (refusals > 0) {
				refusals--;
				throw new Error(`Unknown instance ${to}`);
			}
			delivered.push({ to, message });
		},
	});
	const { directory } = generations;
	const tasks = createAgentTaskSource({
		views: createParentScopeViews({
			scheduler: generations.scheduler,
			directory,
			agentDir: () => agentDir,
			scope: () => scope.current(),
			idle: () => true,
			onChange: () => {},
		}),
		directory,
		scheduler: generations.scheduler,
		agentDir: () => agentDir,
	});
	let calls = 0;
	/** Launches a background run in the current parent scope, named and tasked as given. */
	const launch = (
		name: string,
		task: string,
		overrides: Partial<AdmitSubagentRunRequest<RunExecutionContext>> = {},
	): AdmittedSubagentHandle => {
		const current = scope.current()!;
		const storage = ensureRunStorageDir(agentDir, current.parentSessionId, `sub_${name}_${++calls}`);
		if (!storage.ok) throw new Error(storage.error);
		const admitted = generations.scheduler.admit({
			runId: `sub_${name}_${calls}`,
			parentSessionId: current.parentSessionId,
			sessionEpoch: current.sessionEpoch,
			parentTurnId: "turn_1",
			originToolCallId: `call_${calls}`,
			name,
			agentName: "general-purpose",
			definitionSource: "bundled",
			provider: "faux",
			modelId: "faux-1",
			thinkingLevel: "off",
			cwd,
			taskSummary: task,
			deliveryMode: "background",
			context: {
				launch: {
					name,
					definition: {
						name: "general-purpose",
						description: "",
						model: "inherit",
						instructions: "Work.",
						source: "bundled",
					},
					model: "faux/faux-1",
					task,
					cwd,
					runDir: storage.runDir,
					parent: ORCHESTRATOR_PANE,
					projectTrusted: false,
				},
			},
			...overrides,
		});
		if (!admitted.ok) throw new Error(admitted.error);
		return admitted.handle;
	};
	/** The pane of the run, once its pi started. */
	const paneOf = async (handle: AdmittedSubagentHandle): Promise<string> =>
		(await waitFor(() => generations.scheduler.getRun(handle.runId)?.pane ?? false)) || "";
	/** The run reports `text` to its orchestrator, with its session's usage, as its pi does when it settles. */
	const report = async (
		handle: AdmittedSubagentHandle,
		text: string,
		usage?: { sessionId: string; totals: SessionUsage },
	) =>
		reports.receive({
			type: "session_message",
			kind: "report",
			from: await paneOf(handle),
			text,
			...(usage ? { usage: usage.totals, sessionId: usage.sessionId } : {}),
		});
	/** The run sends its Report numbered `seq`, as its pi does once it has stored it. */
	const sendReport = async (handle: AdmittedSubagentHandle, seq: number, text: string) =>
		reports.receive({ type: "session_message", kind: "report", from: await paneOf(handle), text, seq });
	/** The run stores its Report `text`, as its pi does before sending it; returns its `seq`. */
	const storeReport = (handle: AdmittedSubagentHandle, text: string) =>
		storeRunReport(subagentRunDir(agentDir, handle.record.parentSessionId, handle.runId), { text });
	const admission = createRunAdmission({
		scheduler: generations.scheduler,
		directory,
		agentDir: () => agentDir,
		catalog: () => undefined,
		parentThinkingLevel: () => "off",
		scope,
		pane: () => ORCHESTRATOR_PANE,
		tools: () => [],
		registeredTools: () => [],
	});
	/** Gives the orchestrator's session the one model the test runs launch with. */
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
		return async (to: string, content: string) => {
			const result = await generations.messageFromParent(scope.current()!, to, content, admission, session);
			return result.content.map((part) => part.text).join("");
		};
	};
	const notices = () => sent.flat().flatMap((item) => (item.kind === "notice" ? [item.notice.parentText] : []));
	const noticeDetails = () => sent.flat().flatMap((item) => (item.kind === "notice" ? [item.notice.details] : []));
	return {
		cwd,
		agentDir,
		session,
		scope,
		generations,
		directory,
		tasks,
		panes,
		delivered,
		notices,
		noticeDetails,
		launch,
		paneOf,
		report,
		sendReport,
		storeReport,
		reports,
		admission,
		orchestrator,
		/** The daemon refuses the next `count` sends: their recipient has not registered yet. */
		unregistered: (count: number) => {
			refusals = count;
		},
	};
}
