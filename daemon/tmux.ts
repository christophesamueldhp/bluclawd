import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { ensureOwnerOnlyServerDir, getServerDir } from "./paths.ts";

export const PANE_ENV = "BLUCLAWD_PANE";
export const FOREGROUND_PANE_ENV = "BLUCLAWD_NORMAL";
export const OPEN_VIEW_ENV = "BLUCLAWD_OPEN_VIEW";
export const HIDDEN_ROW_ENV = "BLUCLAWD_HIDE";
export const PARENT_ENV = "BLUCLAWD_PARENT";
export const runParent = (): string | undefined => process.env[PARENT_ENV] || undefined;
export const RUN_TASK_ENV = "BLUCLAWD_RUN_TASK";
export const RUN_DIR_ENV = "BLUCLAWD_RUN_DIR";
export const RUN_PANE_ENV = "BLUCLAWD_RUN_PANE";
export const RUN_HOST_ENV = "BLUCLAWD_RUN_HOST_PID";
export const AGENT_VIEW_COMMAND = "agent-view";
export const OUTER_TMUX_ENV = "BLUCLAWD_OUTER_TMUX";

function startingTerminalWasUnderTmux(): boolean | undefined {
	if (!process.env[PANE_ENV]) return undefined;
	const outer = process.env[OUTER_TMUX_ENV];
	return outer === "1" ? true : outer === "0" ? false : undefined;
}

export function underTmuxPrefix(): boolean {
	return startingTerminalWasUnderTmux() ?? Boolean(process.env.TMUX);
}

export const outerTmuxEnv = (): Record<string, string> => ({ [OUTER_TMUX_ENV]: underTmuxPrefix() ? "1" : "0" });

