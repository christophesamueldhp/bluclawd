import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bashModeKeyAction } from "../ext/shell/editor.ts";
import { ShellSession } from "../ext/shell/session.ts";
import { ShellTranscript } from "../ext/shell/transcript.ts";

describe("ShellTranscript", () => {
	it("records commands with output and exit codes", () => {
		const transcript = new ShellTranscript();
		transcript.start("a", "echo hi", "/repo");
		transcript.append("a", "hi");
		transcript.finish("a", 0);
		expect(transcript.commands).toEqual([
			{ id: "a", command: "echo hi", cwdAtStart: "/repo", output: ["hi"], outputBytes: 3, exitCode: 0 },
		]);
	});

	it("drops the oldest commands past the line cap but always keeps the newest", () => {
		const transcript = new ShellTranscript({ maxLines: 3, maxBytes: 1_000_000 });
		for (const id of ["a", "b", "c"]) {
			transcript.start(id, id, "/");
			transcript.append(id, "1");
			transcript.append(id, "2");
		}
		expect(transcript.commands.map((c) => c.id)).toEqual(["c"]);
		expect(transcript.dropped).toBe(2);

		const single = new ShellTranscript({ maxLines: 1, maxBytes: 1_000_000 });
		single.start("only", "yes", "/");
		for (let i = 0; i < 5; i++) single.append("only", "y");
		expect(single.commands).toHaveLength(1);
	});
});

const shells = ["/bin/bash", "/bin/zsh"].filter((path) => existsSync(path));

describe.each(shells)("ShellSession (%s)", (shellPath) => {
	let dir: string;
	let session: ShellSession | undefined;
	let transcript: ShellTranscript;
	let finished: ReturnType<typeof vi.fn<(exitCode: number) => void>>;

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "shell-session-")));
		transcript = new ShellTranscript();
		finished = vi.fn();
	});
	afterEach(() => {
		session?.dispose();
		session = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	const open = async (cwd = dir) => {
		session = new ShellSession({ shellPath, cwd, transcript, onChange: () => {}, onCommandFinished: finished });
		await session.start();
		return session;
	};

	/** Run a command and wait until the shell reports it finished. */
	const run = async (shell: ShellSession, command: string) => {
		const before = finished.mock.calls.length;
		await shell.run(command);
		await vi.waitFor(() => expect(finished.mock.calls.length).toBe(before + 1), { timeout: 5000 });
		return transcript.commands[transcript.commands.length - 1];
	};

	it("keeps cd and exported variables between commands", async () => {
		mkdirSync(join(dir, "sub"));
		const shell = await open();
		await run(shell, "cd sub && export BLUCLAWD_PROBE=kept");
		expect(shell.state.cwd).toBe(join(dir, "sub"));
		const record = await run(shell, 'echo "$BLUCLAWD_PROBE $PWD"');
		expect(record.output).toEqual([`kept ${join(dir, "sub")}`]);
		expect(record.exitCode).toBe(0);
	});

	it("reports the exit code and output that lacks a trailing newline", async () => {
		const shell = await open();
		const record = await run(shell, "printf partial; false");
		expect(record.output).toEqual(["partial"]);
		expect(record.exitCode).toBe(1);
		expect(finished).toHaveBeenLastCalledWith(1);
		expect(shell.state.running).toBe(false);
	});

	it("tracks a working directory whose path contains colons", async () => {
		const odd = join(dir, "a:b:c");
		mkdirSync(odd);
		const shell = await open();
		await run(shell, `cd '${odd}'`);
		expect(shell.state.cwd).toBe(odd);
	});

	it("interrupts a running command and the shell keeps its state", async () => {
		const shell = await open();
		await run(shell, "export BLUCLAWD_PROBE=survives");
		await shell.run("sleep 30");
		expect(shell.state.running).toBe(true);
		// Ctrl+C comes after the command visibly runs; before the shell has started it,
		// the trap alone would absorb the signal.
		await new Promise((resolve) => setTimeout(resolve, 500));
		shell.interrupt();
		await vi.waitFor(() => expect(shell.state.running).toBe(false), { timeout: 5000 });
		expect(transcript.commands[1].exitCode).not.toBe(0);
		const record = await run(shell, 'echo "$BLUCLAWD_PROBE"');
		expect(record.output).toEqual(["survives"]);
	});

	it("refuses a second command while one runs", async () => {
		const shell = await open();
		await shell.run("sleep 30");
		await expect(shell.run("echo nope")).rejects.toThrow("already running");
	});
});

describe("bashModeKeyAction", () => {
	const keys: Record<string, string> = {
		escape: "app.interrupt",
		"ctrl+c": "app.clear",
		up: "tui.editor.cursorUp",
		down: "tui.editor.cursorDown",
		enter: "tui.input.submit",
	};
	const keybindings = { matches: (data: string, binding: string) => keys[data] === binding };

	it("maps keys only while bash mode is on", () => {
		expect(bashModeKeyAction(keybindings, "enter", { bashMode: false, running: false })).toBeUndefined();
		expect(bashModeKeyAction(keybindings, "enter", { bashMode: true, running: false })).toBe("submit");
		expect(bashModeKeyAction(keybindings, "up", { bashMode: true, running: false })).toBe("history-back");
		expect(bashModeKeyAction(keybindings, "down", { bashMode: true, running: false })).toBe("history-forward");
		expect(bashModeKeyAction(keybindings, "x", { bashMode: true, running: false })).toBeUndefined();
	});

	it("escape leaves bash mode; ctrl+c interrupts only a running command", () => {
		expect(bashModeKeyAction(keybindings, "escape", { bashMode: true, running: false })).toBe("exit");
		expect(bashModeKeyAction(keybindings, "ctrl+c", { bashMode: true, running: true })).toBe("interrupt");
		expect(bashModeKeyAction(keybindings, "ctrl+c", { bashMode: true, running: false })).toBeUndefined();
	});
});
