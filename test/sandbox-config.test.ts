/**
 * The sandbox's settings and the `srt` config they make with the deny rules.
 */
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { pathRule } from "../ext/permissions/rules.ts";
import { parseSandbox, runtimeConfig, sandboxSetting } from "../ext/sandbox/config.ts";

const none = { allowedDomains: [], allowWrite: [], denyRead: [], denyWrite: [] };

describe("pathRule", () => {
	it("reads Read, Edit and Write rules with a path, any case", () => {
		expect(pathRule("Read(**/.env*)")).toEqual({ verb: "Read", path: "**/.env*" });
		expect(pathRule("edit(~/.ssh/**)")).toEqual({ verb: "Edit", path: "~/.ssh/**" });
		expect(pathRule("Write")).toEqual({ verb: "Write", path: "**" });
		expect(pathRule("Bash(rm *)")).toBeUndefined();
		expect(pathRule("mcp__github")).toBeUndefined();
	});
});

describe("parseSandbox", () => {
	it("is off when absent or not enabled", () => {
		expect(parseSandbox(undefined)).toEqual({ kind: "off" });
		expect(parseSandbox({})).toEqual({ kind: "off" });
		expect(parseSandbox({ enabled: false, network: "junk" })).toEqual({ kind: "off" });
	});

	it("is on with its lists, missing ones empty", () => {
		expect(parseSandbox({ enabled: true, network: { allowedDomains: ["github.com"] } })).toEqual({
			kind: "on",
			settings: { ...none, allowedDomains: ["github.com"] },
		});
	});

	it("names what is wrong, so a typo never switches the sandbox off", () => {
		expect(parseSandbox("yes")).toEqual({ kind: "invalid", reason: "sandbox is not an object" });
		expect(parseSandbox({ enabled: "yes" })).toEqual({
			kind: "invalid",
			reason: "sandbox.enabled is not true or false",
		});
		expect(parseSandbox({ enabled: true, filesystem: [] })).toEqual({
			kind: "invalid",
			reason: "sandbox.filesystem is not an object",
		});
		expect(parseSandbox({ enabled: true, filesystem: { denyRead: [".env", 3] } })).toEqual({
			kind: "invalid",
			reason: "sandbox.filesystem.denyRead is not a list of strings",
		});
	});
});

describe("sandboxSetting", () => {
	it("reads global settings only", () => {
		const sm = {
			getGlobalSettings: () => ({}),
			getProjectSettings: () => ({ sandbox: { enabled: true } }),
		} as unknown as SettingsManager;
		expect(sandboxSetting(sm)).toEqual({ kind: "off" });
	});
});

describe("runtimeConfig", () => {
	const cwd = "/proj";
	const home = "/home/u";
	const tmp = "/tmp/x";

	it("denies reading what Read rules deny, anchored at absolute paths", () => {
		const config = runtimeConfig(
			none,
			["Read(**/.env*)", "Read(~/.ssh/**)", "Read(//etc/hosts)", "Read(/abs/k)", "Read(secrets/**)"],
			cwd,
			home,
			tmp,
		);
		expect(config.filesystem.denyRead).toEqual([
			"/proj/**/.env*",
			"/home/u/.ssh/**",
			"/etc/hosts",
			"/abs/k",
			"/proj/secrets/**",
		]);
	});

	it("denies writing what Edit and Write rules deny, and ignores other rules", () => {
		const config = runtimeConfig(
			none,
			["Edit(.git/**)", "Write(**/.env*)", "Bash(rm *)", "WebFetch"],
			cwd,
			home,
			tmp,
		);
		expect(config.filesystem.denyWrite).toEqual(["/proj/.git/**", "/proj/**/.env*"]);
		expect(config.filesystem.denyRead).toEqual([]);
	});

	it("writes to the project and temp, plus allowWrite; adds the settings' own lists once", () => {
		const config = runtimeConfig(
			{
				allowedDomains: ["github.com"],
				allowWrite: ["~/.npm"],
				denyRead: ["~/**/.env*", "~/**/.env*"],
				denyWrite: ["/etc"],
			},
			["Read(~/**/.env*)"],
			cwd,
			home,
			tmp,
		);
		expect(config).toEqual({
			network: { allowedDomains: ["github.com"], deniedDomains: [] },
			filesystem: {
				denyRead: ["/home/u/**/.env*"],
				allowWrite: ["/proj", "/tmp/x", "/home/u/.npm"],
				denyWrite: ["/etc"],
			},
		});
	});
});
