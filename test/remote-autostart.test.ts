import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonCommand } from "../ext/agent-view/orchestrator-client.ts";
import {
	type AutostartDeps,
	autostartDeps,
	autostartOn,
	LABEL,
	plist,
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
		const built = autostartDeps();
		expect(built.command).toEqual(daemonCommand().command);
		expect(built.command.slice(-2)).toEqual([expect.stringMatching(/daemon\/cli\.ts$/), "serve"]);
		expect(built.env.PATH).toBe(process.env.PATH);
		expect(built.env.PI_SERVER_DIR).toBe(join(dir, "server"));
		expect(built.log).toBe(join(dir, "server", "daemon.log"));
	});

	it("turns on by writing the plist and loading it, again when already on, and off by unloading and removing it", () => {
		setAutostart(true, deps);
		expect(readFileSync(path(), "utf8")).toBe(plist(deps));
		expect(autostartOn(deps)).toBe(true);
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
