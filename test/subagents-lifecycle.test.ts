import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getSystemMessageText,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentTasks } from "../ext/_shared/agent-tasks.ts";
import { holdNotifications } from "../ext/background-bash/notification-hold.ts";
import { createSubagentsExtension, SUBAGENT_NOTIFICATION_CUSTOM_TYPE } from "../ext/subagents/index.ts";
import { readPersistedRunRecord } from "../ext/subagents/storage.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-life-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			// A cancelled run may still be writing its final record; retry while the directory refills.
			rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
		}
	}
});

function isChildContext(context: TranscriptContext): boolean {
	const sys = context.messages.find((m) => m.role === "system");
	const sysText = sys && sys.role === "system" ? getSystemMessageText(sys) : "";
	return sysText.includes("subagent operating in a fresh context");
}

async function createLifecycleSession(cwd: string, agentDir: string) {
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	const faux = fauxProvider({
		provider: "faux-life",
		models: [{ id: "faux-life-model", reasoning: false }],
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			createSubagentsExtension({
				agentDir,
				batchWindowMs: 0,
			}),
		],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model: faux.getModel("faux-life-model"),
		noTools: "builtin",
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
	});
	await session.bindExtensions({ mode: "tui" });
	return { session, faux, modelRuntime };
}

describe("Task 7 (M2) — Parent lifecycle transitions, branch ownership, and notification holds", () => {
	it("rechecks ownership when a notification hold is released after a session switch or reload so stale reports never enter the replacement conversation", async () => {
		const cwd = makeTempDir("hold-cwd");
		const agentDir = makeTempDir("hold-agent");
		const { session, faux } = await createLifecycleSession(cwd, agentDir);

		const releaseHold = holdNotifications();
		try {
			let finishChild!: () => void;
			const childGate = new Promise<void>((r) => {
				finishChild = r;
			});
			let parentTurnCount = 0;

			const step = async (context: TranscriptContext) => {
				if (isChildContext(context)) {
					await childGate;
					return fauxAssistantMessage(
						"### Scope\n- `a.ts`\n### Summary\nCompleted during hold\n### Evidence\n- `a.ts:1`\n### Blockers\n- none",
					);
				}
				parentTurnCount++;
				if (parentTurnCount === 1) {
					return fauxAssistantMessage([
						fauxToolCall(
							"subagent",
							{ agent: "explorer", task: "Run while panel holds notifications", background: true },
							{ id: "c_hold" },
						),
					]);
				}
				return fauxAssistantMessage("Launched under hold.");
			};

			faux.setResponses([step, step, step]);

			await session.prompt("Launch background run while hold is active.", {
				expandPromptTemplates: false,
			});

			const oldSessionId = session.sessionId;
			const active = agentTasks()?.list(oldSessionId) ?? [];
			expect(active).toHaveLength(1);
			const runId = active[0].id;

			// Child finishes while notifications are held -> queued in notificationHold
			finishChild();
			await vi.waitFor(
				() => {
					expect(readPersistedRunRecord(agentDir, oldSessionId, runId)?.status).toBe("completed");
				},
				{ timeout: 3000, interval: 20 },
			);

			// Now simulate session replacement (`session_before_switch`)
			await session.extensionRunner.emit({
				type: "session_before_switch",
				reason: "new",
			});

			// Release the notification hold AFTER session switch -> second ownership check drops the stale callback!
			releaseHold();

			const staleMessages = session.messages.filter(
				(m) =>
					m.role === "custom" && (m as { customType?: string }).customType === SUBAGENT_NOTIFICATION_CUSTOM_TYPE,
			);
			expect(staleMessages).toHaveLength(0);
		} finally {
			releaseHold();
			session.dispose();
		}
	});

	it.each([
		["a session switch", { type: "session_before_switch", reason: "new" }],
		["a reload", { type: "session_start", reason: "reload" }],
	] as const)("cancels a running background child on %s", async (_label, event) => {
		const cwd = makeTempDir("invalidate-cwd");
		const agentDir = makeTempDir("invalidate-agent");
		const { session, faux } = await createLifecycleSession(cwd, agentDir);
		let releaseChild!: () => void;
		const childGate = new Promise<void>((r) => {
			releaseChild = r;
		});
		try {
			let parentTurnCount = 0;
			const step = async (context: TranscriptContext) => {
				if (isChildContext(context)) {
					await childGate;
					return fauxAssistantMessage("Should be cancelled by the invalidation.");
				}
				parentTurnCount++;
				return parentTurnCount === 1
					? fauxAssistantMessage([
							fauxToolCall(
								"subagent",
								{ agent: "explorer", task: "Outlive the parent session", background: true },
								{ id: "c_invalidate" },
							),
						])
					: fauxAssistantMessage("Started.");
			};
			faux.setResponses([step, step, step]);
			await session.prompt("Start a background child.", { expandPromptTemplates: false });
			const sessionId = session.sessionId;
			const [task] = agentTasks()?.list(sessionId) ?? [];
			await vi.waitFor(() => expect(agentTasks()?.list(sessionId)[0]?.status).toBe("running"), {
				timeout: 3000,
				interval: 20,
			});

			await session.extensionRunner.emit(event);
			releaseChild();
			await vi.waitFor(
				() => {
					expect(readPersistedRunRecord(agentDir, sessionId, task.id)).toMatchObject({
						status: "cancelled",
						stopSource: "session_invalidated",
					});
				},
				{ timeout: 3000, interval: 20 },
			);
		} finally {
			releaseChild();
			session.dispose();
		}
	});

	it("cancels background runs whose originating entry is no longer on the active branch after tree navigation", async () => {
		const cwd = makeTempDir("tree-cwd");
		const agentDir = makeTempDir("tree-agent");
		const { session, faux } = await createLifecycleSession(cwd, agentDir);

		try {
			// Turn 1: initial user prompt to create an anchor entry on the root branch
			faux.setResponses([fauxAssistantMessage("Anchor turn 1 complete.")]);
			await session.prompt("Initial anchor prompt.", { expandPromptTemplates: false });
			const anchorEntryId = session.sessionManager.getLeafId()!;
			expect(anchorEntryId).toBeDefined();

			// Turn 2: launch a background subagent on the descendant branch
			let releaseChild!: () => void;
			const childGate = new Promise<void>((r) => {
				releaseChild = r;
			});
			let parentTurnCount = 0;

			const step = async (context: TranscriptContext) => {
				if (isChildContext(context)) {
					await childGate;
					return fauxAssistantMessage("Should be cancelled when branch is rewound.");
				}
				parentTurnCount++;
				if (parentTurnCount === 1) {
					return fauxAssistantMessage([
						fauxToolCall(
							"subagent",
							{ agent: "explorer", task: "Branch-bound background task", background: true },
							{ id: "c_tree_bg" },
						),
					]);
				}
				return fauxAssistantMessage("Started branch-bound child.");
			};

			faux.setResponses([step, step, step]);

			await session.prompt("Start child on turn 2.", { expandPromptTemplates: false });
			const tasksBeforeTree = agentTasks()?.list(session.sessionId) ?? [];
			expect(tasksBeforeTree).toHaveLength(1);
			const runId = tasksBeforeTree[0].id;

			// Navigate tree back to anchorEntryId (abandoning turn 2's branch!)
			const navResult = await session.navigateTree(anchorEntryId, { summarize: false });
			expect(navResult.cancelled).toBe(false);

			// Unblock child so abort settles cleanly
			releaseChild();
			await vi.waitFor(
				() => {
					const persisted = readPersistedRunRecord(agentDir, session.sessionId, runId);
					expect(persisted?.status).toBe("cancelled");
					expect(persisted?.stopSource).toBe("session_invalidated");
				},
				{ timeout: 3000, interval: 20 },
			);

			// Confirm no notification was delivered to the rewound branch
			const notices = session.messages.filter(
				(m) =>
					m.role === "custom" && (m as { customType?: string }).customType === SUBAGENT_NOTIFICATION_CUSTOM_TYPE,
			);
			expect(notices).toHaveLength(0);
		} finally {
			session.dispose();
		}
	});
});
