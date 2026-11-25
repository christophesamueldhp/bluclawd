import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FilesystemPathEntry, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { defaultServerDir, getServerDir } from "../../daemon/paths.ts";
import { resolveDenyRulePath } from "../_shared/deny-rule-path.ts";
import { pathRule } from "../permissions/rules.ts";

export const SANDBOX_SETTINGS_CHANGED = "bluclawd:sandbox-settings-changed";

export interface SandboxSettings {
	allowedDomains: string[];
	allowWrite: string[];
	denyRead: string[];
	denyWrite: string[];
	denyUnixSockets: string[];
	credentialFiles: unknown[];
	written: Record<string, unknown>;
}

export type SandboxSetting =
	| { kind: "off" }
	| { kind: "on"; settings: SandboxSettings }
	| { kind: "invalid"; reason: string };

export interface UncheckedRuntimeConfig {
	network: { allowedDomains: string[]; [key: string]: unknown };
	filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: FilesystemPathEntry[]; [key: string]: unknown };
	[key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown, name: string): string[] | string {
	if (value === undefined) return [];
	return Array.isArray(value) && value.every((v) => typeof v === "string")
		? value
		: `${name} is not a list of strings`;
}

export function saveSandboxEnabled(enabled: boolean): void {
	const dir = getAgentDir();
	const path = join(dir, "settings.json");
	let settings: unknown;
	try {
		settings = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error("Global settings could not be read or parsed; fix settings.json first");
		}
		settings = {};
	}
	if (!isPlainObject(settings)) throw new Error("Global settings must be an object");
	if (settings.sandbox !== undefined && !isPlainObject(settings.sandbox)) {
		throw new Error("sandbox is not an object; fix global settings first");
	}
	settings.sandbox = { ...(settings.sandbox as Record<string, unknown> | undefined), enabled };
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export function globalSandboxSetting(sm: SettingsManager): SandboxSetting {
	return parseSandbox((sm.getGlobalSettings() as Record<string, unknown>).sandbox);
}

export function parseSandbox(value: unknown): SandboxSetting {
	if (value === undefined) return { kind: "off" };
	if (!isPlainObject(value)) return { kind: "invalid", reason: "sandbox is not an object" };
	if (value.enabled === false) return { kind: "off" };
	if (value.enabled !== undefined && value.enabled !== true) {
		return { kind: "invalid", reason: "sandbox.enabled is not true or false" };
	}
	const network = value.network ?? {};
	const filesystem = value.filesystem ?? {};
	const credentials = value.credentials ?? {};
	if (!isPlainObject(network)) return { kind: "invalid", reason: "sandbox.network is not an object" };
	if (!isPlainObject(filesystem)) return { kind: "invalid", reason: "sandbox.filesystem is not an object" };
	if (!isPlainObject(credentials)) return { kind: "invalid", reason: "sandbox.credentials is not an object" };
	const credentialFiles = credentials.files === undefined ? [] : credentials.files;
	if (!Array.isArray(credentialFiles)) return { kind: "invalid", reason: "sandbox.credentials.files is not a list" };
	const lists = {
		allowedDomains: strings(network.allowedDomains, "sandbox.network.allowedDomains"),
		allowWrite: strings(filesystem.allowWrite, "sandbox.filesystem.allowWrite"),
		denyRead: strings(filesystem.denyRead, "sandbox.filesystem.denyRead"),
		denyWrite: strings(filesystem.denyWrite, "sandbox.filesystem.denyWrite"),
		denyUnixSockets: strings(network.denyUnixSockets, "sandbox.network.denyUnixSockets"),
	};
	for (const list of Object.values(lists)) {
		if (typeof list === "string") return { kind: "invalid", reason: list };
	}
	const { enabled, ...written } = value;
	return enabled === true
		? {
				kind: "on",
				settings: { ...(lists as Omit<SandboxSettings, "credentialFiles" | "written">), credentialFiles, written },
			}
		: { kind: "off" };
}

/**
 * A settings path as the sandbox takes it, absolute because `srt` on Linux skips a
 * pattern whose first component is a wildcard.
 */
export function sandboxPath(written: string, cwd: string, home: string): string {
	// `srt` refuses a deny glob ending in a separator, since as a pattern it can match no path.
	const path = written.replace(/(.)\/+$/, "$1");
	if (path.startsWith("//")) return path.slice(1);
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return isAbsolute(path) ? path : join(cwd, path);
}

export const PROTECTED_PROJECT_PATHS = [
	".pi",
	".agents",
	".git/hooks",
	".git/config",
	".vscode",
	".idea",
	".claude",
	".mcp.json",
] as const;

export function protectedProjectWritePaths(cwd: string, home: string, globalAllowWrite: readonly string[]): string[] {
	const released = new Set(globalAllowWrite.map((path) => resolve(sandboxPath(path, cwd, home))));
	return PROTECTED_PROJECT_PATHS.map((path) => resolve(cwd, path)).filter((path) => !released.has(path));
}

const MAX_LINKS = 40;

function realPathOfExistingPrefix(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		return parent === path ? path : join(realPathOfExistingPrefix(parent), basename(path));
	}
}

export function ownAndDefaultServerDirs(): string[] {
	return [...new Set([getServerDir(), defaultServerDir()].map((dir) => realPathOfExistingPrefix(resolve(dir))))];
}

