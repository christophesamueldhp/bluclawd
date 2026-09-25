import { afterEach, describe, expect, it } from "vitest";
import { stripAnsi } from "../ext/_shared/ansi.ts";
import { type BackgroundExec, backgroundBashJobs } from "../ext/_shared/background-bash.ts";
import { TasksDialog } from "../ext/background-bash/tasks-dialog.ts";

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

/** Runs until it is stopped. */
const forever: BackgroundExec = (_c, _w, { signal }) =>
	new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
const tick = () => new Promise((r) => setTimeout(r, 0));

let owner = 0;
function session() {
	return `dialog-test-${++owner}`;
}

function open(sessionOwner: string) {
	const state = { closed: false, notes: [] as string[] };
	const dialog = new TasksDialog(
		theme,
		sessionOwner,
		() => {
			state.closed = true;
		},
		() => {},
		{ notify: (m) => state.notes.push(m) },
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
		expect(out).toContain(" Background\n 2 active shells\n");
		expect(out).toContain("❯ tail -f log (running)");
		expect(out).toContain("  npm run dev (running)");
		expect(out).not.toContain("true");
		// No header for Shells when nothing else is listed.
		expect(out).not.toContain("Shells");
		expect(out).toContain(" ↑/↓ to select · Enter to view · x to stop · Esc to close");
	});

	it("says so when nothing runs", () => {
		expect(open(session()).screen()).toContain(" No tasks currently running");
	});

	it("opens straight to the only task, and closes when it is left", () => {
		const me = session();
		backgroundBashJobs.start({ command: "npm run dev", cwd: "/", owner: me, exec: forever });
		const { dialog, state, screen } = open(me);
		const out = screen();
		expect(out).toContain(" Shell details");
		expect(out).toContain(" Status: running");
		expect(out).toContain(" Command: npm run dev");
		expect(out).toContain(" ← to go back · Esc/Enter/Space to close · x to stop");
		// Twelve rows of box: ten lines between the borders.
		expect(out.split("\n").filter((l) => l.startsWith(" │")).length).toBe(10);
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
		expect(screen()).toContain(" Command: a-cmd");
		backgroundBashJobs.kill(a.id);
		await tick();
		const out = screen();
		expect(out).toContain(" Background");
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
		expect(out).toContain("  Monitors (1)");
		expect(out).toContain("❯ deploys (running)");
		expect(out).toContain(" ↑/↓ to select · x to stop · Esc to close");
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
		expect(out).toContain("child-cmd (running)");
		expect(out).toContain("mine (running)");
	});
});
