import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createParentSessionWithSubagents } from "./helpers/subagent-session.ts";
import { createSubagentTui, launch, type SubagentTui } from "./helpers/subagent-tui.ts";
import { waitFor } from "./helpers/wait-for.ts";

const tempDirs: string[] = [];
let tui: SubagentTui | undefined;

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-waiting-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	tui?.dispose();
	tui = undefined;
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
	}
});

const prompt = (t: SubagentTui, text: string) => t.session.prompt(text, { expandPromptTemplates: false });

describe("The orchestrator's Waiting", () => {
	it("tells the model when to use background and what to do after it delegates", async () => {
		const { session, faux } = await createParentSessionWithSubagents({
			cwd: makeTempDir("description-cwd"),
			agentDir: makeTempDir("description-agent"),
		});
		try {
			await session.bindExtensions({ mode: "tui" });
			let description = "";
			faux.setResponses([
				(context) => {
					description = getCurrentTools(context.messages).find((t) => t.name === "subagent")?.description ?? "";
					return fauxAssistantMessage("Done.");
				},
			]);
			await session.prompt("Delegate something.", { expandPromptTemplates: false });

			expect(description).toContain("foreground (the default) when your next step needs the result");
			expect(description).toContain("`background: true` only when you have independent work to do meanwhile");
			expect(description).toContain("Do not redo or touch delegated work, including the files in a run's scope");
			expect(description).toContain("Do not poll `subagent_status` by reflex");
			expect(description).toContain(
				"With no independent work left, end your turn and say you are waiting: the report will wake you",
			);
			expect(description).toContain(
				"Never predict or invent a pending run's result; if the user asks, say it is still running",
			);
			expect(description).toContain(
				"A run stays open after it reports, and nothing closes it for you: once its work is done, close it with `subagent_close`. At most 8 runs stay open; `subagent_message` resumes a closed one.",
			);
		} finally {
			session.dispose();
		}
	});

	it("on pi's RPC, keeps delegation selective and points the model at batches, chains, Integration and Checks", async () => {
		vi.stubEnv("BLUCLAWD_RPC_RUNS", "1");
		const { session, faux } = await createParentSessionWithSubagents({
			cwd: makeTempDir("selective-cwd"),
			agentDir: makeTempDir("selective-agent"),
		});
		try {
			await session.bindExtensions({ mode: "tui" });
			let description = "";
			faux.setResponses([
				(context) => {
					description = getCurrentTools(context.messages).find((t) => t.name === "subagent")?.description ?? "";
					return fauxAssistantMessage("Done.");
				},
			]);
			await session.prompt("Delegate something.", { expandPromptTemplates: false });

			// Small work stays with the orchestrator; delegation is for useful independent or specialized work.
			expect(description).toContain("Do small work yourself");
			expect(description).toContain("give them together as `tasks`");
			expect(description).toContain("give them as `chain`");
			expect(description).toContain("No sequence of roles is required");
			expect(description).toContain("no need to fill every slot");
			// Read-only work needs no worktree; edits come back only through Integration, validated by a check.
			expect(description).toContain("A run that only reads shares your checkout and needs no worktree");
			expect(description).toContain("`subagent_integrate`");
			expect(description).toContain("Checks");
			expect(description).toContain("Do not paste the conversation or large file contents");
			expect(description).toContain("Do not redo or touch delegated work");
			expect(description).toContain("Progress from a run does not wake you");
			// What holds only for tmux runs is not said of RPC runs.
			expect(description).not.toContain("last write wins");
			expect(description).not.toContain("Tightly coupled sequential steps");
			expect(description).not.toContain("subagent_close");
		} finally {
			session.dispose();
		}
	});

	it("repeats the contract next to the run's name in the background launch result", async () => {
		const t = await createSubagentTui();
		tui = t;
		let launchResult = "";
		t.script([
			() => fauxAssistantMessage([launchCall("Inspect the repo.")]),
			(context) => {
				launchResult = toolResultText(context, "launch");
				return fauxAssistantMessage("Waiting for the explorer.");
			},
		]);
		await prompt(t, "Inspect the repo in the background.");

		expect(launchResult).toContain("Background subagent launched: explorer-1");
		expect(launchResult).toContain(
			"While explorer-1 runs, do not redo or touch its work, including the files in its scope",
		);
		expect(launchResult).toContain("do not poll `subagent_status` by reflex");
		expect(launchResult).toContain(
			"With no independent work left, end your turn and say you are waiting for explorer-1: its report will wake you",
		);
		expect(launchResult).toContain("Never predict or invent its result; if the user asks, say it is still running");
	});

	it("reminds every turn of the working runs by name, mode and elapsed time, and not once none is working", async () => {
		const t = await createSubagentTui();
		tui = t;
		const reminders: (string | undefined)[] = [];
		t.script([
			(context) => {
				reminders.push(reminderIn(context));
				return fauxAssistantMessage([launchCall("Inspect the repo.")]);
			},
			(context) => {
				reminders.push(reminderIn(context));
				return fauxAssistantMessage("Waiting for explorer-1.");
			},
			(context) => {
				reminders.push(reminderIn(context));
				return fauxAssistantMessage("Folded in the report.");
			},
		]);
		await prompt(t, "Inspect the repo in the background.");
		// As its pi does when it settles: idle first, then its Report, which wakes the orchestrator.
		t.activity("explorer-1", "idle");
		t.report("explorer-1", "Nothing to report.");
		await waitFor(() => reminders.length === 3);
		await t.session.waitForIdle();

		const [beforeLaunch, afterLaunch, afterReport] = reminders;
		expect(beforeLaunch).toBeUndefined();
		expect(afterLaunch).toMatch(/explorer-1: background, \d+s elapsed/);
		expect(afterReport).toBeUndefined();
	});

	it("keeps reminding on a new user prompt after a compaction while the run is still working", async () => {
		const t = await createSubagentTui();
		tui = t;
		let seen: TranscriptContext | undefined;
		t.script([
			() => fauxAssistantMessage([launchCall("Inspect the repo.")]),
			() => fauxAssistantMessage("Waiting for explorer-1."),
			() => fauxAssistantMessage("Noted."),
			() => fauxAssistantMessage("## Goal\nInspect the repo through explorer-1."),
			(context) => {
				seen = context;
				return fauxAssistantMessage("explorer-1 is still running.");
			},
		]);
		await prompt(t, "Inspect the repo in the background.");
		// Larger than the 20k tokens a compaction keeps, so the launch before it is summarized away.
		await prompt(t, `Keep these notes: ${"note ".repeat(20_000)}`);
		await t.session.compact();
		await prompt(t, "Is it done yet?");

		const userTexts = (seen?.messages ?? []).filter((m) => m.role === "user").map((m) => textOf(m.content));
		expect(userTexts.some((text) => text.includes("Inspect the repo through explorer-1"))).toBe(true);
		expect(seen && toolResultText(seen, "launch")).toBe("");
		expect(userTexts.some((text) => text.includes("Is it done yet?"))).toBe(true);
		expect(seen && reminderIn(seen)).toMatch(/explorer-1: background, \d+s elapsed/);
	});

	it("wakes the orchestrator once for Reports that arrive together, under one header for them", async () => {
		const t = await createSubagentTui({ batchWindowMs: 200 });
		tui = t;
		t.script([launch(["scout", "mapper"], { background: true }), () => fauxAssistantMessage("Waiting for both.")]);
		await prompt(t, "Map the repo with two runs.");

		t.report("scout", "Scouted.");
		t.report("mapper", "Mapped.");
		const woke = await waitFor(
			() =>
				t.session.messages.find(
					(message) => message.role === "custom" && JSON.stringify(message.content).includes("Mapped."),
				) ?? false,
		);
		const [text] = (woke as { content: { text: string }[] }).content;
		expect(text.text).toMatch(/^\[2 subagent reports\]\n\n---\n\n\[Report from subagent "scout"/);
	});

	it("wakes the orchestrator with a Report its run stored but could not send, once it reaches the daemon again", async () => {
		const t = await createSubagentTui();
		tui = t;
		t.script([launch(["scout"], { background: true }), () => fauxAssistantMessage("Waiting for scout.")]);
		await prompt(t, "Scout the repo.");

		t.storeReport("scout", "Scouted.");
		t.reconnect();
		t.reconnect();
		await waitFor(() =>
			expect(
				t.session.messages.filter(
					(message) => message.role === "custom" && JSON.stringify(message.content).includes("Scouted."),
				),
			).toHaveLength(1),
		);
	});

	it("leaves a closed run out of the reminder", async () => {
		const t = await createSubagentTui();
		tui = t;
		const reminders: (string | undefined)[] = [];
		t.script([
			() => fauxAssistantMessage([launchCall("Inspect the repo.")]),
			(context) => {
				reminders.push(reminderIn(context));
				return fauxAssistantMessage([fauxToolCall("subagent_close", { agent: "explorer-1" }, { id: "close" })]);
			},
			(context) => {
				reminders.push(reminderIn(context));
				return fauxAssistantMessage("Closed explorer-1.");
			},
		]);
		await prompt(t, "Inspect the repo in the background, then close it.");

		const [beforeClose, afterClose] = reminders;
		expect(beforeClose).toMatch(/explorer-1: background/);
		expect(afterClose).toBeUndefined();
	});

	it("leaves the runs of an earlier session epoch out of the reminder", async () => {
		const t = await createSubagentTui();
		tui = t;
		const reminders: (string | undefined)[] = [];
		t.script([
			() => fauxAssistantMessage([launchCall("Inspect the old session.")]),
			() => fauxAssistantMessage("Waiting for explorer-1."),
			(context) => {
				reminders.push(reminderIn(context));
				return fauxAssistantMessage([launchCall("Inspect the new session.")]);
			},
			(context) => {
				reminders.push(reminderIn(context));
				return fauxAssistantMessage("Waiting for the new run.");
			},
		]);
		await prompt(t, "Inspect the old session in the background.");
		// Pi emits this before it switches to another session, which starts a new session epoch.
		await t.session.extensionRunner.emit({ type: "session_before_switch", reason: "new" });
		await prompt(t, "Inspect the new session in the background.");

		const [beforeLaunch, afterLaunch] = reminders;
		expect(beforeLaunch).toBeUndefined();
		expect(afterLaunch).toMatch(/explorer-\d+: background/);
		expect(afterLaunch).not.toContain("explorer-1:");
	});
});

const REMINDER_MARKER = "their reports arrive on their own";

/** The active-run reminder the model sees in this request, if any. */
function reminderIn(context: TranscriptContext): string | undefined {
	return context.messages
		.filter((m) => m.role === "user")
		.map((m) => textOf(m.content))
		.find((text) => text.includes(REMINDER_MARKER));
}

function launchCall(task: string) {
	return fauxToolCall("subagent", { agent: "explorer", task, background: true }, { id: "launch" });
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string" ? content : content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

function toolResultText(context: TranscriptContext, toolCallId: string): string {
	const result = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === toolCallId);
	return result?.role === "toolResult" ? textOf(result.content) : "";
}
