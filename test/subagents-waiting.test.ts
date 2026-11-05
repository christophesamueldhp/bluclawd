import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	getSystemMessageText,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createParentSessionWithSubagents } from "./helpers/subagent-session.ts";
import { waitFor } from "./helpers/wait-for.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-waiting-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		// A cancelled run may still be writing its final record; retry while the directory refills.
		if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
	}
});

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

	it("repeats the contract next to the run's name in the background launch result", async () => {
		const { session, faux } = await createParentSessionWithSubagents({
			cwd: makeTempDir("launch-cwd"),
			agentDir: makeTempDir("launch-agent"),
		});
		const child = gate();
		try {
			await session.bindExtensions({ mode: "tui" });
			let launchResult = "";
			faux.setResponses(
				script(child, [
					() => fauxAssistantMessage([launchCall("Inspect the repo.")]),
					(context) => {
						launchResult = toolResultText(context, "launch");
						return fauxAssistantMessage("Waiting for the explorer.");
					},
				]),
			);
			await session.prompt("Inspect the repo in the background.", { expandPromptTemplates: false });

			expect(launchResult).toContain("Background subagent launched: explorer-1");
			expect(launchResult).toContain(
				"While explorer-1 runs, do not redo or touch its work, including the files in its scope",
			);
			expect(launchResult).toContain("do not poll `subagent_status` by reflex");
			expect(launchResult).toContain(
				"With no independent work left, end your turn and say you are waiting for explorer-1: its report will wake you",
			);
			expect(launchResult).toContain(
				"Never predict or invent its result; if the user asks, say it is still running",
			);
		} finally {
			child.open();
			session.dispose();
		}
	});

	it("reminds every turn of the active runs by name, mode and elapsed time, and not once none is active", async () => {
		const { session, faux } = await createParentSessionWithSubagents({
			cwd: makeTempDir("reminder-cwd"),
			agentDir: makeTempDir("reminder-agent"),
		});
		const child = gate();
		const reminders: (string | undefined)[] = [];
		try {
			await session.bindExtensions({ mode: "tui" });
			faux.setResponses(
				script(child, [
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
				]),
			);
			await session.prompt("Inspect the repo in the background.", { expandPromptTemplates: false });
			child.open();
			await waitFor(() => reminders.length === 3);
			await session.waitForIdle();

			const [beforeLaunch, afterLaunch, afterReport] = reminders;
			expect(beforeLaunch).toBeUndefined();
			expect(afterLaunch).toMatch(/explorer-1: background, \d+s elapsed/);
			expect(afterReport).toBeUndefined();
		} finally {
			child.open();
			session.dispose();
		}
	});

	it("keeps reminding on a new user prompt after a compaction while the run is still active", async () => {
		const { session, faux } = await createParentSessionWithSubagents({
			cwd: makeTempDir("compaction-cwd"),
			agentDir: makeTempDir("compaction-agent"),
		});
		const child = gate();
		let seen: TranscriptContext | undefined;
		try {
			await session.bindExtensions({ mode: "tui" });
			faux.setResponses(
				script(child, [
					() => fauxAssistantMessage([launchCall("Inspect the repo.")]),
					() => fauxAssistantMessage("Waiting for explorer-1."),
					() => fauxAssistantMessage("Noted."),
					() => fauxAssistantMessage("## Goal\nInspect the repo through explorer-1."),
					(context) => {
						seen = context;
						return fauxAssistantMessage("explorer-1 is still running.");
					},
				]),
			);
			await session.prompt("Inspect the repo in the background.", { expandPromptTemplates: false });
			// Larger than the 20k tokens a compaction keeps, so the launch before it is summarized away.
			await session.prompt(`Keep these notes: ${"note ".repeat(20_000)}`, { expandPromptTemplates: false });
			await session.compact();
			await session.prompt("Is it done yet?", { expandPromptTemplates: false });

			const userTexts = (seen?.messages ?? []).filter((m) => m.role === "user").map((m) => textOf(m.content));
			expect(userTexts.some((text) => text.includes("Inspect the repo through explorer-1"))).toBe(true);
			expect(seen && toolResultText(seen, "launch")).toBe("");
			expect(userTexts.some((text) => text.includes("Is it done yet?"))).toBe(true);
			expect(seen && reminderIn(seen)).toMatch(/explorer-1: background, \d+s elapsed/);
		} finally {
			child.open();
			session.dispose();
		}
	});

	it("leaves a run that is being stopped out of the reminder", async () => {
		const { session, faux } = await createParentSessionWithSubagents({
			cwd: makeTempDir("stopping-cwd"),
			agentDir: makeTempDir("stopping-agent"),
		});
		const child = gate();
		const reminders: (string | undefined)[] = [];
		try {
			await session.bindExtensions({ mode: "tui" });
			faux.setResponses(
				script(child, [
					() => fauxAssistantMessage([launchCall("Inspect the repo.")]),
					(context) => {
						reminders.push(reminderIn(context));
						return fauxAssistantMessage([fauxToolCall("subagent_stop", { agent: "explorer-1" }, { id: "stop" })]);
					},
					(context) => {
						reminders.push(reminderIn(context));
						return fauxAssistantMessage("Stopped explorer-1.");
					},
				]),
			);
			await session.prompt("Inspect the repo in the background, then stop it.", { expandPromptTemplates: false });

			const [beforeStop, afterStop] = reminders;
			expect(beforeStop).toMatch(/explorer-1: background/);
			expect(afterStop).toBeUndefined();
		} finally {
			child.open();
			session.dispose();
		}
	});

	it("leaves the runs of an earlier session epoch out of the reminder", async () => {
		const { session, faux } = await createParentSessionWithSubagents({
			cwd: makeTempDir("epoch-cwd"),
			agentDir: makeTempDir("epoch-agent"),
		});
		const child = gate();
		const reminders: (string | undefined)[] = [];
		try {
			await session.bindExtensions({ mode: "tui" });
			faux.setResponses(
				script(child, [
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
				]),
			);
			await session.prompt("Inspect the old session in the background.", { expandPromptTemplates: false });
			// Pi emits this before it switches to another session, which starts a new session epoch.
			await session.extensionRunner.emit({ type: "session_before_switch", reason: "new" });
			await session.prompt("Inspect the new session in the background.", { expandPromptTemplates: false });

			const [beforeLaunch, afterLaunch] = reminders;
			expect(beforeLaunch).toBeUndefined();
			expect(afterLaunch).toMatch(/explorer-\d+: background/);
			expect(afterLaunch).not.toContain("explorer-1:");
		} finally {
			child.open();
			session.dispose();
		}
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

type Step = (context: TranscriptContext) => AssistantMessage | Promise<AssistantMessage>;

function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

function isChildContext(context: TranscriptContext): boolean {
	const system = context.messages.find((m) => m.role === "system");
	return system?.role === "system" && getSystemMessageText(system).includes("subagent operating in a fresh context");
}

/** Faux responses where each child waits for `child` and reports, and the parent takes `parentTurns` in order. */
function script(child: { opened: Promise<void> }, parentTurns: Step[]): Step[] {
	let parentTurn = 0;
	const step: Step = async (context) => {
		if (isChildContext(context)) {
			await child.opened;
			return fauxAssistantMessage("### Summary\nNothing to report.\n### Blockers\n- none");
		}
		const next = parentTurns[parentTurn++];
		return next ? next(context) : fauxAssistantMessage("Unscripted parent turn.");
	};
	return Array.from({ length: parentTurns.length + 4 }, () => step);
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
