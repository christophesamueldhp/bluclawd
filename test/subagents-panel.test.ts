import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tmux } from "../daemon/tmux.ts";
import { agentTasks } from "../ext/_shared/agent-tasks.ts";
import { STATUS_KEYS } from "../ext/_shared/status-keys.ts";
import { createSubagentTui, gate, launch, type SubagentTui } from "./helpers/subagent-tui.ts";
import { waitFor } from "./helpers/wait-for.ts";

// The harness fakes it; a test that needs tmux's own answer calls this one.
const realHasSession = Tmux.prototype.hasSession;

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

	it("marks a run waiting on a prompt in its own session, and keeps a notice of it in the orchestrator's session", async () => {
		tui = await createSubagentTui();
		tui.script([launch(["scout"], { background: true })]);
		await prompt(tui);

		tui.activity("scout", "awaiting_input", "Network access");
		await waitFor(() => row(tui!, "scout")?.includes("needs input") ?? false);
		const entries = () => tui!.session.sessionManager.getEntries();
		const notice = await waitFor(
			() =>
				entries().find(
					(entry) => entry.type === "custom_message" && JSON.stringify(entry.content).includes("needs input"),
				) ?? false,
		);
		expect(notice).toMatchObject({ display: true });
		expect(JSON.stringify(notice)).toContain('Subagent \\"scout\\"');
		// For the user, who answers in the run's session: it starts no turn of the orchestrator.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(tui.session.isStreaming).toBe(false);
		expect(entries().at(-1)).toBe(notice);
	});

	it("says what an open run is doing in /tasks and subagent_status, not just that it runs", async () => {
		tui = await createSubagentTui();
		tui.script([
			launch(["scout"], { background: true }),
			() => fauxAssistantMessage("Waiting for scout."),
			() => fauxAssistantMessage([fauxToolCall("subagent_status", { agent: "scout" }, { id: "call_status" })]),
		]);
		await prompt(tui);
		tui.activity("scout", "idle");
		await waitFor(() => row(tui!, "scout")?.includes("idle") ?? false);

		expect(agentTasks()?.list()).toEqual([expect.objectContaining({ state: "running", status: "idle" })]);
		await prompt(tui, "How is scout?");
		const status = JSON.stringify(
			tui.session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "call_status"),
		);
		expect(status).toMatch(/scout \(explorer, sub_[0-9a-f-]+\): idle/);
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

	it("shows only open runs: one whose pi failed to start is not in it, and is Done in /tasks", async () => {
		tui = await createSubagentTui();
		vi.mocked(Tmux.prototype.newSession).mockImplementationOnce(() => {
			throw new Error("tmux refused");
		});
		tui.script([launch(["scout"], { background: true })]);
		await prompt(tui);

		await waitFor(
			() =>
				agentTasks()
					?.listDone?.()
					.some((task) => task.state === "failed") ?? false,
		);
		expect(tui.panel()).toEqual([]);
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

describe("a reload of the orchestrator", () => {
	it("keeps its open runs: they stay in the panel, and their Reports still wake it", async () => {
		tui = await createSubagentTui();
		tui.script([launch(["scout"], { background: true }), () => fauxAssistantMessage("Waiting for scout.")]);
		await prompt(tui);
		await waitFor(() => row(tui!, "scout") ?? false);

		await tui.session.reload();
		expect(tui.runs).toEqual([expect.objectContaining({ name: "scout", ended: false })]);
		await waitFor(() => row(tui!, "scout") ?? false);

		tui.report("scout", "Found the module.");
		await waitFor(() =>
			tui!.session.messages.some(
				(message) => message.role === "assistant" && JSON.stringify(message.content).includes("Done."),
			),
		);
		expect(JSON.stringify(tui.session.messages)).toContain("Found the module.");
	});

	it("goes on past a tmux that never answers, after its timeout, and keeps the run", async () => {
		tui = await createSubagentTui();
		tui.script([launch(["scout"], { background: true }), () => fauxAssistantMessage("Waiting for scout.")]);
		await prompt(tui);
		await waitFor(() => row(tui!, "scout") ?? false);

		const bin = mkdtempSync(join(tmpdir(), "bluclawd-hung-tmux-"));
		writeFileSync(join(bin, "tmux"), "#!/bin/sh\nexec sleep 30\n");
		chmodSync(join(bin, "tmux"), 0o755);
		const hasSession = vi.mocked(Tmux.prototype.hasSession);
		const fake = hasSession.getMockImplementation();
		vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
		vi.stubEnv("PI_SERVER_DIR", bin);
		hasSession.mockImplementation(function (this: Tmux, pane) {
			return realHasSession.call(this, pane);
		});
		const started = Date.now();
		try {
			await tui.session.reload();
		} finally {
			hasSession.mockImplementation(fake!);
			vi.unstubAllEnvs();
		}
		expect(Date.now() - started).toBeLessThan(5000);
		expect(tui.runs).toEqual([expect.objectContaining({ name: "scout", ended: false })]);
		await waitFor(() => row(tui!, "scout") ?? false);
	}, 15_000);
});
