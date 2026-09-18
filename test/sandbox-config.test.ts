import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { mergeSandboxSettings, resolveSandboxPath, resolveSandboxPaths } from "../ext/_shared/settings.ts";
import {
	isExcludedCommand,
	protectedWritePaths,
	resolveSandboxConfig,
	runtimeConfig,
	sandboxListsFromRules,
	withSessionChoices,
} from "../ext/sandbox/config.ts";
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

	it("writes only the working directory; the runtime adds its own $TMPDIR", () => {
		expect(config.filesystem.allowWrite).toEqual(["."]);
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

	it("ignores the keys Claude Code honours from user settings only, in project settings", () => {
		const widening = {
			allowAppleEvents: true,
			bwrapPath: "./bin/bwrap",
			socatPath: "./bin/socat",
			filesystem: { disabled: true },
			network: { strictAllowlist: true, tlsTerminate: {} },
			credentials: {
				allowPlaintextInject: true,
				files: [
					{ path: "/p/token", mode: "mask" as const },
					{ path: "/p/secret", mode: "deny" as const },
				],
				envVars: [
					{ name: "GH_TOKEN", mode: "mask" as const },
					{ name: "NPM_TOKEN", mode: "deny" as const },
				],
			},
		};
		const fromProject = mergeSandboxSettings(undefined, widening);
		expect(fromProject?.allowAppleEvents).toBeUndefined();
		expect(fromProject?.bwrapPath).toBeUndefined();
		expect(fromProject?.socatPath).toBeUndefined();
		expect(fromProject?.filesystem?.disabled).toBeUndefined();
		expect(fromProject?.network?.strictAllowlist).toBeUndefined();
		expect(fromProject?.network?.tlsTerminate).toBeUndefined();
		expect(fromProject?.credentials?.allowPlaintextInject).toBeUndefined();
		// A deny entry only narrows, so a project may add one.
		expect(fromProject?.credentials?.files).toEqual([{ path: "/p/secret", mode: "deny" }]);
		expect(fromProject?.credentials?.envVars).toEqual([{ name: "NPM_TOKEN", mode: "deny" }]);

		const fromUser = mergeSandboxSettings(widening, undefined);
		expect(fromUser?.filesystem?.disabled).toBe(true);
		expect(fromUser?.network?.strictAllowlist).toBe(true);
		expect(fromUser?.credentials?.files).toHaveLength(2);
	});

	it("is undefined when neither scope has a sandbox section", () => {
		expect(mergeSandboxSettings(undefined, undefined)).toBeUndefined();
	});
});

describe("sandbox path prefixes", () => {
	it("resolves by prefix: absolute, //absolute, home, and relative to the scope's base", () => {
		expect(resolveSandboxPath("/tmp/build", "/proj")).toBe("/tmp/build");
		expect(resolveSandboxPath("//tmp/build", "/proj")).toBe("/tmp/build");
		expect(resolveSandboxPath("~/.kube", "/proj")).toBe("~/.kube");
		expect(resolveSandboxPath("./output", "/proj")).toBe("/proj/output");
		expect(resolveSandboxPath("output", "/proj")).toBe("/proj/output");
	});

	it("applies to all four filesystem lists and credential files", () => {
		const out = resolveSandboxPaths(
			{
				filesystem: { allowWrite: ["out"], denyWrite: ["./gen"], denyRead: ["~/"], allowRead: ["."] },
				credentials: { files: [{ path: "token", mode: "deny" }] },
			},
			"/home/me/.pi/agent",
		);
		expect(out.filesystem).toEqual({
			allowWrite: ["/home/me/.pi/agent/out"],
			denyWrite: ["/home/me/.pi/agent/gen"],
			denyRead: ["~/"],
			allowRead: ["/home/me/.pi/agent"],
		});
		expect(out.credentials?.files?.[0].path).toBe("/home/me/.pi/agent/token");
	});
});

