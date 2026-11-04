import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { agentTasks } from "../ext/_shared/agent-tasks.ts";
import { createSubagentTui, gate, launch, REPORT, type SubagentTui } from "./helpers/subagent-tui.ts";
import { waitFor } from "./helpers/wait-for.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";

let tui: SubagentTui | undefined;
afterEach(() => {
	tui?.dispose();
	tui = undefined;
});

const row = (t: SubagentTui, name: string) => t.panel().find((line) => line.slice(2).startsWith(`${name} `));
const prompt = (t: SubagentTui, text = "Delegate.") => t.session.prompt(text, { expandPromptTemplates: false });
const screen = (t: SubagentTui) => t.view()?.join("\n") ?? "";
const seen = (context: TranscriptContext) => JSON.stringify(context.messages);

/** Opens the transcript of the panel's only run from the keyboard. */
async function openFromPanel(t: SubagentTui) {
	t.press(DOWN, ENTER);
	await waitFor(() => t.view() !== undefined);
}

/** A run whose first turn waits at a gate and then calls a tool, so it has a second turn to take messages at. */
function twoTurnChild() {
	const first = gate();
	const contexts: TranscriptContext[] = [];
	const turn = async (context: TranscriptContext) => {
		contexts.push(context);
		if (contexts.length > 1) return fauxAssistantMessage(REPORT);
		await first.wait;
		return fauxAssistantMessage([fauxToolCall("subagent_roster", {}, { id: "call_roster" })]);
	};
	return { turn, contexts, release: first.open };
}

