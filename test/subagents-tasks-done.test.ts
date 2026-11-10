import { existsSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { stripAnsi } from "../daemon/ansi.ts";
import backgroundBash from "../ext/background-bash/index.ts";
import { TasksDialog } from "../ext/background-bash/tasks-dialog.ts";
import { paneTasks } from "../ext/remote/report.ts";
import { readPersistedRunRecord, subagentReportPath } from "../ext/subagents/storage.ts";
import { createSubagentTui, launch, type SubagentTui } from "./helpers/subagent-tui.ts";
import { waitFor } from "./helpers/wait-for.ts";

const ENTER = "\r";
const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

let tui: SubagentTui | undefined;
afterEach(() => {
	tui?.dispose();
	tui = undefined;
});

const owner = (t: SubagentTui) => t.session.sessionManager.getSessionId();

/** `/tasks` as the user sees it, over the subagents extension's own task source. */
function tasks(t: SubagentTui) {
	const state = { closed: false };
	const dialog = new TasksDialog(
		theme,
		owner(t),
		() => {
			state.closed = true;
		},
		() => {},
	);
	return { dialog, state, screen: () => stripAnsi(dialog.render(100).join("\n")) };
}

/** A session whose background run "scout" reported and was then closed. */
async function closedRun(extensions?: ExtensionFactory[]) {
	const t = await createSubagentTui({ extensions });
	t.script([
		launch(["scout"], { background: true }),
		() => fauxAssistantMessage("Waiting for scout."),
		() => fauxAssistantMessage([fauxToolCall("subagent_close", { agent: "scout" }, { id: "call_close" })]),
	]);
	await t.session.prompt("Delegate.", { expandPromptTemplates: false });
	t.report("scout", "Mapped the module.");
	await waitFor(() => t.runs[0]?.ended && !t.session.isStreaming);
	const runId = t.session.messages
		.flatMap((m) => (m.role === "toolResult" ? [JSON.stringify(m.content)] : []))
		.join("")
		.match(/sub_[0-9a-f-]+/)?.[0];
	if (!runId) throw new Error("no run id in the launch result");
	await waitFor(() => readPersistedRunRecord(t.agentDir, owner(t), runId)?.status === "closed");
	return { t, runId };
}

describe("/tasks keeps the closed runs of this session", () => {
	it("lists a closed run under Done with its model and status, but not on the phone", async () => {
		({ t: tui } = await closedRun());
		// Only the hint to /tasks is left in the panel.
		expect(tui.panel()).toEqual(["/tasks to see subagents"]);

		const out = tasks(tui).screen();
		expect(out).toContain("    Done (1)\n");
		expect(out).toContain("explorer: Task for scout   faux-tool/faux-main · closed");
		expect(paneTasks(owner(tui))).toEqual([]);
	});

	it("reopens a closed run's session with Enter in /tasks, and switches the terminal to it", async () => {
		({ t: tui } = await closedRun([backgroundBash]));
		void tui.session.prompt("/tasks");
		await waitFor(() => tui!.view()?.join("\n").includes("Done (1)") ?? false);
		tui.press(ENTER);

		await waitFor(() => tui!.switched.length === 1);
		const [first, reopened] = tui.runs;
		expect(reopened).toMatchObject({ name: "scout", ended: false });
		expect(reopened.args).toContain("--session");
		expect(reopened.args[reopened.args.indexOf("--session") + 1]).toMatch(new RegExp(`${first.pane}\\.jsonl$`));
		expect(tui.switched).toEqual([reopened.pane]);
	});

	it("dismisses a closed run from Done, keeping its record and report on disk", async () => {
		let runId: string;
		({ t: tui, runId } = await closedRun());
		const { dialog, screen } = tasks(tui);
		expect(screen()).toContain("x to dismiss");
		dialog.handleInput("x");
		expect(screen()).not.toContain("scout");
		expect(tasks(tui).screen()).not.toContain("scout");
		expect(existsSync(subagentReportPath(tui.agentDir, owner(tui), runId))).toBe(true);
		expect(readPersistedRunRecord(tui.agentDir, owner(tui), runId)?.status).toBe("closed");
	});
});
