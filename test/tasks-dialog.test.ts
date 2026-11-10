import { afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../daemon/ansi.ts";
import { type AgentTask, publishAgentTasks } from "../ext/_shared/agent-tasks.ts";
import { type BackgroundExec, backgroundBashJobs } from "../ext/background-bash/background-bash.ts";
import { detachableExec, runningForegroundShells } from "../ext/background-bash/foreground-shells.ts";
import { TasksDialog, visibleRows } from "../ext/background-bash/tasks-dialog.ts";
import { wakeups } from "../ext/background-bash/wakeups.ts";

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

/** Runs until it is stopped. */
const forever: BackgroundExec = (_c, _w, { signal }) =>
	new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
const tick = () => new Promise((r) => setTimeout(r, 0));
const RUNNING = process.platform === "darwin" ? "⏺" : "●";

let owner = 0;
function session() {
	return `dialog-test-${++owner}`;
}

function open(sessionOwner: string, rows?: number) {
	const state = { closed: false, notes: [] as string[] };
	const dialog = new TasksDialog(
		theme,
		sessionOwner,
		() => {
			state.closed = true;
		},
		() => {},
		{ notify: (m) => state.notes.push(m), rows: rows === undefined ? undefined : () => rows },
	);
	const screen = () => stripAnsi(dialog.render(100).join("\n"));
	return { dialog, state, screen };
}

afterEach(() => {
	for (const job of backgroundBashJobs.list()) backgroundBashJobs.kill(job.id);
	for (const wakeup of wakeups.list()) wakeups.take(wakeup.id);
});

describe("/tasks dialog", () => {
	it("lists only running tasks, in bluclawd's words", async () => {
		const me = session();
		backgroundBashJobs.start({ command: "npm run dev", cwd: "/", owner: me, exec: forever });
		backgroundBashJobs.start({ command: "tail -f log", cwd: "/", owner: me, exec: forever });
		backgroundBashJobs.start({ command: "true", cwd: "/", owner: me, exec: async () => ({ exitCode: 0 }) });
		await tick();
		const out = open(me).screen();
		// A blank line and a full-width rule, then the body two columns in.
		expect(out.startsWith(`\n${"─".repeat(100)}\n  Background\n  2 active shells\n\n`)).toBe(true);
		// Pointer, running icon, label, and the status in a column past the longest label.
		expect(out).toContain(`  ❯ ${RUNNING} tail -f log   running`);
		expect(out).toContain(`    ${RUNNING} npm run dev   running`);
		expect(out).not.toContain("true");
		// No header for Shells when nothing else is listed.
		expect(out).not.toContain("Shells");
		expect(out.endsWith("\n\n  ↑/↓ to select · Enter to view · x to stop · Esc to close")).toBe(true);
	});

	it("says so when nothing runs", () => {
		expect(open(session()).screen()).toContain("  Background\n\n  No tasks currently running\n");
	});

	it("opens straight to the only task, and closes when it is left", () => {
		const me = session();
		backgroundBashJobs.start({ command: "npm run dev", cwd: "/", owner: me, exec: forever });
		const { dialog, state, screen } = open(me);
		const out = screen();
		expect(out).toContain("  Shell details\n\n");
		// A table: values line up past the widest label.
		expect(out).toContain("  Status:   running\n");
		expect(out).toContain("  Command:  npm run dev\n");
		expect(out).toContain("  ← to go back · Esc/Enter/Space to close · x to stop");
		// No output yet: no box, just the note.
		expect(out).toContain("  Output:\n  No output available\n");
		dialog.handleInput("\x1b[D");
		expect(state.closed).toBe(true);
	});

	it("says the detail was dismissed when it closes from there", () => {
		const me = session();
		backgroundBashJobs.start({ command: "npm run dev", cwd: "/", owner: me, exec: forever });
		const { dialog, state } = open(me);
		dialog.handleInput(" ");
		expect(state.notes).toEqual(["Shell details dismissed"]);
		expect(state.closed).toBe(true);
	});

	it("goes back to the list when the viewed task ends", async () => {
		const me = session();
		const a = backgroundBashJobs.start({ command: "a-cmd", cwd: "/", owner: me, exec: forever });
		await new Promise((r) => setTimeout(r, 5));
		backgroundBashJobs.start({ command: "b-cmd", cwd: "/", owner: me, exec: forever });
		const { dialog, screen } = open(me);
		// Newest first: b, then a.
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\r");
		expect(screen()).toContain("  Command:  a-cmd");
		backgroundBashJobs.kill(a.id);
		await tick();
		const out = screen();
		expect(out).toContain("  Background");
		expect(out).not.toContain("a-cmd");
	});

	it("gives a WebSocket monitor its own section, without a detail view", () => {
		const me = session();
		backgroundBashJobs.start({
			command: "wss://x",
			description: "deploys",
			cwd: "/",
			owner: me,
			kind: "monitor",
			idPrefix: "s",
			exec: forever,
		});
		backgroundBashJobs.start({ command: "npm run dev", cwd: "/", owner: me, exec: forever });
		const { dialog, screen } = open(me);
		// The shell was started last, so it leads; move to the monitor.
		dialog.handleInput("\x1b[B");
		const out = screen();
		expect(out).toContain("\n\n    Monitors (1)\n");
		expect(out).toContain(`  ❯ ${RUNNING} deploys       running`);
		expect(out).toContain("  ↑/↓ to select · x to stop · Esc to close");
		dialog.handleInput("\r");
		expect(screen()).not.toContain("details");
	});

	it("lists the session's pending wake-ups, earliest first, and cancels one with x", () => {
		const me = session();
		const tomorrow = (hours: number, minutes: number) => {
			const now = new Date();
			return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hours, minutes).getTime();
		};
		const onDue = () => {};
		backgroundBashJobs.start({ command: "npm run dev", cwd: "/", owner: me, exec: forever });
		wakeups.schedule({ owner: me, prompt: "Check the deploy", dueAt: tomorrow(14, 5), onDue });
		wakeups.schedule({ owner: me, prompt: "Check CI\nthen merge", dueAt: tomorrow(9, 30), onDue });
		wakeups.schedule({ owner: session(), prompt: "Not mine", dueAt: tomorrow(10, 0), onDue });
		const { dialog, screen } = open(me);
		const out = screen();
		expect(out).toContain("\n\n    Wake-ups (2)\n");
		expect(out).toMatch(
			/Wake-ups \(2\)\n {4}. Check CI then merge +wakes 09:30\n {4}. Check the deploy +wakes 14:05\n/,
		);
		expect(out).not.toContain("Not mine");
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\x1b[B");
		expect(screen()).toContain("  ↑/↓ to select · x to cancel · Esc to close");
		dialog.handleInput("\r");
		expect(screen()).not.toContain("details");
		dialog.handleInput("x");
		expect(wakeups.list(me).map((w) => w.prompt)).toEqual(["Check CI\nthen merge"]);
	});

	it("stops the selected task as the user", async () => {
		const me = session();
		const a = backgroundBashJobs.start({ command: "a-cmd", cwd: "/", owner: me, exec: forever });
		await new Promise((r) => setTimeout(r, 5));
		backgroundBashJobs.start({ command: "b-cmd", cwd: "/", owner: me, exec: forever });
		const { dialog } = open(me);
		dialog.handleInput("\x1b[B");
		dialog.handleInput("x");
		await tick();
		expect(backgroundBashJobs.get(a.id)).toMatchObject({ killed: true, stoppedByUser: true });
	});

	it("lists a subagent's shells in the main session", () => {
		const me = session();
		backgroundBashJobs.start({ command: "child-cmd", cwd: "/", owner: "child", agentId: "child", exec: forever });
		backgroundBashJobs.start({ command: "mine", cwd: "/", owner: me, exec: forever });
		const out = open(me).screen();
		expect(out).toContain(`${RUNNING} child-cmd   running`);
		expect(out).toContain(`${RUNNING} mine        running`);
	});

	it("shows the output tail in a rounded box, with the file size when it was cut", async () => {
		const me = session();
		const exec: BackgroundExec = (_c, _w, { onData, signal }) => {
			onData(Buffer.from(`${Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")}\n`));
			return new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
		};
		backgroundBashJobs.start({ command: "gen", cwd: "/", owner: me, exec });
		await tick();
		const out = open(me).screen();
		// bluclawd's count: the last ten newline pieces, the empty one after the final newline dropped.
		expect(out).toContain("  │ line 21");
		expect(out).toContain("  │ line 29");
		expect(out).not.toContain("line 20");
		expect(out).toContain("  Showing 9 lines");
		const lines = out.split("\n");
		const top = lines.findIndex((l) => l.startsWith("  ╭"));
		// Two columns narrower than the body, borders included, and twelve rows high.
		expect(lines[top]).toBe(`  ╭${"─".repeat(92)}╮`);
		expect(lines[top + 11]).toBe(`  ╰${"─".repeat(92)}╯`);
	});

	it("scrolls a long list, counting the rows beyond it", async () => {
		const me = session();
		for (let i = 0; i < 12; i++) {
			backgroundBashJobs.start({ command: `cmd-${String(i).padStart(2, "0")}`, cwd: "/", owner: me, exec: forever });
			await new Promise((r) => setTimeout(r, 2));
		}
		// Sixteen terminal rows: an eight-line window, six rows and two count lines.
		const { dialog, screen } = open(me, 16);
		let out = screen();
		expect(out).toContain("cmd-11");
		expect(out).toContain("cmd-06");
		expect(out).not.toContain("cmd-05");
		expect(out).not.toContain("more above");
		expect(out).toContain("    ↓ 6 more below");
		for (let i = 0; i < 7; i++) dialog.handleInput("\x1b[B");
		out = screen();
		expect(out).toContain("    ↑ 2 more above");
		expect(out).toContain(`❯ ${RUNNING} cmd-04`);
		expect(out).toContain("    ↓ 4 more below");
	});

	it("does not stop the task that slid under the cursor when the focused one ended", async () => {
		const me = session();
		const a = backgroundBashJobs.start({ command: "a-cmd", cwd: "/", owner: me, exec: forever });
		await new Promise((r) => setTimeout(r, 5));
		const b = backgroundBashJobs.start({ command: "b-cmd", cwd: "/", owner: me, exec: forever });
		const { dialog, screen } = open(me);
		screen();
		// b is focused; it ends and a takes its place.
		backgroundBashJobs.kill(b.id);
		await tick();
		dialog.handleInput("x");
		await tick();
		expect(backgroundBashJobs.get(a.id)?.killed).toBeFalsy();
		dialog.handleInput("x");
		await tick();
		expect(backgroundBashJobs.get(a.id)).toMatchObject({ killed: true, stoppedByUser: true });
	});
});

describe("/tasks dialog: the model's foreground bash", () => {
	/** A foreground command through detachableExec, whose output and end the test drives. */
	function foreground(command: string, owner: string) {
		let emit!: (s: string) => void;
		const exec: BackgroundExec = (_c, _w, { onData, signal }) =>
			new Promise((_resolve, reject) => {
				emit = (s) => onData(Buffer.from(s));
				signal?.addEventListener("abort", () => reject(new Error("aborted")));
			});
		const run = detachableExec(exec, { owner })(command, "/", { onData: () => {} });
		return { run, emit: (s: string) => emit(s) };
	}

	afterEach(() => vi.useRealTimers());

	it("lists it once it has run 2s, with its output, and x kills it", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const me = session();
		const { run, emit } = foreground("npm test", me);
		emit("PASS a.test.ts\n");
		expect(open(me).screen()).toContain("No tasks currently running");

		vi.setSystemTime(Date.now() + 2000);
		backgroundBashJobs.start({ command: "npm run dev", cwd: "/", owner: me, exec: forever });
		const { dialog, screen } = open(me);
		const list = screen();
		expect(list).toContain(`${RUNNING} npm run dev   running`);
		expect(list).toContain(`${RUNNING} npm test      foreground`);

		// The background shell started last, so it leads.
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\r");
		const detail = screen();
		expect(detail).toContain("  Status:   running (foreground)\n");
		expect(detail).toContain("  Command:  npm test\n");
		expect(detail).toContain("PASS a.test.ts");

		dialog.handleInput("x");
		await expect(run).rejects.toThrow("aborted");
		expect(screen()).not.toContain("npm test");
	});

	it("is not another session's", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { run } = foreground("npm test", "someone-else");
		run.catch(() => {});
		vi.setSystemTime(Date.now() + 2000);
		expect(open(session()).screen()).toContain("No tasks currently running");
		for (const shell of runningForegroundShells()) shell.stop();
	});
});

