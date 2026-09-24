/**
 * The persistent shell behind bash mode: one long-lived shell process per
 * session, so `cd`, `export` and functions defined in one command are there for
 * the next — unlike `!`, which starts a fresh shell each time.
 *
 * Protocol: an init script defines a small eval function that sources each
 * command from a temp file between two sentinel lines carrying the command id,
 * its exit status and `$PWD`. Stdout and stderr are line-buffered separately so
 * a partial stderr line never merges into a stdout sentinel, and a sentinel is
 * found anywhere in a line, because a command whose output lacks a trailing
 * newline (`printf foo`) puts it mid-line.
 *
 * Like `!`, this runs outside the sandbox (Claude Code parity: the sandbox
 * confines what the model runs, not what the user types). The shell reads no rc
 * file, so aliases come from what the user defines in the session.
 *
 * Adapted from pi-powerline-footer's bash-mode shell session (MIT, Nico Bailon).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { stripAnsi } from "../_shared/ansi.ts";
import type { ShellTranscript } from "./transcript.ts";

const READY = "__BLUCLAWD_SHELL_READY__";
const START = "__BLUCLAWD_SHELL_START__";
const DONE = "__BLUCLAWD_SHELL_DONE__";

export interface ShellState {
	ready: boolean;
	running: boolean;
	/** e.g. `zsh`, from the shell path. */
	shellName: string;
	cwd: string;
	lastExitCode: number | null;
}

export interface ShellSessionOptions {
	shellPath: string;
	cwd: string;
	transcript: ShellTranscript;
	/** Any visible state changed (output, running, cwd). */
	onChange: () => void;
	/** A command finished, with its exit status. */
	onCommandFinished?: (exitCode: number) => void;
}

function quote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function initScript(shellName: string): string {
	if (shellName.includes("fish")) {
		return `
function __bluclawd_eval
  echo "${START}:$argv[1]:$PWD"
  source $argv[2]
  set -l __bluclawd_status $status
  rm -f $argv[2]
  echo "${DONE}:$argv[1]:$__bluclawd_status:$PWD"
end
echo "${READY}:$PWD"
`;
	}
	// bash and zsh; `builtin` keeps a user-defined `source` function out of the way.
	// The INT trap is what lets the shell survive Ctrl+C: a trapped signal is reset
	// to its default in child processes, so the running program still dies, while
	// an untrapped (or ignored) one would kill the shell (or nothing).
	return `
trap ':' INT
__bluclawd_eval() {
  printf '%s:%s:%s\\n' '${START}' "$1" "$PWD"
  builtin source "$2"
  __bluclawd_status=$?
  rm -f "$2"
  printf '%s:%s:%s:%s\\n' '${DONE}' "$1" "$__bluclawd_status" "$PWD"
}
printf '%s:%s\\n' '${READY}' "$PWD"
`;
}

/** Exit status for a shell that died mid-command, as a shell would report it. */
function closeExitCode(code: number | null, signal: NodeJS.Signals | null): number {
	if (typeof code === "number") return code;
	if (signal === "SIGINT") return 130;
	if (signal === "SIGTERM") return 143;
	if (signal === "SIGKILL") return 137;
	return 1;
}

/** Split `fields` colon-separated values off the front; the rest (a path, which may contain colons) is last. */
function splitSentinel(payload: string, fields: number): string[] {
	const parts: string[] = [];
	let rest = payload;
	for (let i = 0; i < fields; i++) {
		const at = rest.indexOf(":");
		if (at === -1) return [...parts, rest];
		parts.push(rest.slice(0, at));
		rest = rest.slice(at + 1);
	}
	return [...parts, rest];
}

export class ShellSession {
	readonly state: ShellState;
	private readonly options: ShellSessionOptions;
	private readonly tempDir = mkdtempSync(join(tmpdir(), "bluclawd-shell-"));
	private process: ChildProcessWithoutNullStreams | undefined;
	private readonly buffers = { stdout: "", stderr: "" };
	private commandCounter = 0;
	private currentId: string | undefined;
	private ready: Promise<void> | undefined;
	private resolveReady: (() => void) | undefined;
	private rejectReady: ((error: Error) => void) | undefined;
	private disposed = false;

	constructor(options: ShellSessionOptions) {
		this.options = options;
		this.state = {
			ready: false,
			running: false,
			shellName: basename(options.shellPath).toLowerCase(),
			cwd: options.cwd,
			lastExitCode: null,
		};
	}

