import { existsSync } from "node:fs";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { stripAnsi } from "../daemon/ansi.ts";
import backgroundBash from "../ext/background-bash/index.ts";
import { TasksDialog } from "../ext/background-bash/tasks-dialog.ts";
import { paneTasks } from "../ext/remote/report.ts";
import { SUBAGENT_NOTIFICATION_CUSTOM_TYPE } from "../ext/subagents/index.ts";
import { readPersistedRunRecord, subagentReportPath } from "../ext/subagents/storage.ts";
import { createSubagentTui, launch, REPORT, type SubagentTui } from "./helpers/subagent-tui.ts";
import { waitFor } from "./helpers/wait-for.ts";

const ENTER = "\r";
const SECOND_REPORT = REPORT.replace("Done.", "Second pass done.");
const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

let tui: SubagentTui | undefined;
afterEach(() => {
	tui?.dispose();
	tui = undefined;
});

const owner = (t: SubagentTui) => t.session.sessionManager.getSessionId();
const notices = (t: SubagentTui) =>
	t.session.messages.filter((m) => m.role === "custom" && m.customType === SUBAGENT_NOTIFICATION_CUSTOM_TYPE);

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

/** A session whose background run "scout" has reported, and answers "One more thing." with a second report. */
async function finishedRun(extensions?: ExtensionFactory[]) {
	const t = await createSubagentTui({ extensions });
	t.script([launch(["scout"], { background: true })], (context: TranscriptContext) =>
		fauxAssistantMessage(JSON.stringify(context.messages).includes("One more thing.") ? SECOND_REPORT : REPORT),
	);
	await t.session.prompt("Delegate.", { expandPromptTemplates: false });
	await waitFor(() => notices(t).length === 1 && !t.session.isStreaming);
	const runId = t.session.messages
		.flatMap((m) => (m.role === "toolResult" ? [JSON.stringify(m.content)] : []))
		.join("")
		.match(/sub_[0-9a-f-]+/)?.[0];
	if (!runId) throw new Error("no run id in the launch result");
	return { t, runId };
}

describe("/tasks keeps the finished runs of this session", () => {
	it("lists a finished run under Done with its model and status, but not on the phone", async () => {
		({ t: tui } = await finishedRun());
		// Gone from the panel, which drops a succeeded run after 30s.
		tui.advance(31_000);
		expect(tui.panel()).toEqual([]);

		const out = tasks(tui).screen();
		expect(out).toContain("    Done (1)\n");
		expect(out).toContain("explorer: Task for scout   faux-tool/faux-main · completed");
		expect(paneTasks(owner(tui))).toEqual([]);
	});

	it("opens a finished run's transcript with Enter in /tasks, where typing resumes it", async () => {
		({ t: tui } = await finishedRun([backgroundBash]));
		void tui.session.prompt("/tasks");
		await waitFor(() => tui!.view()?.join("\n").includes("Done (1)") ?? false);
		tui.press(ENTER);
		// The transcript's header names the run; the dialog's first line is blank.
		await waitFor(() => tui!.view()?.[0]?.includes("scout") ?? false);

		tui.press("One more thing.", ENTER);
		await waitFor(() => tui!.view()?.join("\n").includes("Resuming scout") ?? false);
		await waitFor(() => notices(tui!).length === 2 && !tui!.session.isStreaming);
		expect(JSON.stringify(notices(tui)[1])).toContain("Second pass done.");
	});

	it("dismisses a finished run from Done, keeping its record and report on disk", async () => {
		let runId: string;
		({ t: tui, runId } = await finishedRun());
		expect(tui.panel().join("\n")).toContain("scout");
		const { dialog, screen } = tasks(tui);
		expect(screen()).toContain("x to dismiss");
		dialog.handleInput("x");
		expect(tui.panel()).toEqual([]);
		expect(screen()).not.toContain("scout");
		expect(tasks(tui).screen()).not.toContain("scout");
		expect(existsSync(subagentReportPath(tui.agentDir, owner(tui), runId))).toBe(true);
		expect(readPersistedRunRecord(tui.agentDir, owner(tui), runId)?.status).toBe("completed");
	});
});
