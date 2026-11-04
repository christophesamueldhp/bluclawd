import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { agentTasks } from "../ext/_shared/agent-tasks.ts";
import checkpoints from "../ext/checkpoints/index.ts";
import { createSubagentTui, gate, launch, REPORT, type SubagentTui } from "./helpers/subagent-tui.ts";
import { waitFor } from "./helpers/wait-for.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const ESC = "\x1b";

let tui: SubagentTui | undefined;
afterEach(() => {
	tui?.dispose();
	tui = undefined;
});

const row = (t: SubagentTui, name: string) => t.panel().find((line) => line.slice(2).startsWith(`${name} `));
const prompt = (t: SubagentTui, text = "Delegate.") => t.session.prompt(text, { expandPromptTemplates: false });
const screen = (t: SubagentTui) => t.view()?.join("\n") ?? "";

/** Opens the transcript of the panel's only run from the keyboard. */
async function openFromPanel(t: SubagentTui) {
	t.press(DOWN, ENTER);
	await waitFor(() => t.view() !== undefined);
	return t.view() ?? [];
}

describe("a run's transcript", () => {
	it("opens with Enter on a panel row, naming the run and how to go back", async () => {
		tui = await createSubagentTui();
		const child = gate();
		tui.script([launch(["scout"], { background: true })], async () => {
			await child.wait;
			return fauxAssistantMessage(REPORT);
		});
		await prompt(tui);
		await waitFor(() => row(tui!, "scout")?.includes("running") ?? false);

		const lines = await openFromPanel(tui);
		expect(lines[0]).toContain("scout");
		expect(lines[0]).toContain("explorer");
		expect(lines.at(-1)).toContain("Esc to go back");
		await waitFor(() => screen(tui!).includes("Task for scout"));
		child.open();
	});

	it("grows live with the run's tool calls, their results and its messages", async () => {
		tui = await createSubagentTui();
		const second = gate();
		let childTurn = 0;
		tui.script([launch(["scout"], { background: true })], async () => {
			if (childTurn++ === 0) {
				return fauxAssistantMessage([
					{ type: "text", text: "Checking who else is working." },
					fauxToolCall("subagent_roster", {}, { id: "call_roster" }),
				]);
			}
			await second.wait;
			return fauxAssistantMessage(REPORT);
		});
		await prompt(tui);
		await waitFor(() => row(tui!, "scout") ?? false);
		await openFromPanel(tui);

		await waitFor(() => screen(tui!).includes("- parent: the orchestrator"));
		expect(screen(tui)).toContain("Checking who else is working.");
		expect(screen(tui)).toContain("subagent_roster");
		expect(screen(tui)).not.toContain("Evidence");

		second.open();
		await waitFor(() => screen(tui!).includes("Evidence"));
		expect(tui.view()?.[0]).toContain("completed");
	});

	it("follows the end of a long transcript and scrolls back to its start", async () => {
		tui = await createSubagentTui();
		const items = Array.from({ length: 80 }, (_, i) => `- finding ${i + 1}`).join("\n");
		tui.script([launch(["scout"], { background: true })], () => fauxAssistantMessage(`${REPORT}\n${items}`));
		await prompt(tui);
		await waitFor(() => row(tui!, "scout")?.includes("completed") ?? false);
		await openFromPanel(tui);

		const lines = await waitFor(() => screen(tui!).includes("finding 80") && tui!.view()!);
		expect(lines).toHaveLength(40);
		expect(screen(tui)).not.toContain("Task for scout");

		tui.press(...Array(10).fill(PAGE_UP));
		expect(screen(tui)).toContain("Task for scout");
		expect(screen(tui)).not.toContain("finding 80");

		const atStart = tui.view()!;
		tui.press(DOWN);
		expect(tui.view()?.slice(1, -2)).toEqual([...atStart.slice(2, -2), expect.any(String)]);
		tui.press(...Array(10).fill(PAGE_DOWN));
		expect(screen(tui)).toContain("finding 80");
	});

	it("reads a finished run from its session file", async () => {
		tui = await createSubagentTui();
		tui.script([launch(["scout"], { background: true })]);
		await prompt(tui);
		await waitFor(() => row(tui!, "scout")?.includes("completed") ?? false);

		await openFromPanel(tui);
		await waitFor(() => screen(tui!).includes("Evidence"));
		expect(screen(tui)).toContain("Task for scout");
	});

	it("goes back to the orchestrator on Esc, without a quick second Esc opening /rewind", async () => {
		const rewinds: string[] = [];
		// Checkpoints' key listener sees each key before the subagents extension's, as in bluclawd's load order.
		const spiedCheckpoints = (pi: ExtensionAPI) =>
			checkpoints(
				new Proxy(pi, {
					get: (target, prop, receiver) =>
						prop === "sendUserMessage"
							? (text: string) => rewinds.push(text)
							: Reflect.get(target, prop, receiver),
				}),
			);
		tui = await createSubagentTui({ extensionsBefore: [spiedCheckpoints] });
		const child = gate();
		tui.script([launch(["scout"], { background: true })], async () => {
			await child.wait;
			return fauxAssistantMessage(REPORT);
		});
		await prompt(tui);
		await waitFor(() => row(tui!, "scout") ?? false);
		await waitFor(() => !tui!.session.isStreaming);
		await openFromPanel(tui);

		tui.press(ESC, ESC);
		expect(tui.view()).toBeUndefined();
		expect(rewinds).toEqual([]);
		child.open();
	});

	it("opens a foreground run while the orchestrator is blocked on it", async () => {
		tui = await createSubagentTui();
		const child = gate();
		tui.script([launch(["builder"])], async () => {
			await child.wait;
			return fauxAssistantMessage(REPORT);
		});
		const turn = prompt(tui);
		await waitFor(() => row(tui!, "builder")?.includes("running") ?? false);

		await openFromPanel(tui);
		await waitFor(() => screen(tui!).includes("Task for builder"));
		expect(tui.session.isStreaming).toBe(true);
		expect(tui.view()?.[0]).toContain("builder");

		child.open();
		await waitFor(() => screen(tui!).includes("Evidence"));
		await turn;
	});

	it("does not open a run of an earlier session epoch", async () => {
		tui = await createSubagentTui();
		const child = gate();
		tui.script([launch(["scout"], { background: true })], async () => {
			await child.wait;
			return fauxAssistantMessage(REPORT);
		});
		await prompt(tui);
		await waitFor(() => row(tui!, "scout") ?? false);
		const owner = tui.session.sessionId;
		const [run] = agentTasks()?.list(owner) ?? [];
		const closed = agentTasks()?.open?.(run.id, owner);
		await waitFor(() => tui!.view()?.[0]?.includes("scout"));
		tui.press(ESC);
		await closed;

		await tui.session.extensionRunner.emit({ type: "session_before_switch", reason: "new" });
		expect(agentTasks()?.open?.(run.id, owner)).toBeUndefined();
		await Promise.resolve();
		expect(tui.view()).toBeUndefined();
		expect(tui.notifications.at(-1)).toContain("earlier session");
		child.open();
	});
});