	/** Start the shell if it is not running; resolves once it answers. */
	start(): Promise<void> {
		if (this.state.ready) return Promise.resolve();
		if (this.ready) return this.ready;
		this.ready = new Promise<void>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});

		const child = spawn(this.options.shellPath, [], {
			cwd: this.state.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
			// Own process group, so an interrupt reaches the command's children too.
			detached: true,
		});
		this.process = child;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.handleChunk("stdout", chunk));
		child.stderr.on("data", (chunk: string) => this.handleChunk("stderr", chunk));
		child.on("error", (error) => this.rejectReady?.(error));
		child.on("close", (code, signal) => this.handleClose(closeExitCode(code, signal)));
		child.stdin.write(initScript(this.state.shellName));
		return this.ready;
	}

	/** Send a command. Resolves once it is sent; completion arrives through `onCommandFinished`. */
	async run(command: string): Promise<void> {
		await this.start();
		const child = this.process;
		if (!child) throw new Error("the shell is not running");
		if (this.state.running) throw new Error("a shell command is already running");

		const id = `cmd-${++this.commandCounter}`;
		const file = join(this.tempDir, `${id}.${this.state.shellName.includes("fish") ? "fish" : "sh"}`);
		writeFileSync(file, command.endsWith("\n") ? command : `${command}\n`, "utf8");
		this.currentId = id;
		this.state.running = true;
		this.options.transcript.start(id, command, this.state.cwd);
		this.options.onChange();
		child.stdin.write(`__bluclawd_eval ${quote(id)} ${quote(file)}\n`);
	}

	/** Ctrl+C for the running command. */
	interrupt(): void {
		if (!this.process?.pid || !this.state.running) return;
		// SIGINT to the whole group stops the command and its children; the shell's
		// INT trap (see initScript) keeps the shell and its state alive.
		try {
			process.kill(-this.process.pid, "SIGINT");
		} catch {
			this.process.kill("SIGINT");
		}
	}

	dispose(): void {
		this.disposed = true;
		const pid = this.process?.pid;
		if (pid) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				this.process?.kill("SIGKILL");
			}
		}
		this.process = undefined;
		rmSync(this.tempDir, { recursive: true, force: true });
	}

	private handleChunk(stream: "stdout" | "stderr", chunk: string): void {
		const text = stripAnsi(chunk).replace(/\r/g, "");
		if (!text) return;
		const lines = (this.buffers[stream] + text).split("\n");
		this.buffers[stream] = lines.pop() ?? "";
		for (const line of lines) this.handleLine(line.trimEnd());
	}

	private handleLine(line: string): void {
		if (!this.state.ready) {
			const at = line.indexOf(`${READY}:`);
			if (at === -1) return;
			this.state.ready = true;
			this.state.cwd = line.slice(at + READY.length + 1) || this.state.cwd;
			this.resolveReady?.();
			this.options.onChange();
			return;
		}

		const doneAt = line.indexOf(`${DONE}:`);
		if (doneAt !== -1) {
			if (doneAt > 0) this.appendOutput(line.slice(0, doneAt));
			const [id, status, cwd] = splitSentinel(line.slice(doneAt + DONE.length + 1), 2);
			const exitCode = Number.parseInt(status ?? "", 10);
			this.finishCommand(id, Number.isFinite(exitCode) ? exitCode : 1, cwd);
			return;
		}

		const startAt = line.indexOf(`${START}:`);
		if (startAt !== -1) {
			if (startAt > 0) this.appendOutput(line.slice(0, startAt));
			const [, cwd] = splitSentinel(line.slice(startAt + START.length + 1), 1);
			if (cwd) this.state.cwd = cwd;
			return;
		}

		this.appendOutput(line);
	}

	private appendOutput(line: string): void {
		if (!this.currentId) return;
		this.options.transcript.append(this.currentId, line);
		this.options.onChange();
	}

	private finishCommand(id: string | undefined, exitCode: number, cwd?: string): void {
		if (cwd) this.state.cwd = cwd;
		this.state.running = false;
		this.state.lastExitCode = exitCode;
		if (id) this.options.transcript.finish(id, exitCode);
		this.currentId = undefined;
		this.options.onCommandFinished?.(exitCode);
		this.options.onChange();
	}

	private handleClose(exitCode: number): void {
		if (!this.state.ready) this.rejectReady?.(new Error(`the shell exited before it was ready (exit ${exitCode})`));
		const wasRunning = this.state.running;
		this.process = undefined;
		this.buffers.stdout = "";
		this.buffers.stderr = "";
		this.ready = undefined;
		this.state.ready = false;
		if (this.disposed) return;
		if (wasRunning) this.finishCommand(this.currentId, exitCode);
		else this.options.onChange();
	}
}
