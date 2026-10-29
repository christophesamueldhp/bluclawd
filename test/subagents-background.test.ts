import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { agentTasks, subscribeAgentTasks } from "../ext/_shared/agent-tasks.ts";
import { createSubagentsExtension, SUBAGENT_NOTIFICATION_CUSTOM_TYPE } from "../ext/subagents/index.ts";
import { readBackgroundUsageLedger, readPersistedRunRecord } from "../ext/subagents/storage.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-bg-${prefix}-`));
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

function initGitRepo(cwd: string): void {
	execFileSync("git", ["init", "-q"], { cwd });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd });
	writeFileSync(join(cwd, "tracked.ts"), "export const v = 1;\n", "utf8");
	execFileSync("git", ["add", "tracked.ts"], { cwd });
	execFileSync("git", ["commit", "-qm", "initial"], { cwd });
}

function isChildContext(context: TranscriptContext): boolean {
	const sys = context.messages.find((m) => m.role === "system");
	const sysText = sys && sys.role === "system" ? getSystemMessageText(sys) : "";
	return sysText.includes("subagent operating in a fresh context");
}

function lastUserText(context: TranscriptContext): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const msg = context.messages[i];
		if (msg.role === "user") {
			if (typeof msg.content === "string") return msg.content;
			return msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		}
	}
	return "";
}

