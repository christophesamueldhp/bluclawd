/**
 * Sandbox configuration resolution (pure, testable).
 *
 * Settings come from the merged settings.json `sandbox` section (global +
 * project, project only when trusted); CLI flags override settings:
 * --no-sandbox > --sandbox > settings.enabled > default off.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SandboxSettings } from "../_shared/settings.ts";
import { decide, type Rules, stripWrappingQuotes } from "../permissions/rules.ts";

export interface SandboxConfig extends SandboxSettings {
	enabled: boolean;
	failIfUnavailable: boolean;
	excludedCommands: string[];
	allowUnsandboxedCommands: boolean;
	autoAllowBashIfSandboxed: boolean;
	network: SandboxRuntimeConfig["network"];
	filesystem: SandboxRuntimeConfig["filesystem"];
}

/**
 * No domain is pre-allowed: the first connection to a host prompts (index.ts).
 * Writes: the working directory plus the session temp dir. Reads: everything; no
 * credential is blocked by default — which files are secret is the permission
 * layer's call, and `denyRead` / `credentials` are there to add OS-level blocks.
 */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
	enabled: false,
	failIfUnavailable: false,
	excludedCommands: [],
	allowUnsandboxedCommands: true,
	autoAllowBashIfSandboxed: true,
	network: {
		allowedDomains: [],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: [],
		allowWrite: ["."],
		denyWrite: [],
	},
};

/**
 * What the agent loads configuration and code from inside a config dir: settings,
 * hooks and MCP servers run commands, and the resource dirs hold extensions,
 * skills, agents and prompts it executes or obeys. A sandboxed command that could
 * write these could grant itself permissions. Everything else in the dir, such as
 * `worktrees/`, stays writable.
 */
const CONFIG_DIR_ENTRIES = [
	"settings.json",
	"mcp.json",
	"hooks.json",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"agents",
	"commands",
	"hooks",
	"workflows",
	"npm",
	"git",
];

export interface SandboxContext {
	cwd: string;
	agentDir: string;
	/** The session's permission rules, folded into the sandbox lists. */
	rules?: Rules;
	/** The repository's shared `.git` when `cwd` is a linked worktree. */
	gitCommonDir?: string;
}

/**
 * Writes the sandbox denies inside its writable directories, whatever the settings
 * say (no allowWrite entry lifts them). Each entry is
 * given both as a glob, which macOS applies at any depth, and as a concrete path,
 * because the Linux runtime skips glob write entries altogether. The runtime adds
 * its own set on top: shell startup files, `.gitconfig`, `.mcp.json`, `.vscode`,
 * `.idea`, and `.git/hooks` and `.git/config`.
 */
