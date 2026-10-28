import { describe, expect, it } from "vitest";
import { stripAnsi } from "../daemon/ansi.ts";
import { publishAgentTasks } from "../ext/_shared/agent-tasks.ts";
import backgroundBash from "../ext/background-bash/index.ts";
import { TasksDialog } from "../ext/background-bash/tasks-dialog.ts";
import type { SubagentRunRecord } from "../ext/subagents/runs.ts";
import { createEmptySubagentUsage } from "../ext/subagents/usage.ts";

const theme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
} as any;

function getTaskStopTool() {
	let tool: any;
	const noop = () => {};
	backgroundBash({
		on: noop,
		registerEntryRenderer: noop,
		registerCommand: noop,
		registerMessageRenderer: noop,
		registerTool: (t: any) => {
			if (t?.name === "task_stop") tool = t;
		},
	} as any);
	return (params: Record<string, string>, owner = "sess_main") =>
		tool.execute("call_stop", params, undefined, undefined, {
			sessionManager: { getSessionId: () => owner },
		});
}

function makeAgentRunRecord(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
	return {
		runId: "sub_99_1",
		parentSessionId: "sess_main",
		runtimeGeneration: 1,
		parentTurnId: "turn_1",
		originToolCallId: "call_1",
		agentName: "explorer",
		definitionSource: "bundled",
		provider: "anthropic",
		modelId: "claude-sonnet-4-5",
		thinkingLevel: "low",
		cwd: "/proj",
		taskSummary: "Inspect architecture",
		startSnapshot: { headCommit: "1234567", dirty: false, statusDigest: "" },
		snapshotDrifted: false,
		admittedAt: 1000,
		startedAt: 1010,
		deliveryMode: "background",
		status: "running",
		complete: false,
		turnCount: 1,
		toolCallCount: 2,
		usage: createEmptySubagentUsage(),
		backgroundDeliveryAttempted: false,
		...overrides,
	};
}