describe("Ticket #20 — close all agents from /tasks", () => {
	it("closes every open agent of this session with X and shows the hints only while agents run", async () => {
		const { publishAgentTasks } = await import("../ext/_shared/agent-tasks.ts");
		const me = session();
		const calls: Array<{ owner?: string; source?: string }> = [];
		let running = true;
		const unpublish = publishAgentTasks({
			list: (listOwner) =>
				running && listOwner === me
					? ["sub_1", "sub_2"].map((id) => ({
							id,
							owner: me,
							agent: "general-purpose",
							summary: `Build ${id}`,
							startedAt: Date.now(),
							state: "running" as const,
							status: "running",
							model: "faux/faux-1",
							outputFile: "",
							output: () => "",
						}))
					: [],
			get: () => undefined,
			close: () => ({ ok: false, reason: "not_found" }),
			closeAll: (options) => {
				calls.push({ owner: options?.owner, source: options?.source });
				running = false;
				return 1;
			},
		});
		try {
			const { dialog, screen } = open(me);
			expect(screen()).toContain("x to close · X to close all agents");
			dialog.handleInput("X");
			expect(calls).toEqual([{ owner: me, source: "user" }]);
			expect(screen()).not.toContain("X to close all agents");
		} finally {
			unpublish();
		}
	});
});

