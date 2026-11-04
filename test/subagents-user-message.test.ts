import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { agentTasks } from "../ext/_shared/agent-tasks.ts";
import { SUBAGENT_NOTIFICATION_CUSTOM_TYPE } from "../ext/subagents/index.ts";
import { readBackgroundUsageLedger } from "../ext/subagents/storage.ts";
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

describe("resuming a finished run from its transcript", () => {
	const SECOND_REPORT = REPORT.replace("Done.", "Second pass done.");

	/** A run that reports at once, and answers the user's "One more thing." with a second report. */
	function resumableChild() {
		const contexts: TranscriptContext[] = [];
		const turn = (context: TranscriptContext) => {
			contexts.push(context);
			return fauxAssistantMessage(seen(context).includes("One more thing.") ? SECOND_REPORT : REPORT);
		};
		return { turn, contexts };
	}
	const notices = (t: SubagentTui) =>
		t.session.messages.flatMap((m) =>
			m.role === "custom" && m.customType === SUBAGENT_NOTIFICATION_CUSTOM_TYPE ? [m] : [],
		);

	it("resumes a completed run with its earlier context, and its report wakes the orchestrator marked as the user's", async () => {
		tui = await createSubagentTui();
		const child = resumableChild();
		const parent: TranscriptContext[] = [];
		const answer = (text: string) => (context: TranscriptContext) => {
			parent.push(context);
			return fauxAssistantMessage(text);
		};
		tui.script(
			[
				launch(["scout"], { background: true }),
				answer("Waiting for scout."),
				answer("Got scout's report."),
				answer("Got scout's second report."),
			],
			child.turn,
		);
		await prompt(tui);
		await waitFor(() => parent.length === 2 && !tui!.session.isStreaming);
		await openFromPanel(tui);

		tui.press("One more thing.", ENTER);
		await waitFor(() => screen(tui!).includes("Resuming scout"));
		await waitFor(() => parent.length === 3);
		await waitFor(() => !tui!.session.isStreaming);

		expect(child.contexts).toHaveLength(2);
		expect(seen(child.contexts[1])).toContain("### Summary\\nDone.");
		expect(seen(child.contexts[1])).toContain("Message from the user");
		expect(seen(child.contexts[1])).toContain("One more thing.");
		expect(JSON.stringify(tui.session.messages)).toMatch(
			/The user messaged run \\"scout\\" \(sub_[0-9a-f-]+\): One more thing\./,
		);
		expect(notices(tui)).toHaveLength(2);
		expect(JSON.stringify(notices(tui)[1])).toContain("Second pass done.");
		expect(JSON.stringify(notices(tui)[1])).toContain("Resumed by the user");
		expect(JSON.stringify(notices(tui)[0])).not.toContain("Resumed by the user");
		expect(seen(parent[2])).toContain("Second pass done.");
	});

	it("follows the new generation live in the open view", async () => {
		tui = await createSubagentTui();
		const second = gate();
		let turns = 0;
		tui.script([launch(["scout"], { background: true })], async () => {
			if (turns++ === 0) return fauxAssistantMessage(REPORT);
			await second.wait;
			return fauxAssistantMessage(SECOND_REPORT);
		});
		await prompt(tui);
		await waitFor(() => notices(tui!).length === 1 && !tui!.session.isStreaming);
		await openFromPanel(tui);
		expect(screen(tui)).not.toContain("Message from the user");

		tui.press("One more thing.", ENTER);
		await waitFor(() => screen(tui!).includes("Message from the user"));
		expect(tui.view()?.[0]).toContain("running");
		expect(screen(tui)).not.toContain("Second pass done.");

		second.open();
		await waitFor(() => screen(tui!).includes("Second pass done."));
		await waitFor(() => tui!.view()?.[0]?.includes("completed"));
	});

	it("goes through the orchestrator's admission, and shows a refusal in the view", async () => {
		tui = await createSubagentTui();
		const child = resumableChild();
		tui.script([launch(["scout"], { background: true })], child.turn);
		await prompt(tui);
		await waitFor(() => notices(tui!).length === 1 && !tui!.session.isStreaming);
		writeFileSync(
			join(tui.agentDir, "settings.json"),
			JSON.stringify({ permissions: { deny: ["Subagent(explorer)"] } }),
		);
		await openFromPanel(tui);

		tui.press("One more thing.", ENTER);
		await waitFor(() => tui!.view()?.at(-1)?.includes("Blocked by permission rule (deny): Subagent(explorer)"));
		expect(screen(tui)).toContain("One more thing.");
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(child.contexts).toHaveLength(1);
		expect(JSON.stringify(tui.session.messages)).not.toContain("The user messaged run");
	});

	it("counts the resumed generation's usage, its tools' included, as a background generation", async () => {
		const TOOL_TOKENS = 1_000_000;
		const metered = defineTool({
			name: "metered",
			label: "Metered",
			description: "Reports integration usage.",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "metered" }],
				details: undefined,
				usage: {
					input: TOOL_TOKENS,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: TOOL_TOKENS,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
		});
		tui = await createSubagentTui({ extraTools: [metered] });
		tui.script([launch(["scout"], { background: true, agent: "general-purpose" })], (context) => {
			const text = seen(context);
			if (!text.includes("One more thing.")) return fauxAssistantMessage(REPORT);
			if (text.includes('"toolName":"metered"')) return fauxAssistantMessage(SECOND_REPORT);
			return fauxAssistantMessage([fauxToolCall("metered", {}, { id: "call_metered" })]);
		});
		await prompt(tui);
		await waitFor(() => notices(tui!).length === 1 && !tui!.session.isStreaming);
		const { runId } = notices(tui)[0].details as { runId: string };
		await openFromPanel(tui);

		tui.press("One more thing.", ENTER);
		await waitFor(() => notices(tui!).length === 2);
		const ledger = readBackgroundUsageLedger(tui.agentDir, tui.session.sessionId);
		expect(ledger.recordedRunIds).toEqual([runId, `${runId}#1`]);
		expect(ledger.usage.totalTokens).toBeGreaterThanOrEqual(TOOL_TOKENS);
	});
});
