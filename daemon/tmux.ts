/**
 * Agent view's pane mode: every session is an interactive pi in a private tmux server, so each
 * row is a full pi session, all of them run at once, and opening one is a `switch-client` that
 * never waits on or interrupts anything. The terminal you ran `pi` in is only a tmux client.
 *
 * The server lives next to the daemon's socket, so `PI_SERVER_DIR` isolates it too. Its config
 * turns tmux into a transparent host: no prefix key, no status line, keys passed through.
 */

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureServerDir, getServerDir } from "./paths.ts";

/** Set in a pane's environment: the tmux session its pi runs in. */
export const PANE_ENV = "BLUCLAWD_PANE";
/** Set on the pane `pi` starts in a terminal: a normal session, as bluclawd's, until ← backgrounds it. */
export const NORMAL_ENV = "BLUCLAWD_NORMAL";
/** Set on a pane started only to show agent view, which it opens with {@link AGENT_VIEW_COMMAND}. */
export const OPEN_VIEW_ENV = "BLUCLAWD_OPEN_VIEW";
/** Set with {@link OPEN_VIEW_ENV}: the row of the session being deleted, which that view leaves out. */
export const HIDE_ENV = "BLUCLAWD_HIDE";
/** Set on a run's pane: the tmux session of the orchestrator that launched it (ADR-0006). */
export const PARENT_ENV = "BLUCLAWD_PARENT";
/** Set with {@link PARENT_ENV} on a run's first start: the file holding its task, its first prompt. */
export const RUN_TASK_ENV = "BLUCLAWD_RUN_TASK";
/** The command ←← dispatches; not meant to be typed. */
export const AGENT_VIEW_COMMAND = "agent-view";

const CONFIG = `set -g prefix None
set -g prefix2 None
unbind-key -a
set -g status off
set -g escape-time 0
set -g extended-keys always
set -g extended-keys-format csi-u
set -g default-terminal tmux-256color
set -as terminal-features ',*:RGB:extkeys:hyperlinks:sync:clipboard:title'
set -g allow-passthrough on
set -g set-clipboard on
set -g set-titles on
set -g set-titles-string '#T'
set -g focus-events on
set -g mouse off
set -g window-size latest
set -g aggressive-resize on
set -g history-limit 10000
`;

/** How this pi was started, without its arguments: a pane runs the same pi. */
export function piCommand(): string[] {
	return [process.execPath, ...process.execArgv, process.argv[1]];
}

/**
 * Where this pi keeps its state, which a pane must share. The server's environment (that of the
 * pi that started it) covers the rest; nothing secret goes on tmux's command line.
 */
export function piEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && /^PI_\w*(DIR|ROOT)$/.test(key)) env[key] = value;
	}
	return env;
}

/** A `!` command agent view started, as its tmux session reports it. */
export interface ShellInfo {
	/** Its tmux session. */
	name: string;
	command: string;
	cwd: string;
	createdAt: string;
	/** Its exit status, once it has ended. */
	exit?: string;
	/** Ended by ctrl+x. */
	stopped: boolean;
	lastLine?: string;
}

const SHELL_PREFIX = "sh-";
const SHELL_COMMAND_ENV = "BLUCLAWD_SHELL_COMMAND";
/** Runs the command in the user's shell, puts its exit status on the session, and keeps the pane
 *  (and its output) until the row is deleted. A command is never run again. */
const SHELL_WRAPPER = `"\${SHELL:-/bin/sh}" -c "$${SHELL_COMMAND_ENV}"; tmux set-option -q @bluclawd_exit "$?"; while :; do sleep 3600; done`;

export interface PaneSpec {
	cwd: string;
	args: string[];
	/** Extra environment for the pane, on top of the `PI_*` variables passed through. */
	env?: Record<string, string>;
	/** The pi to run, from {@link piCommand}; this process's own by default. */
	command?: string[];
}

/** tmux reads an argument ending in `;` as a command separator; `\;` there is a literal `;`. */
function literalArg(arg: string): string {
	return arg.endsWith(";") ? `${arg.slice(0, -1)}\\;` : arg;
}

function screenLines(out: string): string[] {
	const lines = out.split("\n");
	while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
	return lines.map((line) => line.trimEnd());
}

