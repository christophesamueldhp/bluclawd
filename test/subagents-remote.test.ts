import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startRemoteServer } from "../daemon/remote/http.ts";
import { RemoteStore } from "../daemon/remote/pairing.ts";
import { type AgentTask, notifyAgentTasksChanged, publishAgentTasks } from "../ext/_shared/agent-tasks.ts";
import { applyPaneMessage, buildReport, paneTasks, watchTasks } from "../ext/remote/report.ts";
import { recordBackgroundUsageInLedger, writeFullSubagentReport } from "../ext/subagents/storage.ts";
import { createEmptySubagentUsage } from "../ext/subagents/usage.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-rem-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.unstubAllEnvs();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("Task 9 (M2) — Remote task parity, bounded output, cross-session denial, and background usage", () => {
	it("includes bounded agent tasks with optional status/model/outputFile in paneTasks, updates via watchTasks on notifyAgentTasksChanged, and routes stop_task with remote source", async () => {
		const agentDir = makeTempDir("agent");
		const reportFile = join(agentDir, "report.md");
		writeFileSync(reportFile, "Progress line 1\nProgress line 2\n", "utf8");

		let stopped: { id: string; owner?: string; source?: string } | undefined;
		const task: AgentTask = {
			id: "sub_50_1",
			owner: "sess_phone_1",
			agent: "explorer",
			task: "x".repeat(300),
			startedAt: 5000,
			state: "running",
			status: "queued",
			model: "anthropic/claude-sonnet-4-5",
			outputFile: reportFile,
			output: () => "",
		};
		const unpublish = publishAgentTasks({
			list: (owner) => (owner && owner !== "sess_phone_1" ? [] : [task]),
			get: () => undefined,
			stop: (id, opts) => {
				if (opts?.owner && opts.owner !== "sess_phone_1") return { ok: false, reason: "not_found" };
				stopped = { id, owner: opts?.owner, source: opts?.source };
				return { ok: true, task };
			},
			stopAll: () => 0,
		});

		try {
			// 1. Bounded label (200 chars), optional status + model + outputFile
			const tasks = paneTasks("sess_phone_1");
			expect(tasks).toHaveLength(1);
			expect(tasks[0].id).toBe("sub_50_1");
			expect(tasks[0].kind).toBe("agent");
			expect(tasks[0].label).toHaveLength(200);
			expect(tasks[0].status).toBe("queued");
			expect(tasks[0].model).toBe("anthropic/claude-sonnet-4-5");
			expect(tasks[0].outputFile).toBe(reportFile);

			// Foreign session sees no tasks
			expect(paneTasks("sess_foreign")).toEqual([]);

			// 2. watchTasks fires when notifyAgentTasksChanged() is emitted
			vi.useFakeTimers();
			try {
				const check = vi.fn();
				const offWatch = watchTasks(check);
				notifyAgentTasksChanged();
				await vi.advanceTimersByTimeAsync(300);
				expect(check).toHaveBeenCalledTimes(1);
				offWatch();
			} finally {
				vi.useRealTimers();
			}

			// 3. Remote stop_task routes to the owned agent task with source: "remote"
			const ctx = {
				sessionManager: { getSessionId: () => "sess_phone_1" },
			};
			const reportAgain = vi.fn();
			applyPaneMessage({ type: "stop_task", id: "sub_50_1" }, ctx as never, {} as never, reportAgain);
			expect(stopped).toEqual({
				id: "sub_50_1",
				owner: "sess_phone_1",
				source: "remote",
			});
			expect(reportAgain).not.toHaveBeenCalled();

			// Foreign session stop_task cannot stop `sess_phone_1`'s agent run
			stopped = undefined;
			const foreignCtx = {
				sessionManager: { getSessionId: () => "sess_foreign" },
			};
			applyPaneMessage({ type: "stop_task", id: "sub_50_1" }, foreignCtx as never, {} as never, reportAgain);
			expect(stopped).toBeUndefined();
			expect(reportAgain).toHaveBeenCalledTimes(1);
		} finally {
			unpublish();
		}
	});

	it("serves sanitized bounded agent report output over HTTP and denies cross-session or unauthorized task output access", async () => {
		const dir = makeTempDir("http");
		const webDir = join(dir, "web");
		mkdirSync(webDir, { recursive: true });
		writeFileSync(join(webDir, "index.html"), "<!doctype html><title>ok</title>", "utf8");

		const store = new RemoteStore(join(dir, "remote.json"));
		const pair = store.createCode();
		const claimed = store.claim(pair.code, "Test Phone");
		if (!("token" in claimed)) throw new Error("Failed to claim test pairing token");
		const token = claimed.token;

		const record = {
			runId: "sub_77_1",
			parentSessionId: "sess_A",
			runtimeGeneration: 1,
			parentTurnId: "turn_1",
			originToolCallId: "call_1",
			agentName: "explorer",
			definitionSource: "bundled" as const,
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
			thinkingLevel: "low",
			cwd: dir,
			taskSummary: "Inspect HTTP",
			startSnapshot: { headCommit: null, dirty: false, statusDigest: "" },
			snapshotDrifted: false,
			admittedAt: 1000,
			deliveryMode: "background" as const,
			status: "running" as const,
			complete: false,
			turnCount: 1,
			toolCallCount: 1,
			usage: createEmptySubagentUsage(),
			backgroundDeliveryAttempted: false,
		};
		const written = writeFullSubagentReport(
			dir,
			record,
			"\x1b[31mLine 1: safe report\x1b[0m\nLine 2: <script>alert(1)</script>",
		);
		expect(written.ok).toBe(true);

		const stopCalls: Array<{ sessionId: string; taskId: string }> = [];
		const server = await startRemoteServer(
			{
				store,
				webDir,
				terminalOpen: () => true,
				launch: () => undefined,
				startSession: () => "pane-1",
				renameInstance: () => false,
				setPinned: () => false,
				deleteInstance: () => false,
				listInstances: () => [
					{
						id: "pane-A",
						cwd: dir,
						sessionId: "sess_A",
						sessionFile: join(dir, "sess_A.jsonl"),
						label: "Session A",
						status: "online",
						activity: "working",
						external: true,
					},
					{
						id: "pane-B",
						cwd: dir,
						sessionId: "sess_B",
						sessionFile: join(dir, "sess_B.jsonl"),
						label: "Session B",
						status: "online",
						activity: "idle",
						external: true,
					},
				],
				report: (sessionId) => {
					if (sessionId === "pane-A") {
						return {
							models: [],
							tasks: [
								{
									id: "sub_77_1",
									kind: "agent",
									label: "explorer: Inspect HTTP",
									startedAt: 1000,
									status: "running",
									model: "anthropic/claude-sonnet-4-5",
									outputFile: written.reportPath,
								},
							],
						};
					}
					if (sessionId === "pane-B") {
						return { models: [], tasks: [] };
					}
					return undefined;
				},
				send: (sessionId, msg) => {
					if (msg.type === "stop_task") {
						stopCalls.push({ sessionId, taskId: msg.id });
						return true;
					}
					return false;
				},
			},
			0,
		);

		try {
			const headers = {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			};

			// 1. Status endpoint strips raw `outputFile` path and replaces it with `output: true`
			const statusRes = await fetch(`http://127.0.0.1:${server.port}/api/sessions/pane-A/status`, {
				headers,
			});
			expect(statusRes.status).toBe(200);
			const statusBody = (await statusRes.json()) as {
				report: { tasks: Array<Record<string, unknown>> };
			};
			expect(statusBody.report.tasks).toEqual([
				{
					id: "sub_77_1",
					kind: "agent",
					label: "explorer: Inspect HTTP",
					startedAt: 1000,
					status: "running",
					model: "anthropic/claude-sonnet-4-5",
					output: true,
				},
			]);

			// 2. Output endpoint returns sanitized lines for `pane-A`
			const outRes = await fetch(`http://127.0.0.1:${server.port}/api/sessions/pane-A/tasks/sub_77_1/output`, {
				headers,
			});
			expect(outRes.status).toBe(200);
			const outBody = (await outRes.json()) as { lines: string[]; size: number };
			expect(outBody.lines).toEqual(["Line 1: safe report", "Line 2: <script>alert(1)</script>"]);

			// 3. Cross-session access (`pane-B` asking for `sub_77_1` output or stop) is denied with 404 unknown_task
			const crossOut = await fetch(`http://127.0.0.1:${server.port}/api/sessions/pane-B/tasks/sub_77_1/output`, {
				headers,
			});
			expect(crossOut.status).toBe(404);

			const crossStop = await fetch(`http://127.0.0.1:${server.port}/api/sessions/pane-B/tasks/sub_77_1/stop`, {
				method: "POST",
				headers,
				body: "{}",
			});
			expect(crossStop.status).toBe(404);
			expect(stopCalls).toEqual([]);

			// 4. Authorized stop on `pane-A` succeeds
			const okStop = await fetch(`http://127.0.0.1:${server.port}/api/sessions/pane-A/tasks/sub_77_1/stop`, {
				method: "POST",
				headers,
				body: "{}",
			});
			expect(okStop.status).toBe(202);
			expect(stopCalls).toEqual([{ sessionId: "pane-A", taskId: "sub_77_1" }]);
		} finally {
			await server.close();
		}
	});

	it.each([false, true])(
		"reports separate background usage without double-counting and preserves unknown pricing=%s",
		(hasUnknownCost) => {
			const home = makeTempDir("home");
			vi.stubEnv("HOME", home);
			for (const key of Object.keys(process.env)) {
				if (key.endsWith("_CODING_AGENT_DIR")) vi.stubEnv(key, undefined);
			}
			const agentDir = getAgentDir();
			mkdirSync(agentDir, { recursive: true });

			const sessionId = "sess_usage_parity";
			recordBackgroundUsageInLedger(agentDir, {
				runId: "sub_bg_ledger_1",
				parentSessionId: sessionId,
				usage: {
					...createEmptySubagentUsage(),
					hasUnknownCost,
					input: 300,
					output: 100,
					totalTokens: 400,
					cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
				},
			});

			const ctx = {
				model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet", reasoning: false },
				modelRegistry: { getAvailable: () => [], find: () => undefined },
				getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
				sessionManager: {
					getSessionId: () => sessionId,
					getEntries: () => [
						// Foreground toolResult usage (already in native transcript entries)
						{
							type: "message",
							message: {
								role: "toolResult",
								usage: { input: 50, output: 25, cacheRead: 0, cacheWrite: 0, cost: { total: 0.005 } },
							},
						},
					],
				},
				cwd: "/proj",
				isProjectTrusted: () => true,
			};
			const pi = {
				getThinkingLevel: () => "off",
				getCommands: () => [],
			};

			const report = buildReport(ctx as never, pi as never, () => "ask");
			// Foreground usage is counted once in `report.usage`
			expect(report.usage).toEqual({
				input: 50,
				output: 25,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0.005,
			});
			// Background subagent usage is reported separately in `report.backgroundSubagentUsage`
			expect(report.backgroundSubagentUsage).toEqual({
				runCount: 1,
				input: 300,
				output: 100,
				cacheRead: 0,
				cacheWrite: 0,
				cost: hasUnknownCost ? null : 0.03,
			});
		},
	);
});
