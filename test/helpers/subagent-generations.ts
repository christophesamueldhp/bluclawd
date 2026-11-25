import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionMessage, SessionUsage } from "../../daemon/ipc/protocol.ts";
import { createRunAdmission, type RunExecutionContext } from "../../ext/subagents/admission.ts";
import { createGenerations, type ParentNotice } from "../../ext/subagents/generations.ts";
import { RunReports, SubagentMessageBus } from "../../ext/subagents/messages.ts";
import { createParentScope, type ParentInboxItem } from "../../ext/subagents/parent-scope.ts";
import type { AdmitSubagentRunRequest, AdmittedSubagentHandle } from "../../ext/subagents/runs.ts";
import { ensureRunStorageDir, storeRunReport, subagentRunDir } from "../../ext/subagents/storage.ts";
import { createAgentTaskSource } from "../../ext/subagents/task-source.ts";
import { createParentScopeViews } from "../../ext/subagents/views.ts";
import { waitFor } from "./wait-for.ts";

export const ORCHESTRATOR_PANE = "pi-orchestrator";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-generations-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

export function removeGenerationsFixtures(): void {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
}

export interface FakePane {
	readonly name: string;
	ended: boolean;
}

export function fakeSessionContext(cwd: string) {
	return {
		sessionManager: SessionManager.inMemory(cwd),
		cwd,
		mode: "tui",
		isProjectTrusted: () => false,
	} as unknown as ExtensionContext;
}

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
	const delivered: { to: string; message: SessionMessage }[] = [];
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
			hangUpAsQuit: (name) => {
				for (const pane of panes) if (pane.name === name) pane.ended = true;
			},
			hasSession: (name) => panes.some((pane) => pane.name === name && !pane.ended),
			shown: () => false,
		}),
		handOff: new AbortController().signal,
		slots: {
			ensure: async () => false,
			claim: async () => "waitExpired",
			claimNow: async () => ({ granted: false, active: 0, capacity: 0 }),
			launch: async () => {
				throw new Error("no queue");
			},
			release: async () => {},
		},
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
	const launch = (
		name: string,
		task: string,
		overrides: Partial<AdmitSubagentRunRequest<RunExecutionContext>> = {},
	): AdmittedSubagentHandle => {
		const current = scope.current()!;
		const storage = ensureRunStorageDir(agentDir, current.parentSessionId, `sub_${name}_${++calls}`);
		if (!storage.ok) throw new Error(storage.error);
		const pane = `pi-run${panes.length + 1}`;
		panes.push({ name: pane, ended: false });
		writeFileSync(join(storage.runDir, `${pane}.jsonl`), "");
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
			context: { launch: { runDir: storage.runDir, parent: ORCHESTRATOR_PANE, pane } },
			...overrides,
		});
		if (!admitted.ok) throw new Error(admitted.error);
		return admitted.handle;
	};
	const paneOf = (handle: AdmittedSubagentHandle): Promise<string> =>
		waitFor(() => generations.scheduler.getRun(handle.runId)?.pane ?? false);
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
	const sendReport = async (handle: AdmittedSubagentHandle, seq: number, text: string) =>
		reports.receive({ type: "session_message", kind: "report", from: await paneOf(handle), text, seq });
	const storeReport = (handle: AdmittedSubagentHandle, text: string) =>
		storeRunReport(subagentRunDir(agentDir, handle.record.parentSessionId, handle.runId), { text });
	const admission = createRunAdmission({
		scheduler: generations.scheduler,
		directory,
		agentDir: () => agentDir,
		parentThinkingLevel: () => "off",
		scope,
		pane: () => ORCHESTRATOR_PANE,
		runPane: () => undefined,
		tools: () => [],
		registeredTools: () => [],
		ensureQueue: async () => false,
	});
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
	const orchestrator = async () => {
		await loadModels();
		return async (to: string, content: string) => {
			const result = await generations.messageFromParent(scope.current()!, to, content);
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
		unregistered: (count: number) => {
			refusals = count;
		},
	};
}