describe("/tasks dialog: finished runs", () => {
	function agentTask(me: string, id: string, state: AgentTask["state"]): AgentTask {
		return {
			id,
			owner: me,
			agent: "explorer",
			summary: `Task for ${id}`,
			startedAt: Date.now(),
			endedAt: state === "running" ? undefined : Date.now(),
			state,
			status: state,
			model: "faux/faux-1",
			outputFile: "",
			output: () => "",
		};
	}

	/** A source with one running run and two finished ones, recording what the dialog asks of it. */
	function source(me: string) {
		const calls = { opened: [] as string[][], dismissed: [] as string[][] };
		// Newest first: sub_done started last.
		const done = [
			{ ...agentTask(me, "sub_done", "completed"), startedAt: 2000 },
			{ ...agentTask(me, "sub_failed", "failed"), startedAt: 1000 },
		];
		unpublish = publishAgentTasks({
			list: (listOwner) => (listOwner === me ? [agentTask(me, "sub_live", "running")] : []),
			listDone: (listOwner) => (listOwner === me ? [...done] : []),
			get: () => undefined,
			close: () => ({ ok: false, reason: "not_found" }),
			closeAll: () => 0,
			dismiss: (id, dismissOwner) => {
				calls.dismissed.push([id, String(dismissOwner)]);
				done.splice(
					done.findIndex((task) => task.id === id),
					1,
				);
				return true;
			},
			open: (id, openOwner) => {
				calls.opened.push([id, String(openOwner)]);
				return Promise.resolve();
			},
		});
		return calls;
	}

	let unpublish: (() => void) | undefined;
	afterEach(() => {
		unpublish?.();
		unpublish = undefined;
	});

	it("lists them in a Done section, each with its model and status, and keeps them off the running list", () => {
		const me = session();
		source(me);
		const out = open(me).screen();
		expect(out).toContain("  1 active agent\n");
		expect(out).toContain("    Local agents (1)\n");
		expect(out).toMatch(/explorer: Task for sub_live +faux\/faux-1 · running/);
		expect(out).toContain("\n\n    Done (2)\n");
		expect(out).toMatch(/explorer: Task for sub_done +faux\/faux-1 · completed/);
		expect(out).toMatch(/explorer: Task for sub_failed +faux\/faux-1 · failed/);
		// The phone's task list is the running one.
		expect(visibleRows(me).map((row) => row.id)).toEqual(["sub_live"]);
	});

	it("opens a running or a finished run's transcript with Enter, closing the dialog", () => {
		const me = session();
		const calls = source(me);
		const live = open(me);
		live.dialog.handleInput("\r");
		expect(calls.opened).toEqual([["sub_live", me]]);
		expect(live.state.closed).toBe(true);

		const done = open(me);
		expect(done.screen()).toContain("Enter to view");
		done.dialog.handleInput("\x1b[B");
		done.dialog.handleInput("\r");
		expect(calls.opened.at(-1)).toEqual(["sub_done", me]);
		expect(done.state.closed).toBe(true);
	});

	it("dismisses a finished run with x, and stops nothing", () => {
		const me = session();
		const calls = source(me);
		const { dialog, screen } = open(me);
		dialog.handleInput("\x1b[B");
		expect(screen()).toContain("x to dismiss");
		dialog.handleInput("x");
		expect(calls.dismissed).toEqual([["sub_done", me]]);
		const out = screen();
		expect(out).toContain("    Done (1)\n");
		expect(out).not.toContain("sub_done");
		expect(out).toContain("sub_live");
	});

	it("does not dismiss a run that finished under the cursor with the x meant to stop it", () => {
		const me = session();
		const dismissed: string[] = [];
		const stopped: string[] = [];
		let finished = false;
		unpublish = publishAgentTasks({
			list: () => (finished ? [] : [agentTask(me, "sub_live", "running")]),
			listDone: () => (finished ? [agentTask(me, "sub_live", "completed")] : []),
			get: () => undefined,
			close: (id) => {
				stopped.push(id);
				return { ok: false, reason: "not_found" };
			},
			closeAll: () => 0,
			dismiss: (id) => dismissed.push(id) > 0,
			open: () => Promise.resolve(),
		});
		const { dialog, screen } = open(me);
		screen();
		finished = true;
		dialog.handleInput("x");
		expect(dismissed).toEqual([]);
		expect(stopped).toEqual([]);
		dialog.handleInput("x");
		expect(dismissed).toEqual(["sub_live"]);
	});

	it("does not open straight to the only run: Enter on it opens its transcript", () => {
		const me = session();
		const calls = source(me);
		unpublish?.();
		unpublish = publishAgentTasks({
			list: () => [],
			listDone: (listOwner) => (listOwner === me ? [agentTask(me, "sub_done", "completed")] : []),
			get: () => undefined,
			close: () => ({ ok: false, reason: "not_found" }),
			closeAll: () => 0,
			open: (id, openOwner) => {
				calls.opened.push([id, String(openOwner)]);
				return Promise.resolve();
			},
		});
		const { dialog, screen } = open(me);
		expect(screen()).toContain("    Done (1)\n");
		dialog.handleInput("\r");
		expect(calls.opened).toEqual([["sub_done", me]]);
	});
});