type Run = (args: string[], options?: { inherit?: boolean; outsideTmux?: boolean }) => string;

const execFileAsync = promisify(execFile);

const LIST_SHELLS = [
	"list-sessions",
	"-F",
	"#{session_name}\t#{session_created}\t#{@bluclawd_exit}\t#{@bluclawd_stopped}\t#{@bluclawd_cwd}\t#{@bluclawd_command}",
];

/** The `!` commands in `list-sessions` output, without their last line. */
function parseShells(out: string): Omit<ShellInfo, "lastLine">[] {
	const shells: Omit<ShellInfo, "lastLine">[] = [];
	for (const line of out.split("\n")) {
		const [name, created, exit, stopped, cwd, ...command] = line.split("\t");
		if (!name?.startsWith(SHELL_PREFIX)) continue;
		shells.push({
			name,
			command: command.join("\t"),
			cwd: cwd ?? "",
			createdAt: new Date(Number(created) * 1000).toISOString(),
			exit: exit || undefined,
			stopped: stopped === "1",
		});
	}
	return shells;
}

/** Ends session `name`, as a hang-up; one already gone, or that tmux cannot reach now, is left as it is. */
export function endPane(tmux: Pick<Tmux, "end">, name: string): void {
	try {
		tmux.end(name);
	} catch {
		// Its pi has quit already, or tmux did not answer.
	}
}

export class Tmux {
	readonly dir: string;
	private readonly run: Run;
	private readonly runAsync: (args: string[]) => Promise<string>;
	private readonly timeoutMs: number | undefined;
	/** tmux.conf is written by this instance's first command, not by each: the daemon runs several a second. */
	private configured = false;

	/** `timeoutMs`: give up on a command (attach aside) after this long, so a hung one cannot hold
	 *  up the daemon. Not for agent view: a killed client's new-session may still start the pane. */
	constructor(dir: string = getServerDir(), run?: Run, options: { timeoutMs?: number } = {}) {
		this.dir = dir;
		this.run = run ?? ((args, options) => this.exec(args, options));
		this.runAsync = run ? async (args) => run(args) : (args) => this.execAsync(args);
		this.timeoutMs = options.timeoutMs;
	}

	get socket(): string {
		return join(this.dir, "tmux.sock");
	}

	/** Whether tmux is installed: agent view needs it. */
	static available(): boolean {
		return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
	}