// `-q` on extended-keys-format, because tmux 3.3 and 3.4 have no such option, and a config error opens view mode
// over the first pane a terminal attaches to, which then takes its keys. 3.4 sends CSI u anyway.
const CONFIG = `set -g prefix None
set -g prefix2 None
unbind-key -a
set -g status off
set -g escape-time 0
set -g extended-keys always
set -gq extended-keys-format csi-u
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

export function piCommand(): string[] {
	return [process.execPath, ...process.execArgv, process.argv[1]];
}

export function piStateDirEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && /^PI_\w*(DIR|ROOT)$/.test(key)) env[key] = value;
	}
	return env;
}

export interface ShellInfo {
	name: string;
	command: string;
	cwd: string;
	createdAt: string;
	exit?: string;
	stopped: boolean;
	lastLine?: string;
}

const SHELL_PREFIX = "sh-";
const SHELL_COMMAND_ENV = "BLUCLAWD_SHELL_COMMAND";
const SHELL_WRAPPER = `"\${SHELL:-/bin/sh}" -c "$${SHELL_COMMAND_ENV}"; tmux set-option -q @bluclawd_exit "$?"; while :; do sleep 3600; done`;

export interface PaneSpec {
	cwd: string;
	args: string[];
	env?: Record<string, string>;
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

const endingMark = (dir: string, name: string) => join(dir, "ending", name);

export function takeEndedAsQuit(name: string, dir: string = getServerDir()): boolean {
	try {
		rmSync(endingMark(dir, name));
		return true;
	} catch {
		return false;
	}
}

export function endPane(tmux: Pick<Tmux, "hangUpAsQuit">, name: string): boolean {
	try {
		tmux.hangUpAsQuit(name);
		return true;
	} catch {
		return false;
	}
}

function killUnlessExited(pid: number): boolean {
	try {
		process.kill(pid, "SIGKILL");
		return true;
	} catch {
		return false;
	}
}

export class Tmux {
	readonly dir: string;
	private readonly run: Run;
	private readonly runAsync: (args: string[]) => Promise<string>;
	private readonly timeoutMs: number | undefined;
	private configured = false;

	constructor(dir: string = getServerDir(), run?: Run, options: { timeoutMs?: number } = {}) {
		this.dir = dir;
		this.run = run ?? ((args, options) => this.exec(args, options));
		this.runAsync = run ? async (args) => run(args) : (args) => this.execAsync(args);
		this.timeoutMs = options.timeoutMs;
	}

	get socket(): string {
		return join(this.dir, "tmux.sock");
	}

	static available(): boolean {
		return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
	}

	static gone(error: unknown): boolean {
		// stderr, not the message, which also holds the command's arguments, such as text typed.
		const stderr = (error as { stderr?: unknown } | undefined)?.stderr;
		return (
			typeof stderr === "string" &&
			/can't find (session|window|pane)|no server running|error connecting to .* \(No such file or directory\)/.test(
				stderr,
			)
		);
	}

	static reason(error: unknown): string {
		const stderr = (error as { stderr?: unknown } | undefined)?.stderr;
		const said = typeof stderr === "string" ? stderr.trim().split("\n").at(-1)?.trim() : undefined;
		return said || (error instanceof Error ? error.message : String(error));
	}

	static currentPane(): string | undefined {
		return process.env[PANE_ENV] || undefined;
	}

	newSession(spec: PaneSpec): string {
		const name = `pi-${randomUUID().slice(0, 8)}`;
		const env = { ...piStateDirEnv(), ...spec.env, [PANE_ENV]: name };
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
			if (!this.sessionMadeAnyway(name)) throw error;
		}
		return name;
	}

	private sessionMadeAnyway(name: string): boolean {
		try {
			this.run(["has-session", "-t", `=${name}`]);
			return true;
		} catch {
			return false;
		}
	}

	startRunHost(name: string, cwd: string, command: string[]): number {
		try {
			this.run([
				"new-session",
				"-d",
				"-s",
				name,
				"-c",
				cwd,
				...Object.entries(piStateDirEnv()).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
				...command.map(literalArg),
			]);
		} catch (error) {
			if (!this.hasSession(name)) throw error;
		}
		const pid = Number(this.display(name, "#{pane_pid}").trim());
		if (!(pid > 1)) throw new Error(`couldn't find the host running in ${name}`);
		return pid;
	}

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

	listShells(): ShellInfo[] {
		let out: string;
		try {
			out = this.run(LIST_SHELLS);
		} catch {
			return [];
		}
		return parseShells(out).map((shell) => ({ ...shell, lastLine: this.lastLineUnlessEnded(shell.name) }));
	}

	private lastLineUnlessEnded(name: string): string | undefined {
		try {
			return this.capture(name, 50).at(-1);
		} catch {
			return undefined;
		}
	}

	async listShellsAsync(): Promise<ShellInfo[]> {
		let out: string;
		try {
			out = await this.runAsync(LIST_SHELLS);
		} catch {
			return [];
		}
		return Promise.all(
			parseShells(out).map(async (shell) => ({
				...shell,
				lastLine: await this.captureAsync(shell.name, 50).then(
					(lines) => lines.at(-1),
					() => undefined,
				),
			})),
		);
	}

	stopShell(name: string): void {
		this.run(["set-option", "-t", `=${name}:`, "@bluclawd_stopped", "1"]);
		const pid = Number(this.display(name, "#{pane_pid}").trim());
		if (!(pid > 1)) throw new Error(`couldn't find the shell running in ${name}`);
		// Snapshot before killing parents, or their children are reparented and lost.
		const processes = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
			.trim()
			.split("\n")
			.map((line) => line.trim().split(/\s+/).map(Number));
		const tree = [pid];
		for (let i = 0; i < tree.length; i++) {
			for (const [child, parent] of processes) if (parent === tree[i]) tree.push(child);
		}
		const descendantsOfWrapper = tree.slice(1);
		for (const child of descendantsOfWrapper.reverse()) {
			try {
				process.kill(child, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
	}

	capture(name: string, lines: number): string[] {
		return screenLines(this.run(["capture-pane", "-p", "-t", `=${name}:`, "-S", `-${lines}`]));
	}

	async captureAsync(name: string, lines: number): Promise<string[]> {
		return screenLines(await this.runAsync(["capture-pane", "-p", "-t", `=${name}:`, "-S", `-${lines}`]));
	}

	sendKeys(name: string, keys: string[]): void {
		this.run(["send-keys", "-t", `=${name}:`, ...keys]);
	}

	attach(name: string): void {
		this.run(["attach-session", "-t", `=${name}`], { inherit: true, outsideTmux: true });
	}

	switchTo(name: string): void {
		this.run(["switch-client", "-t", `=${name}`]);
	}

	markViewReady(name: string): void {
		this.run(["set-option", "-t", `=${name}:`, "@bluclawd_view_ready", "1"]);
	}

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

	viewReady(name: string): boolean {
		return this.display(name, "#{@bluclawd_view_ready}").trim() === "1";
	}

	hasSession(name: string): boolean {
		try {
			this.run(["has-session", "-t", `=${name}`]);
			return true;
		} catch (error) {
			if (Tmux.gone(error)) return false;
			throw error;
		}
	}

	async hasSessionAsync(name: string): Promise<boolean> {
		try {
			await this.runAsync(["has-session", "-t", `=${name}`]);
			return true;
		} catch (error) {
			if (Tmux.gone(error)) return false;
			throw error;
		}
	}

	attached(): boolean {
		try {
			return this.run(["list-clients", "-F", "#{client_name}"]).trim() !== "";
		} catch {
			return false;
		}
	}

	async attachedAsync(): Promise<boolean> {
		try {
			return (await this.runAsync(["list-clients", "-F", "#{client_name}"])).trim() !== "";
		} catch {
			return false;
		}
	}

	shown(name: string): boolean {
		return this.clientsOf(name).length > 0;
	}

	moveClients(from: string, to: string): void {
		for (const client of this.clientsOf(from)) this.run(["switch-client", "-c", client, "-t", `=${to}`]);
	}

	private clientsOf(name: string): string[] {
		return this.run(["list-clients", "-t", `=${name}`, "-F", "#{client_name}"])
			.split("\n")
			.filter(Boolean);
	}

	detach(): void {
		this.run(["detach-client"]);
	}

	endOnDetach(name: string, on: boolean): void {
		this.run(
			on
				? ["set-hook", "-t", `=${name}:`, "client-detached", `kill-session -t =${name}`]
				: ["set-hook", "-u", "-t", `=${name}:`, "client-detached"],
		);
	}

	hangUpAsQuit(name: string): void {
		const mark = endingMark(this.dir, name);
		this.markQuitElseCrash(mark);
		try {
			this.run(["kill-session", "-t", `=${name}`]);
		} catch (error) {
			rmSync(mark, { force: true });
			throw error;
		}
	}

	private markQuitElseCrash(mark: string): boolean {
		try {
			mkdirSync(join(this.dir, "ending"), { recursive: true });
			writeFileSync(mark, "");
			return true;
		} catch {
			return false;
		}
	}

	killWithoutSave(name: string): void {
		let pid: number;
		try {
			pid = Number(this.display(name, "#{pane_pid}").trim());
		} catch (error) {
			if (Tmux.gone(error)) return;
			throw new Error(`couldn't end ${name} — ${Tmux.reason(error)}`);
		}
		if (!(pid > 0)) throw new Error(`couldn't find the pi running in ${name}`);
		killUnlessExited(pid);
		this.killSessionUnlessEndedWithItsProcess(name);
	}

	private killSessionUnlessEndedWithItsProcess(name: string): boolean {
		try {
			this.run(["kill-session", "-t", `=${name}`]);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * For a session that is not there, tmux prints nothing
	 * and succeeds; that is thrown as tmux's "can't find session", which `Tmux.gone` matches.
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
			ensureOwnerOnlyServerDir(this.dir);
			writeFileSync(config, CONFIG);
			this.configured = true;
		}
		const env = { ...process.env };
		// Attaching from inside another tmux is refused unless TMUX is unset.
		if (outsideTmux) delete env.TMUX;
		return { argv: ["-S", this.socket, "-f", config, ...args], env };
	}
}
