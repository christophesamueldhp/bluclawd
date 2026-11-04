import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../daemon/ansi.ts";
import { agentTasks } from "../ext/_shared/agent-tasks.ts";
import { STATUS_KEYS } from "../ext/_shared/status-keys.ts";
import { type BackgroundExec, backgroundBashJobs } from "../ext/background-bash/background-bash.ts";
import backgroundBash from "../ext/background-bash/index.ts";
import paste from "../ext/paste/index.ts";
import promptAssist from "../ext/prompt-assist/index.ts";
import { SUBAGENT_NOTIFICATION_CUSTOM_TYPE } from "../ext/subagents/index.ts";
import { readPersistedRunRecord } from "../ext/subagents/storage.ts";
import { createSubagentTui, gate, launch, REPORT, type SubagentTui } from "./helpers/subagent-tui.ts";
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

/** A session with background runs `names` that keep running until `child.open()`. */
async function withRunningRuns(names: string[]) {
	const t = await createSubagentTui();
	tui = t;
	const child = gate();
	t.script([launch(names, { background: true })], async () => {
		await child.wait;
		return fauxAssistantMessage(REPORT);
	});
	await prompt(t);
	await waitFor(() => names.every((name) => row(t, name)));
	return { t, child };
}

describe("reaching the panel from the keyboard", () => {
	it("moves focus into the panel with ↓ on an empty prompt, on the first row", async () => {
		const { t, child } = await withRunningRuns(["scout", "mapper"]);
		const first = t.panel()[1].trim().split(" ")[0];

		t.press(DOWN);
		expect(t.editorFocused()).toBe(false);
		expect(selected(t)).toMatch(new RegExp(`^❯ ${first} `));
		child.open();
	});

	it("leaves ↓ to the prompt while it has a draft", async () => {
		const { t, child } = await withRunningRuns(["scout"]);

		t.press("h", "i", DOWN);
		expect(t.editorFocused()).toBe(true);
		expect(selected(t)).toBeUndefined();
		child.open();
	});

	it("leaves ↓ alone while an overlay is shown", async () => {
		const { t, child } = await withRunningRuns(["scout"]);

		t.setOverlay(true);
		t.press(DOWN);
		expect(t.editorFocused()).toBe(true);
		expect(selected(t)).toBeUndefined();
		child.open();
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
		const child = gate();
		t.script([launch(["scout"], { background: true })], async () => {
			await child.wait;
			return fauxAssistantMessage(REPORT);
		});
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
		child.open();
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
		const child = gate();
		t.script([launch(["scout"], { background: true })], async () => {
			await child.wait;
			return fauxAssistantMessage(REPORT);
		});
		await prompt(t);
		await waitFor(() => row(t, "scout"));

		t.press(DOWN);
		expect(selected(t)).toMatch(/^❯ scout /);
		expect(t.status(STATUS_KEYS.tasks)).not.toContain("Enter to view tasks");
		child.open();
	});

	it("has the pill offer /tasks instead of ↓ while the panel shows rows", async () => {
		const t = await withShell();
		expect(t.status(STATUS_KEYS.tasks)).toContain("↓ to manage");
		const child = gate();
		t.script([launch(["scout"], { background: true })], async () => {
			await child.wait;
			return fauxAssistantMessage(REPORT);
		});
		await prompt(t);
		await waitFor(() => row(t, "scout"));
		expect(t.status(STATUS_KEYS.tasks)).not.toContain("↓");
		expect(t.status(STATUS_KEYS.tasks)).toContain("/tasks to manage");

		child.open();
		await waitFor(() => row(t, "scout")?.includes("completed") ?? false);
		t.press(DOWN, "x");
		expect(t.panel()).toEqual([]);
		expect(t.status(STATUS_KEYS.tasks)).toContain("↓ to manage");
	});

	it("has the pill offer ↓ again as soon as /tasks dismisses the panel's last row", async () => {
		const t = await withShell();
		t.script([launch(["scout"], { background: true })]);
		await prompt(t);
		await waitFor(() => row(t, "scout")?.includes("completed") ?? false);
		expect(t.status(STATUS_KEYS.tasks)).toContain("/tasks to manage");

		const [done] = agentTasks()?.listDone?.(t.session.sessionId) ?? [];
		expect(agentTasks()?.dismiss?.(done.id, t.session.sessionId)).toBe(true);
		expect(t.status(STATUS_KEYS.tasks)).toContain("↓ to manage");
		expect(t.panel()).toEqual([]);
	});

	it("still selects the tasks pill while the panel is empty", async () => {
		const t = await withShell();

		t.press(DOWN);
		expect(t.editorFocused()).toBe(true);
		expect(t.status(STATUS_KEYS.tasks)).toContain("Enter to view tasks");
	});
});

