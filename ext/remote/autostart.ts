/**
 * `/remote-control autostart`: a macOS LaunchAgent that starts the daemon at login, as pi starts
 * it, so the phone reaches the Mac before any pi runs. launchd only starts it (no KeepAlive): pi
 * still replaces a daemon from older code with one of its own, which launchd leaves alone.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { getServerDir } from "../../daemon/paths.ts";
import { daemonCommand } from "../agent-view/orchestrator-client.ts";
import { piEnv } from "../agent-view/tmux.ts";

export const LABEL = "dev.bluclawd.daemon";

export interface AutostartDeps {
	platform: NodeJS.Platform;
	/** ~/Library/LaunchAgents */
	dir: string;
	uid: number;
	launchctl(args: string[]): void;
	command: string[];
	env: Record<string, string>;
	log: string;
}

/** The user's login shell; `exec "$@"` needs a POSIX one. */
function loginShell(): string {
	const shell = process.env.SHELL;
	const posix = shell && isAbsolute(shell) && existsSync(shell) && /^(ba|z|k|da)?sh$/.test(basename(shell));
	return posix ? shell : "/bin/zsh";
}

export function autostartDeps(): AutostartDeps {
	const daemon = daemonCommand();
	return {
		platform: process.platform,
		dir: join(homedir(), "Library", "LaunchAgents"),
		uid: process.getuid?.() ?? 0,
		launchctl: (args) => {
			execFileSync("launchctl", args, { stdio: "pipe" });
		},
		// Through the login shell: the private tmux server the daemon may start builds every later pane
		// from the environment it starts with, and launchd's has no LANG and none of the user's keys.
		command: [loginShell(), "-l", "-c", 'exec "$@"', "bluclawd-daemon", ...daemon.command],
		// For a profile that leaves out Homebrew's PATH, where tmux usually is; path_helper and the
		// profile put theirs first.
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...piEnv(), ...daemon.env },
		log: join(getServerDir(), "daemon.log"),
	};
}

function xml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export function plist({ command, env, log }: Pick<AutostartDeps, "command" | "env" | "log">): string {
	const args = command.map((arg) => `\t\t<string>${xml(arg)}</string>`).join("\n");
	const vars = Object.entries(env)
		.map(([key, value]) => `\t\t<key>${xml(key)}</key>\n\t\t<string>${xml(value)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${args}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${vars}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<false/>
	<key>StandardOutPath</key>
	<string>${xml(log)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(log)}</string>
</dict>
</plist>
`;
}

function plistPath(deps: AutostartDeps): string {
	return join(deps.dir, `${LABEL}.plist`);
}

export function autostartOn(deps: AutostartDeps): boolean {
	return existsSync(plistPath(deps));
}

/** Loading it starts the daemon at once; one already running stays, and the new one exits. */
export function setAutostart(on: boolean, deps: AutostartDeps): void {
	const path = plistPath(deps);
	try {
		deps.launchctl(["bootout", `gui/${deps.uid}/${LABEL}`]);
	} catch {
		// not loaded
	}
	if (!on) {
		rmSync(path, { force: true });
		return;
	}
	mkdirSync(deps.dir, { recursive: true });
	writeFileSync(path, plist(deps));
	deps.launchctl(["bootstrap", `gui/${deps.uid}`, path]);
}

export function toggleAutostart(deps: AutostartDeps): string {
	if (deps.platform !== "darwin") return "Starting the daemon at login is macOS only";
	const on = !autostartOn(deps);
	setAutostart(on, deps);
	return on
		? `The agent daemon starts at login now (${plistPath(deps)}); /remote-control autostart turns it off`
		: "The agent daemon no longer starts at login";
}

/** For /remote-control's own output; undefined where there is no autostart. */
export function autostartStatus(deps: AutostartDeps): string | undefined {
	if (deps.platform !== "darwin") return undefined;
	return autostartOn(deps) ? "Starts at login: on" : "Starts at login: off (/remote-control autostart turns it on)";
}
