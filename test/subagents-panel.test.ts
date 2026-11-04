import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { agentTasks } from "../ext/_shared/agent-tasks.ts";
import { createSubagentTui, gate, launch, REPORT, type SubagentTui } from "./helpers/subagent-tui.ts";
import { waitFor } from "./helpers/wait-for.ts";

let tui: SubagentTui | undefined;
afterEach(() => {
	tui?.dispose();
	tui = undefined;
});

const row = (t: SubagentTui, name: string) => t.panel().find((line) => line.trim().startsWith(`${name} `));
const prompt = (t: SubagentTui, text = "Delegate.") => t.session.prompt(text, { expandPromptTemplates: false });

describe("the run panel below the prompt", () => {
	it("shows nothing when there are no runs", async () => {
		tui = await createSubagentTui();
		tui.script([() => fauxAssistantMessage("Nothing to delegate.")]);
		await prompt(tui, "Hello.");
		expect(tui.panel()).toEqual([]);
	});

	it("shows a background run below the prompt with its name, agent, model and status", async () => {
		tui = await createSubagentTui();
		const child = gate();
		tui.script([launch(["scout"], { background: true })], async () => {
			await child.wait;
			return fauxAssistantMessage(REPORT);
		});
		await prompt(tui);

		expect(tui.widget("subagents:panel")?.placement).toBe("belowEditor");
		const scout = await waitFor(() => row(tui!, "scout") ?? false);
		expect(scout).toContain("explorer");
		expect(scout).toContain("faux-tool/faux-main");
		expect(scout).toMatch(/running|starting/);
		child.open();
	});

	it("shows how long a run has been going and its latest progress text", async () => {
		tui = await createSubagentTui();
		const child = gate();
		tui.script([launch(["scout"], { background: true })], async () => {
			await child.wait;
			return fauxAssistantMessage(REPORT);
		});
		await prompt(tui);
		await waitFor(() => row(tui!, "scout") ?? false);

		tui.advance(12_000);
		expect(row(tui, "scout")).toMatch(/\b1\ds\b/);

		child.open();
		const done = await waitFor(() => row(tui!, "scout")?.includes("completed") && row(tui!, "scout"));
		expect(done).toContain("Summary Done.");
	});

	it("shows a foreground run while the orchestrator is blocked on it, without saying it is waiting", async () => {
		tui = await createSubagentTui();
		const child = gate();
		tui.script([launch(["builder"])], async () => {
			await child.wait;
			return fauxAssistantMessage(REPORT);
		});
		const turn = prompt(tui);

		await waitFor(() => row(tui!, "builder") ?? false);
		expect(tui.panel()[0]).not.toContain("waiting");
		child.open();
		await turn;
	});

	it("says the orchestrator is waiting for N subagents once its turn ends with background runs active", async () => {
		tui = await createSubagentTui();
		const child = gate();
		const parentGoesOn = gate();
		tui.script(
			[
				launch(["scout", "mapper"], { background: true }),
				async () => {
					await parentGoesOn.wait;
					return fauxAssistantMessage("Launched; waiting for their reports.");
				},
			],
			async () => {
				await child.wait;
				return fauxAssistantMessage(REPORT);
			},
		);
		const turn = prompt(tui);
		await waitFor(() => (row(tui!, "scout") && row(tui!, "mapper")) ?? false);
		expect(tui.panel()[0]).not.toContain("waiting");

		parentGoesOn.open();
		await turn;
		expect(tui.panel()[0]).toContain("waiting for 2 subagents");

		child.open();
		await waitFor(() => tui!.session.isStreaming === false && !tui!.panel()[0]?.includes("waiting"));
	});

	it("shows at most five rows, then how many more /tasks has", async () => {
		tui = await createSubagentTui();
		const child = gate();
		const names = ["one", "two", "three", "four", "five", "six", "seven"];
		tui.script([launch(names, { background: true })], async () => {
			await child.wait;
			return fauxAssistantMessage(REPORT);
		});
		await prompt(tui);
		await waitFor(() => tui!.panel().some((line) => line.includes("more")));

		expect(names.filter((name) => row(tui!, name))).toHaveLength(5);
		expect(tui.panel().at(-1)?.trim()).toBe("+2 more · /tasks");
		child.open();
	});

	it("drops a run that succeeded about 30 seconds after it ends", async () => {
		tui = await createSubagentTui();
		tui.script([launch(["scout"], { background: true })]);
		await prompt(tui);
		await waitFor(() => row(tui!, "scout")?.includes("completed") ?? false);

		tui.advance(25_000);
		expect(row(tui, "scout")).toBeDefined();
		tui.advance(6_000);
		expect(tui.panel()).toEqual([]);
	});

	describe("a dismissed run the orchestrator resumes", () => {
		const SECOND_REPORT = REPORT.replace("Done.", "Second pass done.");

		/** "scout" has reported and is dismissed by `dismiss`; its resumed generation waits for `second`. */
		async function resumeDismissed(dismiss: (t: SubagentTui, runId: string) => void) {
			const t = await createSubagentTui();
			tui = t;
			const second = gate();
			t.script(
				[
					launch(["scout"], { background: true }),
					() => fauxAssistantMessage("Waiting for scout."),
					() => fauxAssistantMessage("Got scout's report."),
					() =>
						fauxAssistantMessage([
							fauxToolCall("subagent_message", { to: "scout", content: "One more thing." }, { id: "call_more" }),
						]),
					() => fauxAssistantMessage("Waiting for scout again."),
				],
				async (context) => {
					if (!JSON.stringify(context.messages).includes("One more thing.")) return fauxAssistantMessage(REPORT);
					await second.wait;
					return fauxAssistantMessage(SECOND_REPORT);
				},
			);
			await prompt(t);
			await waitFor(() => (row(t, "scout")?.includes("completed") && !t.session.isStreaming) ?? false);
			const [done] = agentTasks()?.listDone?.(t.session.sessionId) ?? [];
			dismiss(t, done.id);
			expect(t.panel()).toEqual([]);

			await prompt(t, "Ask scout for one more thing.");
			return { t, second, runId: done.id };
		}

		it.each([
			["the panel", (t: SubagentTui) => t.press("\x1b[B", "x")],
			["/tasks", (t: SubagentTui, runId: string) => agentTasks()?.dismiss?.(runId, t.session.sessionId)],
		])(
			"shows it again while it runs, waits for it, and lists its second finish, dismissed from %s",
			async (_from, dismiss) => {
				const { t, second, runId } = await resumeDismissed(dismiss);
				await waitFor(() => /running|starting/.test(row(t, "scout") ?? ""));
				expect(t.panel()[0]).toContain("waiting for 1 subagent");

				second.open();
				await waitFor(() => row(t, "scout")?.includes("completed") ?? false);
				expect((agentTasks()?.listDone?.(t.session.sessionId) ?? []).map((task) => task.id)).toEqual([runId]);
			},
		);
	});
});