describe("permission rules in the sandbox", () => {
	it("adds Edit/Write allow and deny, Read deny, and WebFetch domains", () => {
		const lists = sandboxListsFromRules(
			{
				allow: [
					"Edit(build/**)",
					"Write(~/.kube/**)",
					"Read(docs/**)",
					"WebFetch(domain:*.npmjs.org)",
					"Bash(npm *)",
				],
				deny: ["Edit(/etc/**)", "Read(~/.netrc)", "WebFetch(domain:evil.com)"],
			},
			"/proj",
		);
		expect(lists.allowWrite).toEqual(["/proj/build/**", "~/.kube/**"]);
		expect(lists.denyWrite).toEqual(["/etc/**"]);
		expect(lists.denyRead).toEqual(["~/.netrc"]);
		expect(lists.allowedDomains).toEqual(["*.npmjs.org"]);
		expect(lists.deniedDomains).toEqual(["evil.com"]);
	});

	it("keeps only the wildcards the proxy understands, and ignores argument-less rules", () => {
		const lists = sandboxListsFromRules(
			{ allow: ["WebFetch(domain:*)", "WebFetch(domain:example.*)", "Edit", "WebFetch"] },
			"/proj",
		);
		expect(lists.allowedDomains).toEqual(["*"]);
		expect(lists.allowWrite).toEqual([]);
	});

	it("reaches the resolved config", () => {
		const config = resolveSandboxConfig(
			undefined,
			{},
			{
				cwd: "/proj",
				agentDir: "/home/me/.pi/agent",
				rules: { allow: ["WebFetch(domain:github.com)", "Edit(out/**)"], deny: ["Read(secrets/**)"] },
			},
		);
		expect(config.network.allowedDomains).toEqual(["github.com"]);
		expect(config.filesystem.allowWrite).toEqual([".", "/proj/out/**"]);
		expect(config.filesystem.denyRead).toContain("/proj/secrets/**");
	});
});

describe("protected paths", () => {
	const context = { cwd: "/proj", agentDir: "/home/me/.pi/agent" };
	const paths = protectedWritePaths(context);

	it("denies the config the agent loads, as a glob and as a concrete path", () => {
		for (const entry of ["settings.json", "mcp.json", "hooks.json", "extensions", "skills", "agents"]) {
			expect(paths).toContain(`**/${CONFIG_DIR_NAME}/${entry}`);
			expect(paths).toContain(`/proj/${CONFIG_DIR_NAME}/${entry}`);
		}
		expect(paths).toContain("/home/me/.pi/agent");
	});

	it("leaves the config dir's working data writable: subagent worktrees live there", () => {
		expect(paths.some((p) => p.includes("worktrees"))).toBe(false);
		expect(paths).not.toContain(`**/${CONFIG_DIR_NAME}/**`);
		expect(resolveSandboxConfig(undefined, {}, context).filesystem.denyWrite).not.toContain(
			`**/${CONFIG_DIR_NAME}/**`,
		);
	});

	it("cannot be lifted by an allowWrite entry: they are in the deny list", () => {
		const config = resolveSandboxConfig({ filesystem: { allowWrite: [`/proj/${CONFIG_DIR_NAME}`] } }, {}, context);
		expect(config.filesystem.denyWrite).toContain(`/proj/${CONFIG_DIR_NAME}/settings.json`);
	});

	it("blocks turning the working directory into a bare repository", () => {
		expect(paths).toEqual(expect.arrayContaining(["/proj/HEAD", "/proj/objects", "/proj/refs", "/proj/config"]));
		expect(paths).not.toContain("/proj/hooks");
		const repo = mkdtempSync(join(tmpdir(), "sbx-bare-"));
		writeFileSync(join(repo, "HEAD"), "ref: refs/heads/main\n");
		mkdirSync(join(repo, "config"));
		const bare = protectedWritePaths({ cwd: repo, agentDir: "/a" });
		expect(bare).toContain(join(repo, "hooks"));
		// A project's own config/ directory is left alone.
		expect(bare).not.toContain(join(repo, "config"));
	});

	it("opens a linked worktree's shared .git, but not its hooks or config", () => {
		const config = resolveSandboxConfig(undefined, {}, { ...context, gitCommonDir: "/repo/.git" });
		expect(config.filesystem.allowWrite).toContain("/repo/.git");
		expect(config.filesystem.denyWrite).toEqual(expect.arrayContaining(["/repo/.git/hooks", "/repo/.git/config"]));
	});
});

describe("settings edits mid-session", () => {
	it("apply to the lists but keep the session's own choices", () => {
		const current = resolveSandboxConfig({ enabled: true, network: { allowedDomains: ["example.com"] } });
		// Chosen in the /sandbox panel of an untrusted project: nothing on disk says so.
		current.autoAllowBashIfSandboxed = false;
		current.allowUnsandboxedCommands = false;
		const onDisk = resolveSandboxConfig({ filesystem: { denyWrite: ["/proj/blocked"] } });
		const next = withSessionChoices(onDisk, current);
		expect(next.filesystem.denyWrite).toContain("/proj/blocked");
		expect(next.enabled).toBe(true);
		expect(next.autoAllowBashIfSandboxed).toBe(false);
		expect(next.allowUnsandboxedCommands).toBe(false);
		expect(next.network.allowedDomains).toContain("example.com");
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
