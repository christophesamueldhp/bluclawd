import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../daemon/ansi.ts";
import { Tmux } from "../daemon/tmux.ts";
import { agentTasks } from "../ext/_shared/agent-tasks.ts";
import { STATUS_KEYS } from "../ext/_shared/status-keys.ts";
import { type BackgroundExec, backgroundBashJobs } from "../ext/background-bash/background-bash.ts";
import backgroundBash from "../ext/background-bash/index.ts";
import paste from "../ext/paste/index.ts";
import promptAssist from "../ext/prompt-assist/index.ts";
import { SUBAGENT_NOTIFICATION_CUSTOM_TYPE } from "../ext/subagents/index.ts";
import { readPersistedRunRecord } from "../ext/subagents/storage.ts";
import { createSubagentTui, launch, type SubagentTui } from "./helpers/subagent-tui.ts";
import { waitFor } from "./helpers/wait-for.ts";

// Prompt assistance reads its preferences from the real agent dir; point it at the faux provider.
vi.mock("../ext/prompt-assist/prefs.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../ext/prompt-assist/prefs.ts")>()),
	loadAssistModel: () => "faux-tool/faux-alt",
	loadAssistEnabled: () => true,
}));

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESC = "\x1b";

let tui: SubagentTui | undefined;
afterEach(() => {
	tui?.dispose();
	tui = undefined;
});

const row = (t: SubagentTui, name: string) => t.panel().find((line) => line.slice(2).startsWith(`${name} `));
const selected = (t: SubagentTui) => t.panel().find((line) => line.startsWith("❯ "));
const prompt = (t: SubagentTui, text = "Delegate.") => t.session.prompt(text, { expandPromptTemplates: false });
const readRecord = (t: SubagentTui, runId: string) => readPersistedRunRecord(t.agentDir, t.session.sessionId, runId);

/** Closes the run launched as `name`, as `/tasks` does. */
const close = (t: SubagentTui, name: string) => {
	const owner = t.session.sessionId;
	const task = agentTasks()
		?.list(owner)
		.find((candidate) => candidate.summary === `Task for ${name}`);
	if (!task) throw new Error(`No open run ${name}.`);
	expect(agentTasks()?.close(task.id, { owner })).toMatchObject({ ok: true });
};

/** A session with open background runs `names`. */
async function withOpenRuns(names: string[]) {
	const t = await createSubagentTui();
	tui = t;
	t.script([launch(names, { background: true })]);
	await prompt(t);
	await waitFor(() => names.every((name) => row(t, name)));
	return t;
}

describe("reaching the panel from the keyboard", () => {
	it("moves focus into the panel with ↓ on an empty prompt, on the first row", async () => {
		const t = await withOpenRuns(["scout", "mapper"]);
		const first = t.panel()[1].trim().split(" ")[0];

		t.press(DOWN);
		expect(t.editorFocused()).toBe(false);
		expect(selected(t)).toMatch(new RegExp(`^❯ ${first} `));
	});

	it("leaves ↓ to the prompt while it has a draft", async () => {
		const t = await withOpenRuns(["scout"]);

		t.press("h", "i", DOWN);
		expect(t.editorFocused()).toBe(true);
		expect(selected(t)).toBeUndefined();
	});

	it("leaves ↓ alone while an overlay is shown", async () => {
		const t = await withOpenRuns(["scout"]);

		t.setOverlay(true);
		t.press(DOWN);
		expect(t.editorFocused()).toBe(true);
		expect(selected(t)).toBeUndefined();
	});

	it("does nothing on ↓ while there are no runs to show", async () => {
		tui = await createSubagentTui();
		tui.script([() => fauxAssistantMessage("Nothing to delegate.")]);
		await prompt(tui, "Hello.");

		tui.press(DOWN);
		expect(tui.editorFocused()).toBe(true);
	});

	it("keeps ↓ for prompt history while browsing it, then moves into the panel", async () => {
		const t = await createSubagentTui({ extensions: [paste] });
		tui = t;
		t.script([launch(["scout"], { background: true })]);
		await prompt(t);
		await waitFor(() => row(t, "scout"));
		(t.editor() as unknown as { addToHistory(text: string): void }).addToHistory("Earlier prompt");

		t.press(UP);
		expect(t.editorText()).toBe("Earlier prompt");
		t.press(DOWN);
		expect(t.editorText()).toBe("");
		expect(t.editorFocused()).toBe(true);
		t.press(DOWN);
		expect(t.editorFocused()).toBe(false);
	});
});