describe("a focused panel", () => {
	it("moves between rows with ↑/↓, staying within them", async () => {
		const { t, child } = await withRunningRuns(["scout", "mapper", "fixer"]);

		// Sibling launches are admitted in no set order.
		const [first, , last] = t
			.panel()
			.slice(1, 4)
			.map((line) => line.trim().split(" ")[0]);

		t.press(DOWN, DOWN, DOWN);
		expect(selected(t)).toMatch(new RegExp(`^❯ ${last} `));
		t.press(DOWN);
		expect(selected(t)).toMatch(new RegExp(`^❯ ${last} `));
		t.press(UP, UP, UP);
		expect(selected(t)).toMatch(new RegExp(`^❯ ${first} `));
		child.open();
	});

	/** Three running runs, each finishing when its own gate opens; names in panel order. */
	async function withSeparateRuns() {
		const t = await createSubagentTui();
		tui = t;
		const gates = new Map(["scout", "mapper", "fixer"].map((name) => [name, gate()]));
		t.script([launch([...gates.keys()], { background: true })], async (context) => {
			// The child's task leads its first message; the roster after it names the siblings' tasks too.
			const task = JSON.stringify(context.messages.find((m) => m.role === "user"));
			await [...gates].find(([name]) => task.includes(`"text":"Task for ${name}\\n`))?.[1].wait;
			return fauxAssistantMessage(REPORT);
		});
		await prompt(t);
		await waitFor(() => [...gates.keys()].every((name) => row(t, name)));
		const names = t
			.panel()
			.slice(1, 4)
			.map((line) => line.trim().split(" ")[0]);
		/** Lets `name` finish and waits until it has left the panel. */
		const finish = async (name: string) => {
			gates.get(name)?.open();
			await waitFor(() => row(t, name)?.includes("completed") ?? false);
			t.advance(31_000);
			await waitFor(() => !row(t, name));
		};
		const openAll = () => {
			for (const g of gates.values()) g.open();
		};
		return { t, names, finish, openAll };
	}

	it("stays on the same run when a row above it leaves", async () => {
		const { t, names, finish, openAll } = await withSeparateRuns();

		t.press(DOWN, DOWN);
		expect(selected(t)).toMatch(new RegExp(`^❯ ${names[1]} `));
		await finish(names[0]);
		expect(selected(t)).toMatch(new RegExp(`^❯ ${names[1]} `));
		openAll();
	});

	it("moves to the nearest row when the selected run leaves", async () => {
		const { t, names, finish, openAll } = await withSeparateRuns();

		t.press(DOWN, DOWN);
		await finish(names[1]);
		expect(selected(t)).toMatch(new RegExp(`^❯ ${names[2]} `));
		openAll();
	});

	it("says which keys it takes", async () => {
		const { t, child } = await withRunningRuns(["scout"]);

		t.press(DOWN);
		expect(t.panel().at(-1)).toBe("  ↑/↓ to select · x to stop · Esc to go back");
		child.open();
	});

	it("gives the keyboard back to the prompt on Esc", async () => {
		const { t, child } = await withRunningRuns(["scout"]);

		t.press(DOWN, ESC, "o", "k");
		expect(t.editorFocused()).toBe(true);
		expect(selected(t)).toBeUndefined();
		expect(t.editorText()).toBe("ok");
		child.open();
	});

	it("hands a typed character back to the prompt with the keyboard", async () => {
		const { t, child } = await withRunningRuns(["scout"]);

		t.press(DOWN, "h");
		expect(t.editorFocused()).toBe(true);
		expect(t.editorText()).toBe("h");
		child.open();
	});

	it("gives the keyboard back once its last run has left", async () => {
		tui = await createSubagentTui();
		tui.script([launch(["scout"], { background: true })]);
		await prompt(tui);
		await waitFor(() => row(tui!, "scout")?.includes("completed") ?? false);

		tui.press(DOWN);
		expect(tui.editorFocused()).toBe(false);
		tui.advance(31_000);
		await waitFor(() => tui!.editorFocused());
		expect(tui.panel()).toEqual([]);
	});
});

describe("the prompt's editor wrappers with the panel present", () => {
	it("keeps prompt-assistance suggestions and collapsed pastes working", async () => {
		const t = await createSubagentTui({ extensions: [paste, promptAssist] });
		tui = t;
		const child = gate();
		t.script(
			[launch(["scout"], { background: true })],
			async () => {
				await child.wait;
				return fauxAssistantMessage(REPORT);
			},
			(context) =>
				fauxAssistantMessage(
					JSON.stringify(context.messages).includes("Predict the next") ? "Check the report" : "",
				),
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
		child.open();
	});
});

describe("x on a row", () => {
	it("stops a running run the way a /tasks stop does, without waking the orchestrator", async () => {
		const t = await createSubagentTui();
		tui = t;
		const child = gate();
		let parentTurns = 0;
		t.script(
			[
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
			],
			async () => {
				await child.wait;
				return fauxAssistantMessage(REPORT);
			},
		);
		await prompt(t);
		await waitFor(() => row(t, "scout"));

		t.press(DOWN, "x");
		await waitFor(() => row(t, "scout")?.includes("stopping") ?? false);
		child.open();
		await waitFor(() => row(t, "scout")?.includes("cancelled") ?? false);
		const runId = t.session.messages.flatMap((m) => JSON.stringify(m).match(/sub_[0-9a-f-]{36}/) ?? [])[0];
		expect(readRecord(t, runId)).toMatchObject({ status: "cancelled", stopSource: "user" });

		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(parentTurns).toBe(2);
		expect(
			t.session.messages.filter((m) => m.role === "custom" && m.customType === SUBAGENT_NOTIFICATION_CUSTOM_TYPE),
		).toEqual([]);
	});

	it("dismisses a run that has ended, and a second x stops nothing else", async () => {
		const { t, child } = await withRunningRuns(["scout", "mapper"]);
		const [stopped, other] = t
			.panel()
			.slice(1, 3)
			.map((line) => line.trim().split(" ")[0]);

		t.press(DOWN, "x");
		await waitFor(() => row(t, stopped)?.includes("stopping") ?? false);
		child.open();
		await waitFor(() => row(t, stopped)?.includes("cancelled") && row(t, other)?.includes("completed"));
		expect(t.panel().at(-1)).toBe("  ↑/↓ to select · x to dismiss · Esc to go back");

		t.press("x");
		expect(row(t, stopped)).toBeUndefined();
		expect(selected(t)).toMatch(new RegExp(`^❯ ${other} `));
		t.press("x");
		expect(t.panel()).toEqual([]);
		expect(t.editorFocused()).toBe(true);
	});
});
