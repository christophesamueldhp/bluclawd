/**
 * Sandbox configuration resolution (pure, testable).
 *
 * Settings come from the merged settings.json `sandbox` section (global +
 * project, project only when trusted); CLI flags override settings:
 * --no-sandbox > --sandbox > settings.enabled > default off.
 */

import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { SandboxSettings } from "../_shared/settings.ts";

export interface SandboxConfig extends SandboxSettings {
	enabled: boolean;
	strict: boolean;
}

/** Conservative defaults applied under user/project overrides (donor: examples/extensions/sandbox). */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
	enabled: false,
	strict: false,
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
		],
		deniedDomains: [],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
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
function mergeDeny(defaults: string[] | undefined, overrides: string[] | undefined): string[] {
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
	const config: SandboxConfig = {
		...DEFAULT_SANDBOX_CONFIG,
		...settings,
		enabled: settings?.enabled ?? DEFAULT_SANDBOX_CONFIG.enabled,
		strict: settings?.strict ?? DEFAULT_SANDBOX_CONFIG.strict,
		network: { ...DEFAULT_SANDBOX_CONFIG.network, ...settings?.network },
		filesystem: {
			...DEFAULT_SANDBOX_CONFIG.filesystem,
			...settings?.filesystem,
			// Deny lists ADD to the built-ins. Plain spread meant that naming a
			// single pattern of your own silently dropped every default protection
			// — including the agent-config and git-hooks entries above, which exist
			// precisely to be hard to lose. allowWrite stays a plain override: it is
			// a grant, and the user owns their workspace layout.
			denyWrite: mergeDeny(DEFAULT_SANDBOX_CONFIG.filesystem?.denyWrite, settings?.filesystem?.denyWrite),
			denyRead: mergeDeny(DEFAULT_SANDBOX_CONFIG.filesystem?.denyRead, settings?.filesystem?.denyRead),
		},
	};
	if (flags.sandbox) config.enabled = true;
	if (flags.noSandbox) config.enabled = false;
	return config;
}

/**
 * Why bash must refuse, or undefined when it may run.
 *
 * Under `sandbox.strict`, a sandbox that was asked for but did not start makes bash
 * refuse rather than run unconfined. The default is still the unsandboxed fallback,
 * because that is what a missing bubblewrap on a Linux box has always done and silently
 * breaking those sessions would be worse than the risk. But "enabled" and "actually
 * confining anything" are different states, and a status chip is the wrong place to
 * learn which one you are in — someone who set `enabled: true` to contain a command has
 * no reason to expect it to run anyway. `strict` makes the two states agree.
 */
export function strictRefusalReason(
	config: Pick<SandboxConfig, "enabled" | "strict">,
	active: boolean,
	lastError?: string,
): string | undefined {
	if (!config.enabled || !config.strict || active) return undefined;
	return `Refusing to run: sandbox.strict is set, the sandbox is enabled but not active${lastError ? ` (${lastError})` : ""}. Fix the sandbox, or clear sandbox.strict to allow unsandboxed execution.`;
}