describe("↓ with background shells running", () => {
	/** An exec that runs until it is aborted. */
	const forever: BackgroundExec = (_c, _w, { signal }) =>
		new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));

	afterEach(() => {
		for (const job of backgroundBashJobs.list()) backgroundBashJobs.kill(job.id);
	});

	/** A session with background-bash loaded first, as package.json loads it, and one running shell. */
	async function withShell() {
		const t = await createSubagentTui({ extensionsBefore: [backgroundBash] });
		tui = t;
		backgroundBashJobs.start({ command: "npm run dev", cwd: t.cwd, owner: t.session.sessionId, exec: forever });
		await waitFor(() => t.status(STATUS_KEYS.tasks)?.includes("1 shell"));
		return t;
	}

	it("goes to the panel while it shows rows", async () => {
		const t = await withShell();
		t.script([launch(["scout"], { background: true })]);
		await prompt(t);
		await waitFor(() => row(t, "scout"));

		t.press(DOWN);
		expect(selected(t)).toMatch(/^❯ scout /);
		expect(t.status(STATUS_KEYS.tasks)).not.toContain("Enter to view tasks");
	});

	it("has the pill offer /tasks instead of ↓ while the panel shows rows, and ↓ again once they leave", async () => {
		const t = await withShell();
		expect(t.status(STATUS_KEYS.tasks)).toContain("↓ to manage");
		t.script([launch(["scout"], { background: true })]);
		await prompt(t);
		await waitFor(() => row(t, "scout"));
		expect(t.status(STATUS_KEYS.tasks)).not.toContain("↓");
		expect(t.status(STATUS_KEYS.tasks)).toContain("/tasks to manage");

		t.press(DOWN, "x");
		await waitFor(() => !row(t, "scout"));
		expect(t.status(STATUS_KEYS.tasks)).toContain("↓ to manage");
	});

	it("has the pill offer ↓ again once a failed run's row leaves the panel", async () => {
		const t = await withShell();
		vi.mocked(Tmux.prototype.newSession).mockImplementationOnce(() => {
			throw new Error("tmux refused");
		});
		t.script([launch(["scout"], { background: true })]);
		await prompt(t);
		await waitFor(() => row(t, "scout")?.includes("failed"));
		expect(t.status(STATUS_KEYS.tasks)).toContain("/tasks to manage");

		t.advance(31_000);
		await waitFor(() => t.status(STATUS_KEYS.tasks)?.includes("↓ to manage"));
	});

	it("still selects the tasks pill while the panel is empty", async () => {
		const t = await withShell();

		t.press(DOWN);
		expect(t.editorFocused()).toBe(true);
		expect(t.status(STATUS_KEYS.tasks)).toContain("Enter to view tasks");
	});
});

describe("a focused panel", () => {
	it("moves between rows with ↑/↓, from main at the top to the last run, staying within them", async () => {
		const t = await withOpenRuns(["scout", "mapper", "fixer"]);

		// Sibling launches are admitted in no set order.
		const [first, , last] = t
			.panel()
			.slice(1, 4)
			.map((line) => line.trim().split(" ")[0]);

		t.press(DOWN, DOWN, DOWN);
		expect(selected(t)).toMatch(new RegExp(`^❯ ${last} `));
		t.press(DOWN);
		expect(selected(t)).toMatch(new RegExp(`^❯ ${last} `));
		t.press(UP, UP);
		expect(selected(t)).toMatch(new RegExp(`^❯ ${first} `));
		t.press(UP, UP);
		expect(selected(t)).toMatch(/^❯ main\b/);
	});

	it("gives the keyboard back on Enter on main, and hands it an x typed there", async () => {
		const t = await withOpenRuns(["scout"]);

		t.press(DOWN, UP, "\r");
		expect(t.editorFocused()).toBe(true);
		expect(t.editorText()).toBe("");
		t.press(DOWN, UP, "x");
		expect(t.editorFocused()).toBe(true);
		expect(t.editorText()).toBe("x");
		expect(row(t, "scout")).toBeDefined();
	});

	/** Three open runs; names in panel order. */
	async function withThreeRuns() {
		const t = await withOpenRuns(["scout", "mapper", "fixer"]);
		const names = t
			.panel()
			.slice(1, 4)
			.map((line) => line.trim().split(" ")[0]);
		return { t, names };
	}

	it("stays on the same run when a row above it leaves", async () => {
		const { t, names } = await withThreeRuns();

		t.press(DOWN, DOWN);
		expect(selected(t)).toMatch(new RegExp(`^❯ ${names[1]} `));
		close(t, names[0]);
		await waitFor(() => !row(t, names[0]));
		expect(selected(t)).toMatch(new RegExp(`^❯ ${names[1]} `));
	});

	it("moves to the nearest row when the selected run leaves", async () => {
		const { t, names } = await withThreeRuns();

		t.press(DOWN, DOWN);
		close(t, names[1]);
		await waitFor(() => !row(t, names[1]));
		expect(selected(t)).toMatch(new RegExp(`^❯ ${names[2]} `));
	});

	it("says which keys it takes", async () => {
		const t = await withOpenRuns(["scout"]);

		t.press(DOWN);
		expect(t.panel().at(-1)).toBe("  ↑/↓ to select · Enter to open · x to close · Esc to go back");
	});

	it("gives the keyboard back to the prompt on Esc", async () => {
		const t = await withOpenRuns(["scout"]);

		t.press(DOWN, ESC, "o", "k");
		expect(t.editorFocused()).toBe(true);
		expect(selected(t)).toBeUndefined();
		expect(t.editorText()).toBe("ok");
	});

	it("hands a typed character back to the prompt with the keyboard", async () => {
		const t = await withOpenRuns(["scout"]);

		t.press(DOWN, "h");
		expect(t.editorFocused()).toBe(true);
		expect(t.editorText()).toBe("h");
	});

	it("gives the keyboard back once its last run has left", async () => {
		const t = await withOpenRuns(["scout"]);

		t.press(DOWN);
		expect(t.editorFocused()).toBe(false);
		close(t, "scout");
		await waitFor(() => t.editorFocused());
		expect(t.panel()).toEqual(["/tasks to see subagents"]);
	});
});