export function protectedWritePaths(context: SandboxContext): string[] {
	const { cwd, agentDir } = context;
	const paths = CONFIG_DIR_ENTRIES.flatMap((entry) => [
		`**/${CONFIG_DIR_NAME}/${entry}`,
		join(cwd, CONFIG_DIR_NAME, entry),
	]);
	paths.push(agentDir);
	// Files that would turn the working directory into a bare git repository, whose
	// config (core.fsmonitor, hooks) git would then run for anyone working here.
	paths.push(join(cwd, "HEAD"), join(cwd, "objects"), join(cwd, "refs"));
	if (!isDirectory(join(cwd, "config"))) paths.push(join(cwd, "config"));
	if (existsSync(join(cwd, "HEAD"))) paths.push(join(cwd, "hooks"));
	if (context.gitCommonDir) {
		paths.push(join(context.gitCommonDir, "hooks"), join(context.gitCommonDir, "config"));
	}
	return paths;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** A rule path in the sandbox's spelling: permission rules resolve relative paths against the working directory. */
function rulePath(path: string, cwd: string): string {
	// `//abs` is an absolute path, as the permission engine reads it.
	if (path.startsWith("//")) return path.slice(1);
	return isAbsolute(path) || path.startsWith("~") ? path : join(cwd, path);
}

/**
 * Wildcards the sandbox honours in a `WebFetch(domain:...)` rule: a leading `*.` and a
 * bare `*`. Any other wildcard still matches fetches but means nothing to the proxy.
 */
function sandboxDomain(domain: string): string | undefined {
	if (domain === "*") return domain;
	const rest = domain.startsWith("*.") ? domain.slice(2) : domain;
	return rest.includes("*") ? undefined : domain;
}

/**
 * The paths and domains added from permission rules: `Edit` allow and deny
 * rules to the write lists, `Read` deny rules to `denyRead`, `WebFetch(domain:...)`
 * allow and deny rules to the domain lists. bluclawd's `Write` verb counts as `Edit`.
 * A rule with no argument names no path and adds nothing.
 */
export function sandboxListsFromRules(rules: Rules, cwd: string) {
	const lists = {
		allowWrite: [] as string[],
		denyWrite: [] as string[],
		denyRead: [] as string[],
		allowedDomains: [] as string[],
		deniedDomains: [] as string[],
	};
	for (const kind of ["allow", "deny"] as const) {
		for (const rule of rules[kind] ?? []) {
			const m = /^(\w+)\((.+)\)$/.exec(rule.trim());
			if (!m) continue;
			const verb = m[1].toLowerCase();
			const arg = stripWrappingQuotes(m[2].trim());
			if (verb === "webfetch") {
				const domain = /^domain:\s*(.+)$/i.exec(arg)?.[1];
				const host = domain && sandboxDomain(domain.trim());
				if (host) (kind === "allow" ? lists.allowedDomains : lists.deniedDomains).push(host);
			} else if (verb === "edit" || verb === "write") {
				(kind === "allow" ? lists.allowWrite : lists.denyWrite).push(rulePath(arg, cwd));
			} else if (verb === "read" && kind === "deny") {
				lists.denyRead.push(rulePath(arg, cwd));
			}
		}
	}
	return lists;
}

/** Union preserving order, first occurrence wins. */
function union(defaults: string[] | undefined, overrides: string[] | undefined): string[] {
	return [...new Set([...(defaults ?? []), ...(overrides ?? [])])];
}

export interface SandboxFlagOverrides {
	/** --sandbox: enable regardless of settings. */
	sandbox?: boolean;
	/** --no-sandbox: disable regardless of settings; wins over --sandbox. */
	noSandbox?: boolean;
}

export function resolveSandboxConfig(
	settings: SandboxSettings | undefined,
	flags: SandboxFlagOverrides = {},
	context: SandboxContext = { cwd: process.cwd(), agentDir: getAgentDir() },
): SandboxConfig {
	const d = DEFAULT_SANDBOX_CONFIG;
	const fromRules = sandboxListsFromRules(context.rules ?? {}, context.cwd);
	const config: SandboxConfig = {
		...d,
		...settings,
		enabled: settings?.enabled ?? d.enabled,
		failIfUnavailable: settings?.failIfUnavailable ?? settings?.strict ?? d.failIfUnavailable,
		excludedCommands: union(d.excludedCommands, settings?.excludedCommands),
		allowUnsandboxedCommands: settings?.allowUnsandboxedCommands ?? d.allowUnsandboxedCommands,
		autoAllowBashIfSandboxed: settings?.autoAllowBashIfSandboxed ?? d.autoAllowBashIfSandboxed,
		network: {
			...d.network,
			...settings?.network,
			allowedDomains: union(
				union(d.network.allowedDomains, settings?.network?.allowedDomains),
				fromRules.allowedDomains,
			),
			deniedDomains: union(
				union(d.network.deniedDomains, settings?.network?.deniedDomains),
				fromRules.deniedDomains,
			),
		},
		// Lists ADD to the built-ins: a plain spread would let one pattern of your own
		// silently drop every default protection, including the protected write paths.
		filesystem: {
			...d.filesystem,
			...settings?.filesystem,
			denyWrite: union(union(d.filesystem.denyWrite, settings?.filesystem?.denyWrite), [
				...fromRules.denyWrite,
				...protectedWritePaths(context),
			]),
			denyRead: union(union(d.filesystem.denyRead, settings?.filesystem?.denyRead), fromRules.denyRead),
			allowWrite: union(
				union(d.filesystem.allowWrite, settings?.filesystem?.allowWrite),
				// A linked worktree's commits land in the repository's shared .git.
				[...fromRules.allowWrite, ...(context.gitCommonDir ? [context.gitCommonDir] : [])],
			),
		},
	};
	delete config.strict;
	if (flags.sandbox) config.enabled = true;
	if (flags.noSandbox) config.enabled = false;
	return config;
}

/**
 * A config re-read from disk mid-session, with what the session decided kept: whether
 * the sandbox is on, the /sandbox panel's mode and override (which an untrusted project
 * holds for the session only), and hosts allowed so far. Settings edits apply to the
 * lists, not to these.
 */
export function withSessionChoices(next: SandboxConfig, current: SandboxConfig): SandboxConfig {
	return {
		...next,
		enabled: current.enabled,
		autoAllowBashIfSandboxed: current.autoAllowBashIfSandboxed,
		allowUnsandboxedCommands: current.allowUnsandboxedCommands,
		network: {
			...next.network,
			allowedDomains: [...new Set([...next.network.allowedDomains, ...current.network.allowedDomains])],
		},
	};
}

/** The part of the config the runtime takes; bluclawd's own keys stay behind. */
export function runtimeConfig(config: SandboxConfig): SandboxRuntimeConfig {
	const {
		enabled: _enabled,
		failIfUnavailable: _fail,
		strict: _strict,
		excludedCommands: _excluded,
		allowUnsandboxedCommands: _unsandboxed,
		autoAllowBashIfSandboxed: _auto,
		...runtime
	} = config;
	return runtime;
}

/**
 * Does `excludedCommands` take this command out of the sandbox? Each entry is the
 * content of a `Bash(...)` rule, and a match on ANY part of a compound command
 * excludes the whole command — exactly a deny rule's reach,
 * so the deny matcher is the matcher.
 */
export function isExcludedCommand(command: string, excludedCommands: string[]): boolean {
	if (excludedCommands.length === 0) return false;
	return decide({ deny: excludedCommands.map((p) => `Bash(${p})`) }, "bash", { command }) === "deny";
}

/**
 * Why bash must refuse, or undefined when it may run.
 *
 * Under `sandbox.failIfUnavailable`, a sandbox that was asked for but did not start
 * makes bash refuse rather than run unconfined. The default stays the unsandboxed
 * fallback so a missing bubblewrap does not break sessions; `failIfUnavailable` makes
 * "enabled" and "actually confining" agree.
 */
export function strictRefusalReason(
	config: Pick<SandboxConfig, "enabled" | "failIfUnavailable">,
	active: boolean,
	lastError?: string,
): string | undefined {
	if (!config.enabled || !config.failIfUnavailable || active) return undefined;
	return `Refusing to run: sandbox.failIfUnavailable is set, the sandbox is enabled but not active${lastError ? ` (${lastError})` : ""}. Fix the sandbox, or clear sandbox.failIfUnavailable to allow unsandboxed execution.`;
}