	/** Whether a command failed because its session, or the whole server, is not there. */
	static gone(error: unknown): boolean {
		// stderr, not the message: that also holds the command's arguments, such as text typed.
		const stderr = (error as { stderr?: unknown } | undefined)?.stderr;
		return (
			typeof stderr === "string" &&
			/can't find (session|window|pane)|no server running|error connecting to .* \(No such file or directory\)/.test(
				stderr,
			)
		);
	}

	/** A failure in tmux's own words: the message also holds the whole command line. */
	static reason(error: unknown): string {
		const stderr = (error as { stderr?: unknown } | undefined)?.stderr;
		const said = typeof stderr === "string" ? stderr.trim().split("\n").at(-1)?.trim() : undefined;
		return said || (error instanceof Error ? error.message : String(error));
	}

	/** The tmux session this process runs in, when it is a pane's pi. */
	static currentPane(): string | undefined {
		return process.env[PANE_ENV] || undefined;
	}

	/** Start a pane running pi; returns its tmux session name. */
	newSession(spec: PaneSpec): string {
		const name = `pi-${randomUUID().slice(0, 8)}`;
		const env = { ...piEnv(), ...spec.env, [PANE_ENV]: name };
		const size = process.stdout.columns && process.stdout.rows ? process.stdout : undefined;
		try {
			this.run([
				"new-session",
				"-d",
				"-s",
				name,
				"-c",
				spec.cwd,
				...(size ? ["-x", String(size.columns), "-y", String(size.rows)] : []),
				...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
				...(spec.command ?? piCommand()).map(literalArg),
				...spec.args.map(literalArg),
			]);
		} catch (error) {
			// A client killed by the timeout may still have had its session made; that pane runs.
			try {
				this.run(["has-session", "-t", `=${name}`]);
			} catch {
				throw error;
			}
		}
		return name;
	}

	/** Start a `!` command in a session of its own; returns the session's name. */
	startShell(cwd: string, command: string): string {
		const name = `${SHELL_PREFIX}${randomUUID().slice(0, 8)}`;
		const size = process.stdout.columns && process.stdout.rows ? process.stdout : undefined;
		this.run([
			"new-session",
			"-d",
			"-s",
			name,
			"-c",
			cwd,
			...(size ? ["-x", String(size.columns), "-y", String(size.rows)] : []),
			"-e",
			`${SHELL_COMMAND_ENV}=${command}`,
			"/bin/sh",
			"-c",
			SHELL_WRAPPER,
		]);
		this.run(["set-option", "-t", `=${name}:`, "@bluclawd_command", command]);
		this.run(["set-option", "-t", `=${name}:`, "@bluclawd_cwd", cwd]);
		return name;
	}

	/** The `!` commands this server runs or ran, each with its last line of output. */
	listShells(): ShellInfo[] {
		let out: string;
		try {
			out = this.run(LIST_SHELLS);
		} catch {
			return []; // no server yet
		}
		return parseShells(out).map((shell) => {
			let lastLine: string | undefined;
			try {
				lastLine = this.capture(shell.name, 50).at(-1);
			} catch {
				// it ended meanwhile
			}
			return { ...shell, lastLine };
		});
	}

	/** {@link listShells} without blocking: tmux runs off the main thread, the captures at once. */
	async listShellsAsync(): Promise<ShellInfo[]> {
		let out: string;
		try {
			out = await this.runAsync(LIST_SHELLS);
		} catch {
			return []; // no server yet
		}
		return Promise.all(
			parseShells(out).map(async (shell) => ({
				...shell,
				// undefined: it ended meanwhile
				lastLine: await this.captureAsync(shell.name, 50).then(
					(lines) => lines.at(-1),
					() => undefined,
				),
			})),
		);
	}

	/** Stop a running `!` command; its row stays, stopped. */
	stopShell(name: string): void {
		this.run(["set-option", "-t", `=${name}:`, "@bluclawd_stopped", "1"]);
		const pid = Number(this.display(name, "#{pane_pid}").trim());
		if (!(pid > 1)) throw new Error(`couldn't find the shell running in ${name}`);
		// Snapshot before killing parents: otherwise their children are reparented and lost.
		const processes = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
			.trim()
			.split("\n")
			.map((line) => line.trim().split(/\s+/).map(Number));
		const tree = [pid];
		for (let i = 0; i < tree.length; i++) {
			for (const [child, parent] of processes) if (parent === tree[i]) tree.push(child);
		}
		// Leave the wrapper alive to record the exit and retain the output pane.
		for (const child of tree.slice(1).reverse()) {
			try {
				process.kill(child, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
	}

	/** The last `lines` lines of a session's output, trailing blank lines dropped. */
	capture(name: string, lines: number): string[] {
		return screenLines(this.run(["capture-pane", "-p", "-t", `=${name}:`, "-S", `-${lines}`]));
	}

	/** {@link capture} without blocking. */
	async captureAsync(name: string, lines: number): Promise<string[]> {
		return screenLines(await this.runAsync(["capture-pane", "-p", "-t", `=${name}:`, "-S", `-${lines}`]));
	}

	/** Press keys in a session's pane, by tmux key name (`Up`, `Enter`, …). */
	sendKeys(name: string, keys: string[]): void {
		this.run(["send-keys", "-t", `=${name}:`, ...keys]);
	}

	/** Attach this terminal to `name`; returns when the client detaches or the server ends. */
	attach(name: string): void {
		this.run(["attach-session", "-t", `=${name}`], { inherit: true, outsideTmux: true });
	}

	/** Show `name` in the terminal this pane is shown in. */
	switchTo(name: string): void {
		this.run(["switch-client", "-t", `=${name}`]);
	}

	/** Mark `name`'s agent view as drawn: a terminal waiting to move there can switch now. */
	markViewReady(name: string): void {
		this.run(["set-option", "-t", `=${name}:`, "@bluclawd_view_ready", "1"]);
	}

	/** Whether a run in `name` was last opened from agent view, so its ← goes back there rather than to
	 *  its orchestrator. */
	setOpenedFromView(name: string, fromView: boolean): void {
		this.run([
			"set-option",
			...(fromView ? [] : ["-u"]),
			"-t",
			`=${name}:`,
			"@bluclawd_back",
			...(fromView ? ["view"] : []),
		]);
	}

	openedFromView(name: string): boolean {
		return this.display(name, "#{@bluclawd_back}").trim() === "view";
	}

	/** Whether `name`'s agent view has drawn; throws once the session is gone. */
	viewReady(name: string): boolean {
		return this.display(name, "#{@bluclawd_view_ready}").trim() === "1";
	}

	/** Whether session `name` is still there; throws when tmux could not say. */
	hasSession(name: string): boolean {
		try {
			this.run(["has-session", "-t", `=${name}`]);
			return true;
		} catch (error) {
			if (Tmux.gone(error)) return false;
			throw error;
		}
	}

	/** Whether a terminal shows one of this server's sessions; no server, none does. */
	attached(): boolean {
		try {
			return this.run(["list-clients", "-F", "#{client_name}"]).trim() !== "";
		} catch {
			return false;
		}
	}

	/** Leave tmux: the terminal returns to its shell, every pane keeps running. */
	detach(): void {
		this.run(["detach-client"]);
	}

	/** While `on`, `name` ends when the terminal showing it detaches or closes. */
	endOnDetach(name: string, on: boolean): void {
		this.run(
			on
				? ["set-hook", "-t", `=${name}:`, "client-detached", `kill-session -t =${name}`]
				: ["set-hook", "-u", "-t", `=${name}:`, "client-detached"],
		);
	}

	/** End a pane's pi as quitting does: tmux hangs it up, and it saves its session as a stopped row. */
	end(name: string): void {
		this.run(["kill-session", "-t", `=${name}`]);
	}

	/**
	 * End a pane's pi at once, leaving nothing behind. SIGKILL, not tmux's SIGHUP: a hung-up pi
	 * saves its session as a stopped row, which deleting it must not leave.
	 */
	kill(name: string): void {
		let pid: number;
		try {
			pid = Number(this.display(name, "#{pane_pid}").trim());
		} catch (error) {
			if (Tmux.gone(error)) return;
			// Taken for gone, its pi would beat on and bring back the row deleted after this.
			throw new Error(`couldn't end ${name} — ${Tmux.reason(error)}`);
		}
		// Without the pid, ending the session would hang its pi up instead.
		if (!(pid > 0)) throw new Error(`couldn't find the pi running in ${name}`);
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// it exited meanwhile
		}
		try {
			this.run(["kill-session", "-t", `=${name}`]);
		} catch {
			// the session ended with its process
		}
	}

	/**
	 * `format` expanded for session `name`. For a session that is not there, tmux prints nothing
	 * and succeeds; that is thrown as tmux's "can't find session", which `Tmux.gone` knows.
	 */
	private display(name: string, format: string): string {
		const out = this.run(["display-message", "-p", "-t", `=${name}:`, `#{session_id} ${format}`]);
		const space = out.indexOf(" ");
		if (!out.startsWith("$") || space < 0) {
			const stderr = `can't find session: ${name}\n`;
			throw Object.assign(new Error(stderr.trim()), { stderr });
		}
		return out.slice(space + 1);
	}

	private exec(args: string[], options: { inherit?: boolean; outsideTmux?: boolean } = {}): string {
		const { argv, env } = this.prepare(args, options.outsideTmux);
		if (options.inherit) {
			spawnSync("tmux", argv, { stdio: "inherit", env });
			return "";
		}
		return execFileSync("tmux", argv, {
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: this.timeoutMs,
		});
	}

	private async execAsync(args: string[]): Promise<string> {
		const { argv, env } = this.prepare(args);
		return (await execFileAsync("tmux", argv, { encoding: "utf8", env, timeout: this.timeoutMs })).stdout;
	}

	private prepare(args: string[], outsideTmux?: boolean): { argv: string[]; env: NodeJS.ProcessEnv } {
		const config = join(this.dir, "tmux.conf");
		if (!this.configured) {
			ensureServerDir(this.dir);
			writeFileSync(config, CONFIG);
			this.configured = true;
		}
		const env = { ...process.env };
		// Attaching from inside another tmux is refused unless TMUX is unset.
		if (outsideTmux) delete env.TMUX;
		return { argv: ["-S", this.socket, "-f", config, ...args], env };
	}
}
