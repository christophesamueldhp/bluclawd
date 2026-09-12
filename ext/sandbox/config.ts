/**
 * Sandbox configuration resolution (pure, testable).
 *
 * Settings come from the merged settings.json `sandbox` section (global +
 * project, project only when trusted); CLI flags override settings:
 * --no-sandbox > --sandbox > settings.enabled > default off.
 */

import { join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SandboxSettings } from "../_shared/settings.ts";
import { decide } from "../permissions/rules.ts";

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
 * Claude Code's defaults. No domain is pre-allowed: the first connection to a
 * host prompts (see the ask callback in index.ts), which is how Claude Code
 * behaves too. The write/read lists are the fork's long-standing conservative
 * set plus the agent's own credentials.
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
		// The agent's own provider credentials. The permission layer gates the
		// read tool on this file, but a bash `cat` is only stopped here.
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", join(getAgentDir(), "auth.json")],
		allowWrite: [".", "/tmp"],
		denyWrite: [
			".env",
			".env.*",
			"*.pem",
			"*.key",
			// The agent's own configuration: hooks.json and mcp.json here run shell
			// commands and spawn servers, so a bash write into this dir is a way to
			// grant yourself execution. allowWrite lists "." and the dir lives under
			// it, so without this the sandbox permits it.
			`**/${CONFIG_DIR_NAME}/**`,
			// Git hooks execute on commit. The REST of .git is deliberately writable:
			// git writes objects, refs, the index and logs constantly, and denying
			// that would break every commit the agent makes. Git only populates
			// hooks/ at init and clone.
			"**/.git/hooks/**",
		],
	},
};

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
): SandboxConfig {
	const d = DEFAULT_SANDBOX_CONFIG;
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
			allowedDomains: union(d.network.allowedDomains, settings?.network?.allowedDomains),
			deniedDomains: union(d.network.deniedDomains, settings?.network?.deniedDomains),
		},
		// Lists ADD to the built-ins, as Claude Code merges them across scopes. Plain
		// spread meant that naming a single pattern of your own silently dropped every
		// default protection — including the agent-config and git-hooks entries above,
		// which exist precisely to be hard to lose.
		filesystem: {
			...d.filesystem,
			...settings?.filesystem,
			denyWrite: union(d.filesystem.denyWrite, settings?.filesystem?.denyWrite),
			denyRead: union(d.filesystem.denyRead, settings?.filesystem?.denyRead),
			allowWrite: union(d.filesystem.allowWrite, settings?.filesystem?.allowWrite),
		},
	};
	delete config.strict;
	if (flags.sandbox) config.enabled = true;
	if (flags.noSandbox) config.enabled = false;
	return config;
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
 * excludes the whole command (Claude Code's rule) — exactly a deny rule's reach,
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
 * makes bash refuse rather than run unconfined. The default is still the unsandboxed
 * fallback, because that is what a missing bubblewrap on a Linux box has always done
 * and silently breaking those sessions would be worse than the risk. But "enabled" and
 * "actually confining anything" are different states, and a status chip is the wrong
 * place to learn which one you are in — someone who set `enabled: true` to contain a
 * command has no reason to expect it to run anyway. `failIfUnavailable` makes the two
 * states agree.
 */
export function strictRefusalReason(
	config: Pick<SandboxConfig, "enabled" | "failIfUnavailable">,
	active: boolean,
	lastError?: string,
): string | undefined {
	if (!config.enabled || !config.failIfUnavailable || active) return undefined;
	return `Refusing to run: sandbox.failIfUnavailable is set, the sandbox is enabled but not active${lastError ? ` (${lastError})` : ""}. Fix the sandbox, or clear sandbox.failIfUnavailable to allow unsandboxed execution.`;
}
