import { describe, expect, it } from "vitest";
import {
	type AgentTaskSource,
	agentTasks,
	notifyAgentTasksChanged,
	publishAgentTasks,
	subscribeAgentTasks,
} from "../ext/_shared/agent-tasks.ts";

describe("Task 8 (M2) — AgentTaskSource publication and change notifications", () => {
	it("publishes active source, notifies subscribers on state changes, and prevents a stale unpublisher from removing its replacement", () => {
		const events: number[] = [];
		const off = subscribeAgentTasks(() => {
			events.push(events.length + 1);
		});

		const source1: AgentTaskSource = {
			list: () => [
				{
					id: "sub_1_1",
					owner: "sess_1",
					agent: "explorer",
					task: "Task 1",
					startedAt: 100,
					state: "running",
					status: "running",
					model: "faux/faux-1",
					outputFile: "",
					output: () => "",
				},
			],
			get: () => undefined,
			stop: () => ({ ok: false, reason: "not_found" }),
			stopAll: () => 0,
		};

		const source2: AgentTaskSource = {
			list: () => [
				{
					id: "sub_2_1",
					owner: "sess_2",
					agent: "reviewer",
					task: "Task 2",
					startedAt: 200,
					state: "running",
					status: "running",
					model: "faux/faux-1",
					outputFile: "",
					output: () => "",
				},
			],
			get: () => undefined,
			stop: () => ({ ok: false, reason: "not_found" }),
			stopAll: () => 0,
		};

		try {
			const unpublish1 = publishAgentTasks(source1);
			expect(agentTasks()).toBe(source1);
			expect(events.length).toBe(1);

			notifyAgentTasksChanged();
			expect(events.length).toBe(2);

			// Replace with source2 before unpublish1 runs (simulating reload cleanup race)
			const unpublish2 = publishAgentTasks(source2);
			expect(agentTasks()).toBe(source2);
			expect(events.length).toBe(3);

			// Stale unpublish1 must NOT clobber source2!
			unpublish1();
			expect(agentTasks()).toBe(source2);
			expect(agentTasks()?.list()[0].id).toBe("sub_2_1");

			// Active unpublish2 removes source2 cleanly
			unpublish2();
			expect(agentTasks()).toBeUndefined();
		} finally {
			off();
		}
	});
});
