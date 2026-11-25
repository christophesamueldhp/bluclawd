import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { daemonCommand } from "../../daemon/orchestrator-client.ts";
import { getServerDir } from "../../daemon/paths.ts";
import { piStateDirEnv } from "../../daemon/tmux.ts";

export const LABEL = "dev.bluclawd.daemon";

export interface AutostartDeps {
	platform: NodeJS.Platform;
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
		// Through the login shell, because the private tmux server the daemon may start builds every later pane
		// from the environment it starts with, and launchd's has no LANG and none of the user's keys.
		command: [loginShell(), "-l", "-c", 'exec "$@"', "bluclawd-daemon", ...daemon.command],
		// For a profile that leaves out Homebrew's PATH, where tmux usually is; path_helper and the
		// profile put theirs first.
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...piStateDirEnv(), ...daemon.env },
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

function unxml(value: string): string {
	return value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
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

function bootoutIfLoaded(deps: AutostartDeps): void {
	try {
		deps.launchctl(["bootout", `gui/${deps.uid}/${LABEL}`]);
	} catch {}
}

export function setAutostart(on: boolean, deps: AutostartDeps): void {
	const path = plistPath(deps);
	bootoutIfLoaded(deps);
	if (!on) {
		rmSync(path, { force: true });
		return;
	}
	mkdirSync(deps.dir, { recursive: true });
	mkdirSync(dirname(deps.log), { recursive: true });
	writeFileSync(path, plist(deps));
	deps.launchctl(["bootstrap", `gui/${deps.uid}`, path]);
}

export function repointPlistForNextLogin(deps: AutostartDeps): void {
	if (deps.platform !== "darwin" || !autostartOn(deps)) return;
	const path = plistPath(deps);
	const text = plist(deps);
	if (readFileSync(path, "utf8") === text) return;
	mkdirSync(dirname(deps.log), { recursive: true });
	writeFileSync(path, text);
}

function missingFile(deps: AutostartDeps): string | undefined {
	const text = readFileSync(plistPath(deps), "utf8");
	const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
	const args = [...array.matchAll(/<string>([^<]*)<\/string>/g)].map(([, arg]) => unxml(arg));
	return args.find((arg) => isAbsolute(arg) && !existsSync(arg));
}

export function toggleAutostart(deps: AutostartDeps): string {
	if (deps.platform !== "darwin") return "Starting the daemon at login is macOS only";
	const on = !autostartOn(deps);
	setAutostart(on, deps);
	return on
		? `The agent daemon starts at login now (${plistPath(deps)}); turn it off from /remote-control`
		: "The agent daemon no longer starts at login";
}

export function autostartStatus(deps: AutostartDeps): string | undefined {
	if (deps.platform !== "darwin") return undefined;
	if (!autostartOn(deps)) return "Starts at login: off (turn it on from /remote-control)";
	const missing = missingFile(deps);
	return missing
		? `Starts at login: on (needs refresh: ${missing} is gone; turn it off and on again from /remote-control)`
		: "Starts at login: on";
}
