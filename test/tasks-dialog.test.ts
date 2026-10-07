import { afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../ext/_shared/ansi.ts";
import { type BackgroundExec, backgroundBashJobs } from "../ext/_shared/background-bash.ts";
import { detachableExec, runningForegroundShells } from "../ext/_shared/foreground-shells.ts";
import { TasksDialog } from "../ext/background-bash/tasks-dialog.ts";

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
});

describe("/tasks dialog (Claude Code's Background dialog)", () => {
	it("lists only running tasks, in Claude Code's words", async () => {
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
		// Claude Code's count: the last ten newline pieces, the empty one after the final newline dropped.
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