describe("the prompt's editor wrappers with the panel present", () => {
	it("keeps prompt-assistance suggestions and collapsed pastes working", async () => {
		const t = await createSubagentTui({ extensions: [paste, promptAssist] });
		tui = t;
		t.script([launch(["scout"], { background: true })], (context) =>
			fauxAssistantMessage(JSON.stringify(context.messages).includes("Predict the next") ? "Check the report" : ""),
		);
		await prompt(t);
		await waitFor(() => row(t, "scout"));
		const shown = () => stripAnsi(t.editor().render(100).join("\n"));
		await waitFor(() => shown().includes("Check the report"));

		t.press(DOWN, ESC);
		expect(t.editorFocused()).toBe(true);
		expect(shown()).toContain("Check the report");
		t.press("\t");
		expect(t.editorText()).toBe("Check the report");

		t.editor().setText("");
		const pasted = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		t.press(DOWN, `\x1b[200~${pasted}\x1b[201~`);
		expect(t.editorFocused()).toBe(true);
		expect(t.editorText()).toMatch(/^\[Pasted text #1/);
	});
});

describe("x on a row", () => {
	it("closes the run the way a /tasks stop does, ending its pi without waking the orchestrator", async () => {
		const t = await createSubagentTui();
		tui = t;
		let parentTurns = 0;
		t.script([
			() => {
				parentTurns++;
				return launch(["scout"], { background: true })();
			},
			() => {
				parentTurns++;
				return fauxAssistantMessage("Launched; waiting.");
			},
			() => {
				parentTurns++;
				return fauxAssistantMessage("Woken.");
			},
		]);
		await prompt(t);
		await waitFor(() => row(t, "scout"));

		t.press(DOWN, "x");
		await waitFor(() => !row(t, "scout"));
		const runId = t.session.messages.flatMap((m) => JSON.stringify(m).match(/sub_[0-9a-f-]{36}/) ?? [])[0];
		await waitFor(() => readRecord(t, runId)?.status === "closed");
		expect(readRecord(t, runId)).toMatchObject({ status: "closed", stopSource: "user" });
		expect(t.runs[0]).toMatchObject({ name: "scout", ended: true });

		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(parentTurns).toBe(2);
		expect(
			t.session.messages.filter((m) => m.role === "custom" && m.customType === SUBAGENT_NOTIFICATION_CUSTOM_TYPE),
		).toEqual([]);
	});

	it("moves the selection to the next row, and closing the last gives the keyboard back", async () => {
		const t = await withOpenRuns(["scout", "mapper"]);
		const [closed, other] = t
			.panel()
			.slice(1, 3)
			.map((line) => line.trim().split(" ")[0]);

		t.press(DOWN, "x");
		await waitFor(() => !row(t, closed));
		expect(selected(t)).toMatch(new RegExp(`^❯ ${other} `));
		t.press("x");
		await waitFor(() => !row(t, other));
		expect(t.editorFocused()).toBe(true);
	});
});
