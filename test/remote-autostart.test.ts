import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonCommand } from "../daemon/orchestrator-client.ts";
import {
	type AutostartDeps,
	autostartDeps,
	autostartOn,
	autostartStatus,
	LABEL,
	plist,
	refreshAutostart,
	setAutostart,
	toggleAutostart,
} from "../ext/remote/autostart.ts";

describe("/remote-control autostart", () => {
	let dir: string;
	let calls: string[][];
	let loaded: boolean;
	let deps: AutostartDeps;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bluclawd-autostart-"));
		calls = [];
		loaded = false;
		deps = {
			platform: "darwin",
			dir: join(dir, "LaunchAgents"),
			uid: 501,
			// As launchctl: bootout fails for a job that is not loaded.
			launchctl: (args) => {
				calls.push(args);
				if (args[0] === "bootout" && !loaded) throw new Error("Boot-out failed: 3: No such process");
				loaded = args[0] === "bootstrap";
			},
			command: ["/usr/local/bin/node", "--import", "/x/daemon/pi-resolve-hook.mjs", "/x/daemon/cli.ts", "serve"],
			env: { PATH: "/opt/homebrew/bin:/usr/bin", PI_PACKAGE_ROOT: "/pi & <co>" },
			log: join(dir, "server", "daemon.log"),
		};
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const path = () => join(deps.dir, `${LABEL}.plist`);

	it("runs the daemon as pi starts it, once at login, with pi's PATH and state directories", () => {
		const text = plist(deps);
		expect(text).toContain(`<key>Label</key>\n\t<string>${LABEL}</string>`);
		expect(text).toContain(
			"<array>\n\t\t<string>/usr/local/bin/node</string>\n\t\t<string>--import</string>\n\t\t<string>/x/daemon/pi-resolve-hook.mjs</string>\n\t\t<string>/x/daemon/cli.ts</string>\n\t\t<string>serve</string>\n\t</array>",
		);
		expect(text).toContain("<key>PATH</key>\n\t\t<string>/opt/homebrew/bin:/usr/bin</string>");
		expect(text).toContain("<key>PI_PACKAGE_ROOT</key>\n\t\t<string>/pi &amp; &lt;co&gt;</string>");
		expect(text).toContain("<key>RunAtLoad</key>\n\t<true/>");
		expect(text).toContain("<key>KeepAlive</key>\n\t<false/>");
		expect(text).toContain(`<key>StandardOutPath</key>\n\t<string>${deps.log}</string>`);
		expect(text).toContain(`<key>StandardErrorPath</key>\n\t<string>${deps.log}</string>`);
	});

	it("is built from the command pi starts the daemon with", () => {
		vi.stubEnv("PI_SERVER_DIR", join(dir, "server"));
		vi.stubEnv("SHELL", "/bin/sh");
		const built = autostartDeps();
		expect(built.command).toEqual([
			"/bin/sh",
			"-l",
			"-c",
			'exec "$@"',
			"bluclawd-daemon",
			...daemonCommand().command,
		]);
		expect(built.command.slice(-2)).toEqual([expect.stringMatching(/daemon\/cli\.ts$/), "serve"]);
		expect(built.env.PATH).toBe(process.env.PATH);
		expect(built.env.PI_SERVER_DIR).toBe(join(dir, "server"));
		expect(built.log).toBe(join(dir, "server", "daemon.log"));
	});

	it("runs the daemon through the user's login shell, for the environment its profile sets", () => {
		const shell = join(dir, "bash");
		writeFileSync(shell, "");
		vi.stubEnv("SHELL", shell);
		expect(autostartDeps().command.slice(0, 5)).toEqual([shell, "-l", "-c", 'exec "$@"', "bluclawd-daemon"]);
		// Not a path, missing, or not a POSIX shell, which `exec "$@"` needs.
		const fish = join(dir, "fish");
		writeFileSync(fish, "");
		for (const other of ["zsh", join(dir, "missing"), fish, ""]) {
			vi.stubEnv("SHELL", other);
			expect(autostartDeps().command[0]).toBe("/bin/zsh");
		}
		// The shell hands the daemon its arguments as they are.
		vi.stubEnv("SHELL", "/bin/sh");
		const prefix = autostartDeps().command.slice(0, 5);
		const args = ["a b", "$HOME", "'q'"];
		const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
		const out = execFileSync(prefix[0], [...prefix.slice(1), process.execPath, "-e", script, ...args], {
			encoding: "utf8",
			env: { HOME: dir, PATH: "/usr/bin:/bin" },
		});
		expect(JSON.parse(out)).toEqual(args);
	});

	it("turns on by writing the plist and loading it, again when already on, and off by unloading and removing it", () => {
		setAutostart(true, deps);
		expect(readFileSync(path(), "utf8")).toBe(plist(deps));
		expect(autostartOn(deps)).toBe(true);
		// launchd does not create the log's directory.
		expect(existsSync(join(dir, "server"))).toBe(true);
		expect(calls).toEqual([
			["bootout", `gui/501/${LABEL}`],
			["bootstrap", "gui/501", path()],
		]);
		calls = [];
		setAutostart(true, deps);
		expect(calls).toEqual([
			["bootout", `gui/501/${LABEL}`],
			["bootstrap", "gui/501", path()],
		]);
		expect(readFileSync(path(), "utf8")).toBe(plist(deps));
		calls = [];
		setAutostart(false, deps);
		expect(calls).toEqual([["bootout", `gui/501/${LABEL}`]]);
		expect(existsSync(path())).toBe(false);
		expect(autostartOn(deps)).toBe(false);
		// Off again: nothing loaded, nothing to remove.
		setAutostart(false, deps);
	});

	it("rewrites an outdated plist, as after a node upgrade, for the next login, and only one that is there", () => {
		refreshAutostart(deps);
		expect(existsSync(path())).toBe(false);
		setAutostart(true, deps);
		calls = [];
		deps.command = ["/opt/homebrew/Cellar/node/25.0.0/bin/node", "/x/daemon/cli.ts", "serve"];
		deps.env = { ...deps.env, PI_SERVER_DIR: "/elsewhere" };
		refreshAutostart(deps);
		expect(readFileSync(path(), "utf8")).toBe(plist(deps));
		expect(calls).toEqual([]);
		deps.platform = "linux";
		deps.command = ["/other/node"];
		refreshAutostart(deps);
		expect(readFileSync(path(), "utf8")).not.toBe(plist(deps));
	});

	it("says it is on, or that it needs a refresh when the node or script it runs is gone", () => {
		expect(autostartStatus(deps)).toBe("Starts at login: off (turn it on from /remote-control)");
		const node = join(dir, "node & co");
		const cli = join(dir, "cli.ts");
		writeFileSync(node, "");
		writeFileSync(cli, "");
		deps.command = ["/bin/sh", "-l", "-c", 'exec "$@"', "bluclawd-daemon", node, cli, "serve"];
		setAutostart(true, deps);
		expect(autostartStatus(deps)).toBe("Starts at login: on");
		rmSync(node);
		expect(autostartStatus(deps)).toBe(
			`Starts at login: on (needs refresh: ${node} is gone; turn it off and on again from /remote-control)`,
		);
		deps.platform = "linux";
		expect(autostartStatus(deps)).toBeUndefined();
	});

	it("toggles, and says so", () => {
		expect(toggleAutostart(deps)).toContain("starts at login");
		expect(autostartOn(deps)).toBe(true);
		expect(toggleAutostart(deps)).toContain("no longer starts at login");
		expect(autostartOn(deps)).toBe(false);
	});

	it("is macOS only", () => {
		deps.platform = "linux";
		expect(toggleAutostart(deps)).toBe("Starting the daemon at login is macOS only");
		expect(calls).toEqual([]);
		expect(existsSync(deps.dir)).toBe(false);
	});
});
