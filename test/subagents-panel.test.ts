import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { STATUS_KEYS } from "../ext/_shared/status-keys.ts";
import { createSubagentTui, gate, launch, type SubagentTui } from "./helpers/subagent-tui.ts";
import { waitFor } from "./helpers/wait-for.ts";

let tui: SubagentTui | undefined;
afterEach(() => {
	tui?.dispose();
	tui = undefined;
});

const row = (t: SubagentTui, name: string) => t.panel().find((line) => line.trim().startsWith(`${name} `));
const prompt = (t: SubagentTui, text = "Delegate.") => t.session.prompt(text, { expandPromptTemplates: false });

describe("the run panel below the status line", () => {
	it("shows nothing when there are no runs", async () => {
		tui = await createSubagentTui();
		tui.script([() => fauxAssistantMessage("Nothing to delegate.")]);
		await prompt(tui, "Hello.");
		expect(tui.status(STATUS_KEYS.subagents)).toBeUndefined();
	});

	it("shows a background run below the status line with its name, agent, model and status", async () => {
		tui = await createSubagentTui();
		tui.script([launch(["scout"], { background: true })]);
		await prompt(tui);

		const scout = await waitFor(() => row(tui!, "scout") ?? false);
		expect(scout).toContain("explorer");
		expect(scout).toContain("faux-tool/faux-main");
		expect(scout).toMatch(/working|starting/);
		// Nothing sits between the prompt and the status line.
		expect(tui.widget("subagents:panel")?.lines ?? []).toEqual([]);
	});

	it("stays below the prompt, with a one-line count in the footer, under pi's own footer", async () => {
		tui = await createSubagentTui({ pistatusline: false });
		tui.script([launch(["scout"], { background: true })]);
		await prompt(tui);

		const scout = await waitFor(() =>
			tui!.widget("subagents:panel")?.lines.find((line) => line.trim().startsWith("scout ")),
		);
		expect(scout).toContain("explorer");
		expect(tui.widget("subagents:panel")?.placement).toBe("belowEditor");
		expect(tui.status(STATUS_KEYS.subagents)).toBe("1 subagent");
		expect(tui.panel()).toEqual([]);
	});

	it("shows how long a run has been going and its latest report", async () => {
		tui = await createSubagentTui();
		tui.script([launch(["scout"], { background: true })]);
		await prompt(tui);
		await waitFor(() => row(tui!, "scout") ?? false);

		tui.advance(12_000);
		await waitFor(() => /\b1\ds\b/.test(row(tui!, "scout") ?? ""));

		tui.report("scout", "Mapped the module.");
		await waitFor(() => row(tui!, "scout")?.includes("Mapped the module.") ?? false);
	});

	it("shows a foreground run while the orchestrator is blocked on it, without saying it is waiting", async () => {
		tui = await createSubagentTui();
		tui.script([launch(["builder"])]);
		const turn = prompt(tui);

		await waitFor(() => row(tui!, "builder") ?? false);
		expect(tui.panel()[0]).not.toContain("waiting");
		tui.report("builder", "Built.");
		await turn;
	});

	it("says the orchestrator is waiting for N subagents once its turn ends with runs working", async () => {
		tui = await createSubagentTui();
		const parentGoesOn = gate();
		tui.script([
			launch(["scout", "mapper"], { background: true }),
			async () => {
				await parentGoesOn.wait;
				return fauxAssistantMessage("Launched; waiting for their reports.");
			},
		]);
		const turn = prompt(tui);
		await waitFor(() => (row(tui!, "scout") && row(tui!, "mapper")) ?? false);
		expect(tui.panel()[0]).not.toContain("waiting");

		parentGoesOn.open();
		await turn;
		expect(tui.panel()[0]).toContain("waiting for 2 subagents");

		tui.activity("scout", "idle");
		tui.activity("mapper", "idle");
		await waitFor(() => !tui!.panel()[0]?.includes("waiting"));
	});

	it("shows at most five rows, then how many more /tasks has", async () => {
		tui = await createSubagentTui();
		const names = ["one", "two", "three", "four", "five", "six", "seven"];
		tui.script([launch(names, { background: true })]);
		await prompt(tui);
		await waitFor(() => tui!.panel().some((line) => line.includes("more")));

		expect(names.filter((name) => row(tui!, name))).toHaveLength(5);
		expect(tui.panel().at(-1)?.trim()).toBe("+2 more · /tasks");
	});

	it("drops a run as soon as it is closed", async () => {
		tui = await createSubagentTui();
		tui.script([
			launch(["scout"], { background: true }),
			() => fauxAssistantMessage([fauxToolCall("subagent_close", { agent: "scout" }, { id: "call_close" })]),
		]);
		await prompt(tui);

		await waitFor(() => tui!.panel().length === 0);
		expect(tui.status(STATUS_KEYS.subagents)).toBeUndefined();
		expect(tui.runs[0]).toMatchObject({ name: "scout", ended: true });
	});
});