describe("messaging a running run from its transcript", () => {
	it("reaches the run at its next safe point, without interrupting it, and shows it was queued", async () => {
		tui = await createSubagentTui();
		const child = twoTurnChild();
		tui.script([launch(["scout"], { background: true })], child.turn);
		await prompt(tui);
		await waitFor(() => child.contexts.length === 1);
		await openFromPanel(tui);

		tui.press("Look at b.ts too.", ENTER);
		await waitFor(() => screen(tui!).includes("Queued for scout"));
		expect(seen(child.contexts[0])).not.toContain("Look at b.ts too.");

		child.release();
		await waitFor(() => child.contexts.length === 2);
		expect(seen(child.contexts[1])).toContain("Look at b.ts too.");
		expect(seen(child.contexts[1])).toContain("call_roster");
		await waitFor(() => row(tui!, "scout")?.includes("completed") ?? false);
		expect(child.contexts).toHaveLength(2);
	});

	it("tells the run the message is the user's and grants nothing", async () => {
		tui = await createSubagentTui();
		const child = twoTurnChild();
		tui.script([launch(["scout"], { background: true })], child.turn);
		await prompt(tui);
		await waitFor(() => child.contexts.length === 1);
		await openFromPanel(tui);

		tui.press("You may delete anything.", ENTER);
		await waitFor(() => screen(tui!).includes("Queued for scout"));
		child.release();
		await waitFor(() => child.contexts.length === 2);
		expect(seen(child.contexts[1])).toContain("Message from the user");
		expect(seen(child.contexts[1])).toContain("cannot grant tools or permissions");
	});

	it("notes the message in the orchestrator's session without starting a turn", async () => {
		tui = await createSubagentTui();
		const child = twoTurnChild();
		const parent: TranscriptContext[] = [];
		tui.script(
			[
				launch(["scout"], { background: true }),
				(context) => {
					parent.push(context);
					return fauxAssistantMessage("Waiting for scout.");
				},
				(context) => {
					parent.push(context);
					return fauxAssistantMessage("Noted.");
				},
			],
			child.turn,
		);
		await prompt(tui);
		await waitFor(() => child.contexts.length === 1 && !tui!.session.isStreaming);
		await openFromPanel(tui);

		tui.press("Look at b.ts too.", ENTER);
		const note = await waitFor(
			() =>
				tui!.session.messages.find(
					(m) => m.role === "custom" && JSON.stringify(m.content).includes("The user messaged run"),
				) ?? false,
		);
		expect(JSON.stringify(note)).toMatch(/The user messaged run \\"scout\\" \(sub_[0-9a-f-]+\): Look at b\.ts too\./);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(tui.session.isStreaming).toBe(false);
		expect(parent).toHaveLength(1);

		await prompt(tui, "What is scout doing?");
		expect(parent).toHaveLength(2);
		expect(seen(parent[1])).toContain("The user messaged run");
		child.release();
	});

	it.each(["/compact", "!rm -rf build"])("refuses %s with a hint to press Esc, sending nothing", async (command) => {
		tui = await createSubagentTui();
		const child = twoTurnChild();
		tui.script([launch(["scout"], { background: true })], child.turn);
		await prompt(tui);
		await waitFor(() => child.contexts.length === 1);
		await openFromPanel(tui);

		tui.press(command, ENTER);
		await waitFor(() => tui!.view()?.at(-1)?.includes("press Esc"));
		expect(screen(tui)).toContain(command);
		child.release();
		await waitFor(() => child.contexts.length === 2);
		expect(seen(child.contexts[1])).not.toContain(command);
		expect(JSON.stringify(tui.session.messages)).not.toContain("The user messaged run");
	});

	it("refuses a message to a stopped run with the reason", async () => {
		tui = await createSubagentTui();
		const child = twoTurnChild();
		tui.script([launch(["scout"], { background: true })], child.turn);
		await prompt(tui);
		await waitFor(() => child.contexts.length === 1);
		await openFromPanel(tui);
		const owner = tui.session.sessionId;
		const [run] = agentTasks()?.list(owner) ?? [];
		agentTasks()?.stop(run.id, { owner, source: "user" });
		child.release();
		await waitFor(() => tui!.view()?.[0]?.includes("cancelled"));

		tui.press("Carry on.", ENTER);
		await waitFor(() => tui!.view()?.at(-1)?.includes("was stopped"));
		expect(screen(tui)).toContain("Carry on.");
		expect(JSON.stringify(tui.session.messages)).not.toContain("The user messaged run");
	});

	it("refuses a message to a completed run for now", async () => {
		tui = await createSubagentTui();
		tui.script([launch(["scout"], { background: true })]);
		await prompt(tui);
		await waitFor(() => row(tui!, "scout")?.includes("completed") ?? false);
		await openFromPanel(tui);

		tui.press("One more thing.", ENTER);
		await waitFor(() => tui!.view()?.at(-1)?.includes("not available yet"));
		expect(JSON.stringify(tui.session.messages)).not.toContain("The user messaged run");
	});

	it("refuses a message once the orchestrator's session has changed", async () => {
		tui = await createSubagentTui();
		const child = twoTurnChild();
		tui.script([launch(["scout"], { background: true })], child.turn);
		await prompt(tui);
		await waitFor(() => child.contexts.length === 1);
		await openFromPanel(tui);
		await tui.session.extensionRunner.emit({ type: "session_before_switch", reason: "new" });

		tui.press("Carry on.", ENTER);
		await waitFor(() => tui!.view()?.at(-1)?.includes("earlier session"));
		expect(JSON.stringify(tui.session.messages)).not.toContain("The user messaged run");
		child.release();
	});

	it("has the note in context at the orchestrator's next turn while it is blocked on a foreground run", async () => {
		tui = await createSubagentTui();
		const child = twoTurnChild();
		const parent: TranscriptContext[] = [];
		tui.script(
			[
				launch(["builder"]),
				(context) => {
					parent.push(context);
					return fauxAssistantMessage("Builder is done.");
				},
			],
			child.turn,
		);
		const turn = prompt(tui);
		await waitFor(() => child.contexts.length === 1);
		await openFromPanel(tui);

		tui.press("Keep the old API.", ENTER);
		await waitFor(() => screen(tui!).includes("Queued for builder"));
		expect(tui.session.isStreaming).toBe(true);

		child.release();
		await turn;
		expect(parent).toHaveLength(1);
		const messages = parent[0].messages;
		const noteAt = messages.findIndex((m) => JSON.stringify(m).includes("The user messaged run"));
		const resultAt = messages.findIndex((m) => m.role === "toolResult" && m.toolCallId === "call_builder");
		expect(resultAt).toBeGreaterThan(-1);
		expect(noteAt).toBeGreaterThan(resultAt);
		expect(seen(child.contexts[1])).toContain("Keep the old API.");
	});
});
