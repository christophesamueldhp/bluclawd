/**
 * Agent view's pane mode: every session is an interactive pi in a private tmux server, so each
 * row is a full pi session, all of them run at once, and opening one is a `switch-client` that
 * never waits on or interrupts anything. The terminal you ran `pi` in is only a tmux client.
 *
 * The server lives next to the daemon's socket, so `PI_SERVER_DIR` isolates it too. Its config
 * turns tmux into a transparent host: no prefix key, no status line, keys passed through.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getServerDir } from "../../daemon/paths.ts";

/** Set in a pane's environment: the tmux session its pi runs in. */
export const PANE_ENV = "BLUCLAWD_PANE";
/** Set on a pane started to carry on a turn that was in progress. */
export const CONTINUE_ENV = "BLUCLAWD_CONTINUE";
/** Set on a pane that should open agent view once it starts. */
export const OPEN_VIEW_ENV = "BLUCLAWD_OPEN_VIEW";

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
function piEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && /^PI_\w*(DIR|ROOT)$/.test(key)) env[key] = value;
	}
	return env;
}

export interface PaneSpec {
	cwd: string;
	args: string[];
	/** Extra environment for the pane, on top of the `PI_*` variables passed through. */
	env?: Record<string, string>;
	/** The pi to run, from {@link piCommand}; this process's own by default. */
	command?: string[];
}

type Run = (args: string[], options?: { inherit?: boolean; outsideTmux?: boolean }) => string;

export class Tmux {
	readonly dir: string;
	private readonly run: Run;

	constructor(dir: string = getServerDir(), run?: Run) {
		this.dir = dir;
		this.run = run ?? ((args, options) => this.exec(args, options));
	}

	get socket(): string {
		return join(this.dir, "tmux.sock");
	}

	/** Whether tmux is installed: agent view needs it. */
	static available(): boolean {
		return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
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
		this.run([
			"new-session",
			"-d",
			"-s",
			name,
			"-c",
			spec.cwd,
			...(size ? ["-x", String(size.columns), "-y", String(size.rows)] : []),
			...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
			...(spec.command ?? piCommand()),
			...spec.args,
		]);
		return name;
	}

	/** Attach this terminal to `name`; returns when the client detaches or the server ends. */
	attach(name: string): void {
		this.run(["attach-session", "-t", `=${name}`], { inherit: true, outsideTmux: true });
	}

	/** Show `name` in the terminal this pane is shown in. */
	switchTo(name: string): void {
		this.run(["switch-client", "-t", `=${name}`]);
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

	/**
	 * End a pane's pi at once. SIGKILL, not tmux's SIGHUP: a hung-up pi treats it as quitting
	 * and would carry the session on in a new pane.
	 */
	kill(name: string): void {
		let pid: number;
		try {
			pid = Number(this.run(["display-message", "-p", "-t", `=${name}:`, "#{pane_pid}"]).trim());
		} catch {
			return; // already gone
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

	private exec(args: string[], options: { inherit?: boolean; outsideTmux?: boolean } = {}): string {
		mkdirSync(this.dir, { recursive: true });
		const config = join(this.dir, "tmux.conf");
		writeFileSync(config, CONFIG);
		const env = { ...process.env };
		// Attaching from inside another tmux is refused unless TMUX is unset.
		if (options.outsideTmux) delete env.TMUX;
		const argv = ["-S", this.socket, "-f", config, ...args];
		if (options.inherit) {
			spawnSync("tmux", argv, { stdio: "inherit", env });
			return "";
		}
		return execFileSync("tmux", argv, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
	}
}