describe("Task 8 (M2) — Subagent task_stop routing and /tasks dialog integration", () => {
	it("routes agent IDs through the existing task_stop tool, tracks stop source, enforces session ownership, and rejects finished runs", async () => {
		const stopTool = getTaskStopTool();
		const records = new Map<string, SubagentRunRecord>([
			["sub_10_1", makeAgentRunRecord({ runId: "sub_10_1", parentSessionId: "sess_main", status: "running" })],
			["sub_10_2", makeAgentRunRecord({ runId: "sub_10_2", parentSessionId: "sess_other", status: "running" })],
			[
				"sub_10_3",
				makeAgentRunRecord({
					runId: "sub_10_3",
					parentSessionId: "sess_main",
					status: "completed",
					complete: true,
				}),
			],
		]);

		let observedStopSource: string | undefined;
		const unpublish = publishAgentTasks({
			list: (owner) =>
				Array.from(records.values())
					.filter((r) => (!owner || r.parentSessionId === owner) && r.status === "running")
					.map((r) => ({
						id: r.runId,
						owner: r.parentSessionId,
						agent: r.agentName,
						task: r.taskSummary,
						startedAt: r.startedAt ?? r.admittedAt,
						status: r.status,
					})),
			stop: (id, opts) => {
				const rec = records.get(id);
				if (!rec || (opts?.owner && rec.parentSessionId !== opts.owner)) return false;
				observedStopSource = opts?.source;
				rec.status = "stopping";
				return true;
			},
			getRun: (id, owner) => {
				const rec = records.get(id);
				if (!rec || (owner && rec.parentSessionId !== owner)) return undefined;
				return rec;
			},
		});

		try {
			// 1. Stop owned running subagent
			const res = await stopTool({ task_id: "sub_10_1" }, "sess_main");
			const parsed = JSON.parse(res.content[0].text);
			expect(parsed).toEqual({
				message: "Successfully stopped task: sub_10_1 (explorer: Inspect architecture)",
				task_id: "sub_10_1",
				task_type: "local_agent",
				command: "explorer: Inspect architecture",
			});
			expect(observedStopSource).toBe("model");
			expect(records.get("sub_10_1")?.status).toBe("stopping");

			// 2. Cross-session stop attempt fails without disclosing foreign task content
			await expect(stopTool({ task_id: "sub_10_2" }, "sess_main")).rejects.toThrow(
				"No task found with ID: sub_10_2",
			);

			// 3. Already completed subagent reports terminal status
			await expect(stopTool({ task_id: "sub_10_3" }, "sess_main")).rejects.toThrow(
				"Task sub_10_3 is not running (status: completed)",
			);
		} finally {
			unpublish();
		}
	});

	it("renders active agent states (starting, running, stopping), sanitized output tails, and retains an open detail view when a child completes", () => {
		const run1 = makeAgentRunRecord({
			runId: "sub_20_1",
			agentName: "explorer",
			taskSummary: "Scan auth",
			status: "running",
			startedAt: 2000,
		});
		const run2 = makeAgentRunRecord({
			runId: "sub_20_2",
			agentName: "reviewer",
			taskSummary: "Review diff",
			status: "starting",
			startedAt: 3000,
		});

		const runs = new Map<string, SubagentRunRecord>([
			[run1.runId, run1],
			[run2.runId, run2],
		]);

		let stoppedByDialog: { id: string; source?: string } | undefined;
		const unpublish = publishAgentTasks({
			list: (owner) =>
				Array.from(runs.values())
					.filter((r) => (!owner || r.parentSessionId === owner) && r.status !== "completed")
					.map((r) => ({
						id: r.runId,
						owner: r.parentSessionId,
						agent: r.agentName,
						task: r.taskSummary,
						startedAt: r.startedAt ?? r.admittedAt,
						status: r.status,
						model: `${r.provider}/${r.modelId}`,
						output: () => "\x1b[31mScanning src/auth.ts:12\x1b[0m\nFound token check",
					})),
			stop: (id, opts) => {
				const rec = runs.get(id);
				if (!rec) return false;
				stoppedByDialog = { id, source: opts?.source };
				rec.status = "stopping";
				return true;
			},
			getRun: (id, owner) => {
				const r = runs.get(id);
				if (!r || (owner && r.parentSessionId !== owner)) return undefined;
				return r;
			},
			getReport: (id) => `Final completed report for ${id}\nEvidence: src/auth.ts:12`,
		});

		try {
			const dialog = new TasksDialog(
				theme,
				"sess_main",
				() => {},
				() => {},
			);
			const renderScreen = () => stripAnsi(dialog.render(100).join("\n"));

			// List view shows both starting and running states under Local agents
			const listOut = renderScreen();
			expect(listOut).toContain("2 active agents");
			expect(listOut).toContain("reviewer: Review diff");
			expect(listOut).toContain("starting");
			expect(listOut).toContain("explorer: Scan auth");
			expect(listOut).toContain("running");

			// Move down to `sub_20_1` (explorer) and press Enter to open detail view
			dialog.handleInput("\x1b[B");
			dialog.handleInput("\r");

			const detailOut = renderScreen();
			expect(detailOut).toContain("Agent details");
			expect(detailOut).toContain("Model:    anthropic/claude-sonnet-4-5");
			expect(detailOut).toContain("Task:     explorer: Scan auth");
			expect(detailOut).toContain("Scanning src/auth.ts:12");
			expect(detailOut).not.toContain("\x1b[31m");

			// Press `x` in detail view -> transitions to `stopping` and records user stop source
			dialog.handleInput("x");
			expect(stoppedByDialog).toEqual({ id: "sub_20_1", source: "user" });
			expect(renderScreen()).toContain("Status:   stopping");

			// Now simulate `sub_20_1` completing while detail view is still open -> stays open with final report until dismissed!
			run1.status = "completed";
			run1.endedAt = 4000;
			const completedDetailOut = renderScreen();
			expect(completedDetailOut).toContain("Agent details");
			expect(completedDetailOut).toContain("Status:   completed");
			expect(completedDetailOut).toContain("Final completed report for sub_20_1");
		} finally {
			unpublish();
		}
	});
});