async function createTestSession(options: {
	cwd: string;
	agentDir: string;
	mode?: "tui" | "rpc" | "print" | "json";
	batchWindowMs?: number;
	tokensPerSecond?: number;
}) {
	const modelRuntime = await ModelRuntime.create({
		authPath: join(options.agentDir, "auth.json"),
		modelsPath: join(options.agentDir, "models.json"),
		modelsStorePath: join(options.agentDir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	const faux = fauxProvider({
		provider: "faux-bg",
		tokensPerSecond: options.tokensPerSecond,
		models: [
			{
				id: "faux-bg-model",
				reasoning: true,
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			},
		],
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		extensionFactories: [
			createSubagentsExtension({
				agentDir: options.agentDir,
				batchWindowMs: options.batchWindowMs ?? 15,
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
		cwd: options.cwd,
		agentDir: options.agentDir,
		modelRuntime,
		model: faux.getModel("faux-bg-model"),
		thinkingLevel: "low",
		noTools: "builtin",
		resourceLoader,
		sessionManager: SessionManager.inMemory(options.cwd),
		settingsManager,
	});

	await session.bindExtensions({
		mode: options.mode ?? "tui",
	});

	return { session, faux };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for background condition");
		}
		await new Promise((r) => setTimeout(r, 15));
	}
}

describe("Task 7 (M2) — Background execution, session-bound delivery, drift warnings, and usage ledger", () => {
	it("admits background runs with immediate acknowledgement, survives parent turn completion, detects workspace drift when parent modifies files, and records separate background usage", async () => {
		const cwd = makeTempDir("drift-cwd");
		const agentDir = makeTempDir("drift-agent");
		initGitRepo(cwd);

		const { session, faux } = await createTestSession({
			cwd,
			agentDir,
			mode: "rpc", // Prove RPC mode works for background subagents
		});

		try {
			let resolveChildStep!: () => void;
			const childGate = new Promise<void>((r) => {
				resolveChildStep = r;
			});
			let parentTurnCount = 0;

			const step = async (context: TranscriptContext) => {
				if (isChildContext(context)) {
					await childGate;
					return fauxAssistantMessage(
						[
							"### Scope",
							"- Inspected: `tracked.ts`",
							"### Summary",
							"`tracked.ts` exports `v = 1`.",
							"### Evidence",
							"- `tracked.ts:1` — `export const v = 1;`",
							"### Blockers",
							"- none",
						].join("\n"),
					);
				}
				parentTurnCount++;
				if (parentTurnCount === 1) {
					return fauxAssistantMessage([
						fauxToolCall(
							"subagent",
							{
								agent: "explorer",
								task: "Inspect tracked.ts in background",
								background: true,
							},
							{ id: "call_bg_1" },
						),
					]);
				}
				if (parentTurnCount === 2) {
					return fauxAssistantMessage("Background explorer launched; continuing parent work.");
				}
				return fauxAssistantMessage("Received background report with drift notice.");
			};

			faux.setResponses([step, step, step, step]);

			await session.prompt("Launch background explorer.", { expandPromptTemplates: false });
			expect(session.getLastAssistantText()).toBe("Background explorer launched; continuing parent work.");

			const launch = session.messages.find(
				(m) => m.role === "toolResult" && (m as { toolCallId?: string }).toolCallId === "call_bg_1",
			) as { content?: Array<{ type: string; text?: string }> } | undefined;
			const launchText = launch?.content?.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
			expect(launchText).toContain("Status: starting");
			expect(launchText).not.toMatch(/queued|deadline|max \d+ active/i);

			// Background child is still alive after parent turn completed!
			const activeList = agentTasks()?.list(session.sessionId) ?? [];
			expect(activeList).toHaveLength(1);
			const runId = activeList[0].id;

			// Modify tracked.ts in the parent working tree while the background child is running
			writeFileSync(join(cwd, "tracked.ts"), "export const v = 2;\n", "utf8");

			// The run may leave /tasks only once its report, ledger entry and terminal record are durable
			const durableWhenUnlisted = new Promise<unknown>((resolve) => {
				const off = subscribeAgentTasks(() => {
					if ((agentTasks()?.list(session.sessionId) ?? []).length > 0) return;
					off();
					const record = readPersistedRunRecord(agentDir, session.sessionId, runId);
					resolve({
						status: record?.status,
						reportWritten: record?.reportPath !== undefined,
						ledgered: readBackgroundUsageLedger(agentDir, session.sessionId).recordedRunIds.includes(runId),
					});
				});
			});

			// Let background child complete
			resolveChildStep();
			expect(await durableWhenUnlisted).toEqual({ status: "completed", reportWritten: true, ledgered: true });

			await waitForCondition(() => {
				return session.messages.some(
					(m) =>
						m.role === "custom" &&
						(m as { customType?: string }).customType === SUBAGENT_NOTIFICATION_CUSTOM_TYPE,
				);
			});
			await session.waitForIdle();

			const customNotice = session.messages.find(
				(m) =>
					m.role === "custom" && (m as { customType?: string }).customType === SUBAGENT_NOTIFICATION_CUSTOM_TYPE,
			) as { content?: Array<{ type: string; text?: string }> } | undefined;
			expect(customNotice).toBeDefined();
			const noticeText = customNotice?.content?.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
			expect(noticeText).toContain(`Run: ${runId}`);
			expect(noticeText).toContain("DRIFT WARNING");

			// Verify persisted record and separate background usage ledger
			const persisted = readPersistedRunRecord(agentDir, session.sessionId, runId);
			expect(persisted?.status).toBe("completed");
			expect(persisted?.snapshotDrifted).toBe(true);
			expect(persisted?.backgroundDeliveryAttempted).toBe(true);

			const ledger = readBackgroundUsageLedger(agentDir, session.sessionId);
			expect(ledger.runCount).toBe(1);
			expect(ledger.recordedRunIds).toEqual([runId]);
			expect(ledger.usage.totalTokens).toBeGreaterThan(0);
		} finally {
			session.dispose();
		}
	});

	it("batches closely arriving background completions into a single parent wake-up and delivers failure/timeout outcomes", async () => {
		const cwd = makeTempDir("batch-cwd");
		const agentDir = makeTempDir("batch-agent");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\n", "utf8");

		const { session, faux } = await createTestSession({
			cwd,
			agentDir,
			batchWindowMs: 40,
		});

		try {
			let releaseBoth!: () => void;
			const bothGate = new Promise<void>((r) => {
				releaseBoth = r;
			});
			let parentTurnCount = 0;

			const step = async (context: TranscriptContext) => {
				if (isChildContext(context)) {
					await bothGate;
					// The task is the first line; later lines list sibling tasks.
					if (lastUserText(context).split("\n")[0].includes("fails")) {
						return fauxAssistantMessage("", {
							stopReason: "error",
							errorMessage: "429 Rate limit exceeded",
						});
					}
					return fauxAssistantMessage(
						"### Scope\n- `src/a.ts`\n### Summary\nRun 1 ok\n### Evidence\n- `src/a.ts:1`\n### Blockers\n- none",
					);
				}
				parentTurnCount++;
				if (parentTurnCount === 1) {
					return fauxAssistantMessage([
						fauxToolCall(
							"subagent",
							{ agent: "explorer", task: "Background run 1", background: true },
							{ id: "bg_a" },
						),
						fauxToolCall(
							"subagent",
							{ agent: "reviewer", task: "Background run 2 (fails)", background: true },
							{ id: "bg_b" },
						),
					]);
				}
				if (parentTurnCount === 2) {
					return fauxAssistantMessage("Launched two background runs.");
				}
				return fauxAssistantMessage("Processed batched completion notice.");
			};

			faux.setResponses([step, step, step, step, step]);

			await session.prompt("Start two background runs.", { expandPromptTemplates: false });
			expect(agentTasks()?.list(session.sessionId)).toHaveLength(2);

			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldClearNativeTimers: true });
			const bothTerminal = new Promise<void>((resolve) => {
				const off = subscribeAgentTasks(() => {
					if (agentTasks()?.list(session.sessionId).length === 0) {
						off();
						resolve();
					}
				});
			});
			releaseBoth();
			await bothTerminal;
			await vi.advanceTimersByTimeAsync(40);

			await waitForCondition(() => {
				return session.messages.some(
					(m) =>
						m.role === "custom" &&
						(m as { customType?: string }).customType === SUBAGENT_NOTIFICATION_CUSTOM_TYPE,
				);
			});
			await session.waitForIdle();

			const notices = session.messages.filter(
				(m) =>
					m.role === "custom" && (m as { customType?: string }).customType === SUBAGENT_NOTIFICATION_CUSTOM_TYPE,
			);
			// Both completions batched into one notification message!
			expect(notices).toHaveLength(1);
			const text =
				(notices[0] as { content?: Array<{ type: string; text?: string }> }).content
					?.map((c) => (c.type === "text" ? c.text : ""))
					.join("") ?? "";
			expect(text).toContain("2 background subagents finished");
			expect(text).toContain("Execution: completed");
			expect(text).toContain("Execution: failed");
			expect(text).toContain("429 Rate limit exceeded");
		} finally {
			session.dispose();
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("drops a pending completion timer after SDK disposal even without a shutdown event", async () => {
		const cwd = makeTempDir("disposed-cwd");
		const agentDir = makeTempDir("disposed-agent");
		const { session, faux } = await createTestSession({ cwd, agentDir, batchWindowMs: 40 });
		let releaseChild!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let parentTurns = 0;
		const step = async (context: TranscriptContext) => {
			if (isChildContext(context)) {
				await gate;
				return fauxAssistantMessage("Finished child.");
			}
			return ++parentTurns === 1
				? fauxAssistantMessage([
						fauxToolCall(
							"subagent",
							{ agent: "explorer", task: "Bounded task", background: true },
							{ id: "disposed_bg" },
						),
					])
				: fauxAssistantMessage("Parent done.");
		};
		faux.setResponses([step, step, step]);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			await session.prompt("Start child.", { expandPromptTemplates: false });
			const terminal = new Promise<void>((resolve) => {
				const off = subscribeAgentTasks(() => {
					if (agentTasks()?.list(session.sessionId).length === 0) {
						off();
						resolve();
					}
				});
			});
			releaseChild();
			await terminal;
			await Promise.resolve();
			const messageCount = session.messages.length;
			session.dispose();
			await vi.advanceTimersByTimeAsync(40);
			expect(session.messages).toHaveLength(messageCount);
		} finally {
			releaseChild();
			session.dispose();
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("does not trigger an unsolicited parent turn when the user explicitly stops a background subagent", async () => {
		const cwd = makeTempDir("stop-cwd");
		const agentDir = makeTempDir("stop-agent");

		const { session, faux } = await createTestSession({
			cwd,
			agentDir,
			tokensPerSecond: 5,
		});

		try {
			let parentTurnCount = 0;
			const step = async (context: TranscriptContext) => {
				if (isChildContext(context)) {
					return fauxAssistantMessage("Slow child output ".repeat(50));
				}
				parentTurnCount++;
				if (parentTurnCount === 1) {
					return fauxAssistantMessage([
						fauxToolCall(
							"subagent",
							{ agent: "explorer", task: "Long background task", background: true },
							{ id: "bg_stop" },
						),
					]);
				}
				return fauxAssistantMessage("Parent finished launch turn.");
			};

			faux.setResponses([step, step, step]);

			await session.prompt("Launch and user-stop.", { expandPromptTemplates: false });
			const tasks = agentTasks()?.list(session.sessionId) ?? [];
			expect(tasks).toHaveLength(1);
			const runId = tasks[0].id;

			// User stops via agentTasks().stop(runId)
			expect(agentTasks()?.stop(runId, { owner: session.sessionId, source: "user" }).ok).toBe(true);

			await waitForCondition(() => {
				const rec = readPersistedRunRecord(agentDir, session.sessionId, runId);
				return rec?.status === "cancelled";
			});

			// Wait 80ms to ensure no delayed batch notification arrives
			await new Promise((r) => setTimeout(r, 80));

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
