import { describe, expect, it } from "vitest";
import { mergeSandboxSettings } from "../ext/_shared/settings.ts";
import { isExcludedCommand, resolveSandboxConfig, runtimeConfig } from "../ext/sandbox/config.ts";
import { formatSandboxViolations, relevantViolations } from "../ext/sandbox/failure-note.ts";

describe("Claude Code defaults", () => {
	const config = resolveSandboxConfig(undefined);

	it("pre-allows no network host: the first connection asks", () => {
		expect(config.network.allowedDomains).toEqual([]);
	});

	it("auto-allows sandboxed commands and honours the unsandboxed retry", () => {
		expect(config.autoAllowBashIfSandboxed).toBe(true);
		expect(config.allowUnsandboxedCommands).toBe(true);
		expect(config.excludedCommands).toEqual([]);
	});

	it("keeps the working directory writable when the user adds allowWrite entries", () => {
		const fs = resolveSandboxConfig({ filesystem: { allowWrite: ["~/build"] } }).filesystem;
		expect(fs.allowWrite).toContain(".");
		expect(fs.allowWrite).toContain("~/build");
	});

	it("passes runtime keys through untouched and keeps bluclawd's own back", () => {
		const rc = runtimeConfig(
			resolveSandboxConfig({
				enabled: true,
				excludedCommands: ["docker *"],
				network: { allowedDomains: ["github.com"], allowLocalBinding: true },
				filesystem: { allowRead: ["~/.ssh/known_hosts"] },
				allowAppleEvents: true,
			}),
		);
		expect(rc.network.allowLocalBinding).toBe(true);
		expect(rc.network.allowedDomains).toEqual(["github.com"]);
		expect(rc.filesystem.allowRead).toEqual(["~/.ssh/known_hosts"]);
		expect(rc.allowAppleEvents).toBe(true);
		expect(rc).not.toHaveProperty("enabled");
		expect(rc).not.toHaveProperty("excludedCommands");
		expect(rc).not.toHaveProperty("autoAllowBashIfSandboxed");
		expect(rc).not.toHaveProperty("allowUnsandboxedCommands");
		expect(rc).not.toHaveProperty("failIfUnavailable");
		expect(rc).not.toHaveProperty("strict");
	});
});

describe("excludedCommands", () => {
	const excluded = ["docker *", "pbcopy"];

	it("matches Bash(...) rule syntax: prefix patterns and exact commands", () => {
		expect(isExcludedCommand("docker compose up", excluded)).toBe(true);
		expect(isExcludedCommand("pbcopy", excluded)).toBe(true);
		expect(isExcludedCommand("dockerd", excluded)).toBe(false);
		expect(isExcludedCommand("ls", excluded)).toBe(false);
	});

	it("excludes the whole compound command when any part matches", () => {
		expect(isExcludedCommand("echo hi | pbcopy", excluded)).toBe(true);
		expect(isExcludedCommand("npm test && docker build .", excluded)).toBe(true);
	});

	it("is not fooled by a respelling of the command", () => {
		expect(isExcludedCommand("/usr/local/bin/docker ps", excluded)).toBe(true);
	});

	it("never matches with an empty list", () => {
		expect(isExcludedCommand("docker ps", [])).toBe(false);
	});
});

describe("mergeSandboxSettings", () => {
	it("combines arrays across scopes instead of replacing them", () => {
		const merged = mergeSandboxSettings(
			{ excludedCommands: ["docker *"], network: { allowedDomains: ["github.com"] } },
			{ excludedCommands: ["pbcopy"], network: { allowedDomains: ["pypi.org"], allowLocalBinding: true } },
		);
		expect(merged?.excludedCommands).toEqual(["docker *", "pbcopy"]);
		expect(merged?.network?.allowedDomains).toEqual(["github.com", "pypi.org"]);
		expect(merged?.network?.allowLocalBinding).toBe(true);
	});

	it("lets the project set scalars, except allowAppleEvents", () => {
		expect(mergeSandboxSettings({ enabled: false }, { enabled: true })?.enabled).toBe(true);
		expect(mergeSandboxSettings({}, { allowAppleEvents: true })).not.toHaveProperty("allowAppleEvents");
		expect(mergeSandboxSettings({ allowAppleEvents: false }, { allowAppleEvents: true })?.allowAppleEvents).toBe(
			false,
		);
	});

	it("is undefined when neither scope has a sandbox section", () => {
		expect(mergeSandboxSettings(undefined, undefined)).toBeUndefined();
	});
});

describe("sandbox violations", () => {
	// Real lines from the runtime's violation store on macOS.
	const lines = [
		"bash(41173) deny(1) sysctl-read kern.iossupportversion",
		"bash(41173) deny(1) file-write-create /work/.git/hooks/zz",
		"curl(41189) deny(1) mach-lookup com.apple.SystemConfiguration.configd",
		"deny network-outbound example.com:443 (host is not on the allow list)",
		"bash(41173) deny(1) file-write-create /work/.git/hooks/zz",
	];

	it("keeps only file and network denials, once each", () => {
		expect(relevantViolations(lines)).toEqual([
			"bash(41173) deny(1) file-write-create /work/.git/hooks/zz",
			"deny network-outbound example.com:443 (host is not on the allow list)",
		]);
	});

	it("formats them the way Claude Code reports them", () => {
		expect(formatSandboxViolations(["deny network-outbound example.com:443"])).toBe(
			"\n<sandbox_violations>\ndeny network-outbound example.com:443\n</sandbox_violations>",
		);
	});
});
