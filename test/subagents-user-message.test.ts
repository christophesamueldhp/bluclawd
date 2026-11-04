import { fauxAssistantMessage, fauxToolCall, type TranscriptContext, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { currentSubagent } from "../ext/_shared/subagent-commands.ts";
import { SUBAGENT_NOTIFICATION_CUSTOM_TYPE } from "../ext/subagents/index.ts";
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
});

describe("what a run does for the user's message", () => {
	/**
	 * Stands in for the sandbox's network ask: the user is asked for the orchestrator's own command, while a
	 * subagent's is denied and reported to the orchestrator, as ext/sandbox does.
	 */
	function networkTool() {
		const asks: string[] = [];
		const tool = defineTool({
			name: "fetch_site",
			label: "Fetch site",
			description: "Fetches example.org.",
			parameters: Type.Object({}),
			execute: async () => {
				const owner = currentSubagent();
				if (!owner) {
					asks.push("example.org:443");
					return { content: [{ type: "text", text: "The user was asked." }], details: undefined };
				}
				owner.reportNetworkDenied("example.org:443", [owner.name]);
				return {
					content: [{ type: "text", text: "Network access to example.org:443 was denied." }],
					details: undefined,
					isError: true,
				};
			},
		});
		return { tool, asks };
	}

	/** A child that fetches once the user's "Fetch example.org." reaches it, and reports after the fetch. */
	function fetchingChild(firstTurn?: Promise<void>) {
		return async (context: TranscriptContext) => {
			const text = seen(context);
			if (text.includes('"toolName":"fetch_site"')) return fauxAssistantMessage(REPORT);
			if (text.includes("Fetch example.org."))
				return fauxAssistantMessage([fauxToolCall("fetch_site", {}, { id: "call_fetch" })]);
			if (!firstTurn) return fauxAssistantMessage(REPORT);
			await firstTurn;
			return fauxAssistantMessage([fauxToolCall("subagent_roster", {}, { id: "call_roster" })]);
		};
	}

	const sandboxNote = (t: SubagentTui) =>
		t.session.messages.find(
			(m) =>
				m.role === "custom" && JSON.stringify(m.content).includes("[sandbox] Network access to example.org:443"),
		) ?? false;

	it("denies, without asking the user, what a running run would need approval for, and tells the orchestrator", async () => {
		const network = networkTool();
		tui = await createSubagentTui({ extraTools: [network.tool] });
		const first = gate();
		tui.script([launch(["scout"], { background: true, agent: "general-purpose" })], fetchingChild(first.wait));
		await prompt(tui);
		await openFromPanel(tui);

		tui.press("Fetch example.org.", ENTER);
		await waitFor(() => screen(tui!).includes("Queued for scout"));
		first.open();
		const note = await waitFor(() => sandboxNote(tui!));
		expect(JSON.stringify(note)).toContain("denied without asking the user");
		expect(network.asks).toEqual([]);
	});

	it("denies, without asking the user, what a run resumed by the user would need approval for, and tells the orchestrator", async () => {
		const network = networkTool();
		tui = await createSubagentTui({ extraTools: [network.tool] });
		tui.script([launch(["scout"], { background: true, agent: "general-purpose" })], fetchingChild());
		await prompt(tui);
		await waitFor(() => (row(tui!, "scout")?.includes("completed") && !tui!.session.isStreaming) ?? false);
		await openFromPanel(tui);

		tui.press("Fetch example.org.", ENTER);
		await waitFor(() => screen(tui!).includes("Resuming scout"));
		const note = await waitFor(() => sandboxNote(tui!));
		expect(JSON.stringify(note)).toContain("denied without asking the user");
		expect(network.asks).toEqual([]);
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
});