function firstLink(path: string): string | undefined {
	const names = path.split(sep).filter(Boolean);
	for (let i = 1; i <= names.length; i++) {
		const prefix = sep + names.slice(0, i).join(sep);
		try {
			if (lstatSync(prefix).isSymbolicLink()) return prefix;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function withFirstLinkFollowed(path: string): string | undefined {
	const link = firstLink(path);
	if (link === undefined) return undefined;
	try {
		return join(resolve(dirname(link), readlinkSync(link)), relative(link, path));
	} catch {
		return undefined;
	}
}

/** Every spelling a path takes on the way to its real path, one symlink followed at a time. */
function linkSpellings(path: string): string[] {
	const found = [path];
	for (let next = withFirstLinkFollowed(path); next !== undefined && found.length <= MAX_LINKS; ) {
		found.push(next);
		next = withFirstLinkFollowed(next);
	}
	return [...new Set([...found, realPathOfExistingPrefix(path)])];
}

/**
 * pi's agent directory: its settings, extensions and bluclawd's reaper helper, which runs unsandboxed. Each
 * spelling, since a command that may write where a symlink on the way lives could swap the link instead.
 */
export function agentDirs(): string[] {
	return linkSpellings(resolve(getAgentDir()));
}

export function agentCredentialPaths(agentDir = getAgentDir()): string[] {
	return [resolve(agentDir, "auth.json"), resolve(agentDir, "bluclawd", "accounts.json")];
}

/**
 * The symlinks on the way to `spellings` that lie where a command may write. srt on Linux binds a deny path by its real
 * path, so a command there could swap such a link for a directory of its own.
 */
export function swappableLinks(spellings: string[], allowWrite: string[]): string[] {
	const writable = allowWrite.map((path) => realPathOfExistingPrefix(resolve(path)));
	const isWritable = (path: string) =>
		writable.some((dir) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep));
	const links = new Set(spellings.map(firstLink).filter((link) => link !== undefined));
	return [...links].filter((link) => isWritable(realPathOfExistingPrefix(dirname(link))));
}

export function runtimeConfig(
	settings: SandboxSettings,
	denyRules: string[],
	cwd: string,
	home: string,
	tmp: string,
	ownServerDirs: string[],
	ownAgentDirs: string[],
): UncheckedRuntimeConfig {
	const ruled = (verbs: string[]) =>
		denyRules.flatMap((rule) => {
			const parsed = pathRule(rule);
			return parsed && verbs.includes(parsed.verb) ? [resolveDenyRulePath(parsed.path, cwd, home)] : [];
		});
	const paths = (list: string[], rulePaths: string[] = []) => [
		...new Set([...rulePaths, ...list.map((path) => sandboxPath(path, cwd, home))]),
	];
	const { network, filesystem, credentials, ...rest } = settings.written;
	const credentialDenies = new Set([...ownServerDirs, ...ownAgentDirs.flatMap(agentCredentialPaths)]);
	return {
		...rest,
		// Credential denies take precedence over `allowRead`.
		credentials: {
			...(credentials as object),
			files: [...settings.credentialFiles, ...Array.from(credentialDenies, (path) => ({ path, mode: "deny" }))],
		},
		network: {
			deniedDomains: [],
			...(network as object),
			allowedDomains: [...settings.allowedDomains],
			// After the user's own entries, so no setting drops it; srt denies these over every Unix-socket allow (macOS).
			denyUnixSockets: [...new Set([...settings.denyUnixSockets, ...ownServerDirs])],
		},
		filesystem: {
			...(filesystem as object),
			denyRead: paths(settings.denyRead, ruled(["Read"])),
			allowWrite: paths([cwd, tmp, ...settings.allowWrite]),
			denyWrite: [
				...paths([...settings.denyWrite, ...ownAgentDirs], ruled(["Edit", "Write"])),
				...protectedProjectWritePaths(cwd, home, settings.allowWrite).map((path) => ({
					path,
					literal: true as const,
				})),
			],
		},
	};
}

function droppedKeys(given: unknown, kept: unknown, path: string): string[] {
	if (Array.isArray(given) && Array.isArray(kept)) {
		return given.flatMap((value, i) => droppedKeys(value, kept[i], `${path}.${i}`));
	}
	if (!isPlainObject(given) || !isPlainObject(kept)) return [];
	return Object.entries(given).flatMap(([key, value]) =>
		key in kept ? droppedKeys(value, kept[key], `${path}.${key}`) : [`${path}.${key}`],
	);
}

/**
 * `srt` checks only a config it reads
 * from a file, and its schema drops a key it does not know, which would leave a misspelled
 * protection off.
 */
export async function checkRuntimeConfig(config: UncheckedRuntimeConfig): Promise<SandboxRuntimeConfig | string> {
	const { SandboxRuntimeConfigSchema } = await import("@anthropic-ai/sandbox-runtime");
	const result = SandboxRuntimeConfigSchema.safeParse(config);
	if (!result.success) {
		return result.error.issues.map((issue) => `${["sandbox", ...issue.path].join(".")}: ${issue.message}`).join("; ");
	}
	const dropped = droppedKeys(config, result.data, "sandbox");
	return dropped.length > 0 ? `${dropped.join(", ")} is not a sandbox setting` : result.data;
}
