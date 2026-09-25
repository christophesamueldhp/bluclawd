import { describe, expect, it } from "vitest";
import { type BackgroundExec, BackgroundJobRegistry } from "../ext/_shared/background-bash.ts";
import { notificationContent } from "../ext/_shared/monitor-events.ts";
import {
	findOrphanShells,
	orphanShellMessage,
	SHELL_END_ENTRY,
	SHELL_START_ENTRY,
	type ShellStartRecord,
} from "../ext/_shared/orphan-shells.ts";

const start = (taskId: string): { type: string; customType: string; data: ShellStartRecord } => ({
	type: "custom",
	customType: SHELL_START_ENTRY,
	data: { taskId, toolUseId: `toolu_${taskId}`, description: `run ${taskId}`, command: taskId },
});
const end = (taskId: string) => ({ type: "custom", customType: SHELL_END_ENTRY, data: { taskId } });

describe("findOrphanShells (Claude Code's resume scan)", () => {
	it("finds shells started without an end, and sets aside those still running here", () => {
		const { orphans, live } = findOrphanShells(
			[start("b1"), start("b2"), end("b1"), start("b3"), { type: "message" }],
			(id) => id === "b3",
		);
		expect(orphans.map((o) => o.taskId)).toEqual(["b2"]);
		expect(live).toEqual(["b3"]);
	});
});

describe("orphanShellMessage", () => {
	it("says nothing when every shell finished", () => {
		expect(orphanShellMessage([], [])).toBeUndefined();
	});

	it("reports one orphan on its own, as stopped, with Claude Code's note", () => {
		const message = orphanShellMessage([start("b1").data], []);
		expect(message?.content).toBe(
			notificationContent(
				[
					"<task-notification>",
					"<task-id>b1</task-id>",
					"<tool-use-id>toolu_b1</tool-use-id>",
					"<status>stopped</status>",
					"<summary>Background shell command didn't finish before the previous session ended</summary>",
					"<note>No completion record was found for it in the previous session. It may have been stopped (via the UI, Monitor timeout, or agent teardown — these leave no transcript marker), or it may have been running when the previous Claude Code process exited. Check the output file for partial results before assuming it completed.</note>",
					"</task-notification>",
				].join("\n"),
			),
		);
	});

	it("reports two or more in one aggregate, with the scan markers", () => {
		const message = orphanShellMessage([start("b1").data, start("b2").data], ["b3"]);
		expect(message?.content).toBe(
			notificationContent(
				[
					"<task-notification>",
					"<task-id>b1</task-id>",
					"<task-id>b2</task-id>",
					"<task-id>__orphan_summary__:shell</task-id>",
					"<task-id>__orphan_summary_live__:b3</task-id>",
					"<status>stopped</status>",
					"<summary>2 background shell command tasks didn't finish before the previous session ended. Task ids: b1, b2.</summary>",
					'<note>No completion record was found for them in the previous session. They may have been stopped (via the UI, Monitor timeout, or agent teardown — these leave no transcript marker), or they may have been running when the previous Claude Code process exited. They have been marked stopped. Task ids in this notification beginning with "__orphan_summary" are internal scan markers, not tasks.</note>',
					"</task-notification>",
				].join("\n"),
			),
		);
	});

	it("names only the first 20 ids of a long list", () => {
		const many = Array.from({ length: 25 }, (_, i) => start(`b${i}`).data);
		expect(orphanShellMessage(many, [])?.content).toContain(
			`<summary>25 background shell command tasks didn't finish before the previous session ended. First 20 task ids: ${many
				.slice(0, 20)
				.map((o) => o.taskId)
				.join(", ")}.</summary>`,
		);
	});
});

describe("reown (background shells survive /clear)", () => {
	const forever: BackgroundExec = (_c, _w, { signal }) =>
		new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));

	it("hands the old session's running jobs to the new one, and leaves a subagent's alone", () => {
		const registry = new BackgroundJobRegistry({ outputRoot: null });
		const mine = registry.start({ command: "a", cwd: "/", owner: "old", exec: forever });
		const child = registry.start({ command: "b", cwd: "/", owner: "old", agentId: "c", exec: forever });
		expect(registry.reown("old", "new")).toBe(1);
		expect(registry.list("new").map((j) => j.id)).toEqual([mine.id]);
		expect(registry.get(child.id)?.owner).toBe("old");
		registry.kill(mine.id);
		registry.kill(child.id);
	});
});
