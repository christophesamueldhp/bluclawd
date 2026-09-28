/**
 * Settings keys bluclawd adds on top of pi's, and the readers for them.
 *
 * pi's `Settings` type is not exported and has no getters for these keys, so
 * every reader goes through an untyped `Record<string, unknown>` cast.
 * `SettingsManager` already returns empty project settings for an untrusted
 * project, so a reader here never sees an untrusted project's values.
 */
import { join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Sandbox settings. Everything the runtime understands passes straight through
 * (typed against its own config so a renamed key is a compile error here); the
 * keys below are added on top.
 */
export interface SandboxSettings extends Partial<Omit<SandboxRuntimeConfig, "network" | "filesystem">> {
	enabled?: boolean; // default: false — sandboxing is opt-in
	/** Refuse to run bash at all when the sandbox is enabled but failed to start.
	 *  default: false — falls back to running unsandboxed. */
	failIfUnavailable?: boolean;
	/** Former name of failIfUnavailable; still honoured. */
	strict?: boolean;
	/** `Bash(...)` rule patterns (`docker *`) that always run outside the sandbox. */
	excludedCommands?: string[];
	/** Honour the bash tool's `dangerouslyDisableSandbox` retry. default: true */
	allowUnsandboxedCommands?: boolean;
	/** Run sandboxed commands without a permission prompt. default: true */
	autoAllowBashIfSandboxed?: boolean;
	network?: Partial<SandboxRuntimeConfig["network"]>;
	filesystem?: Partial<SandboxRuntimeConfig["filesystem"]>;
}

export interface PermissionSettings {
	/** Mode the session starts in. Read from GLOBAL settings only — a project must not name it. */
	defaultMode?: "ask" | "edits" | "auto" | "default" | "acceptEdits" | "always" | "bypass";
	allow?: string[];
	ask?: string[];
	deny?: string[];
}

export interface WebsearchSettings {
	provider?: "exa" | "brave" | "tavily";
	apiKeyEnv?: string;
	keyless?: boolean;
}

/**
 * Limits and models for the `agent` tool's in-process subagents.
 * CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH and
 * CLAUDE_CODE_SUBAGENT_MODEL override these when set.
 */
export interface SubagentSettings {
	/** Subagents running at once, across the session. default: 20 */
	maxConcurrent?: number;
	/** Layers below the main session that may still spawn: 1 = children cannot delegate. default: 3 */
	maxDepth?: number;
	/** The model when neither the call nor the definition names one. default: the parent's */
	model?: string;
	/** Short model names `model` may use, e.g. `{ "sonnet": "opencode-go/kimi-k2" }`.
	 *  Provider-neutral on purpose: nothing here names a vendor unless the user does. */
	models?: Record<string, string>;
}

type Mergeable = Record<string, unknown>;

function isPlainObject(value: unknown): value is Mergeable {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Global + project, project winning, objects merged one level deep — pi's own precedence. */
function merged(sm: SettingsManager): Mergeable {
	const base = sm.getGlobalSettings() as unknown as Mergeable;
	const overrides = sm.getProjectSettings() as unknown as Mergeable;
	const out: Mergeable = { ...base };
	for (const key of Object.keys(overrides)) {
		const override = overrides[key];
		if (override === undefined) continue;
		const existing = out[key];
		out[key] = isPlainObject(existing) && isPlainObject(override) ? { ...existing, ...override } : override;
	}
	return out;
}

export function fastModel(sm: SettingsManager): string | undefined {
	const value = merged(sm).fastModel;
	return typeof value === "string" ? value : undefined;
}

/** "Reduce motion": no mascot animation. */
export function prefersReducedMotion(sm: SettingsManager): boolean {
	return merged(sm).prefersReducedMotion === true;
}

/**
 * The merged `sandbox` settings. Relative filesystem paths resolve per scope:
 * against the project root in project settings, against the agent dir in user
 * settings. Without `dirs` they are left as written, for readers that only want a flag.
 */
export function sandbox(sm: SettingsManager, dirs?: { project: string; agent: string }): SandboxSettings | undefined {
	const global = (sm.getGlobalSettings() as unknown as Mergeable).sandbox as SandboxSettings | undefined;
	const project = (sm.getProjectSettings() as unknown as Mergeable).sandbox as SandboxSettings | undefined;
	return mergeSandboxSettings(
		global && dirs ? resolveSandboxPaths(global, dirs.agent) : global,
		project && dirs ? resolveSandboxPaths(project, dirs.project) : project,
	);
}

/**
 * Sandbox path prefixes: `/` and `//` are absolute, `~` is home,
 * anything else (`./out`, `out`, `**\/.env`) is relative to `base`.
 */
export function resolveSandboxPath(path: string, base: string): string {
	if (path.startsWith("//")) return path.slice(1);
	if (path.startsWith("/") || path.startsWith("~")) return path;
	return join(base, path);
}

export function resolveSandboxPaths(settings: SandboxSettings, base: string): SandboxSettings {
	const out = structuredClone(settings);
	const fs = out.filesystem;
	if (fs) {
		for (const key of ["allowWrite", "denyWrite", "denyRead", "allowRead"] as const) {
			const list = fs[key];
			if (Array.isArray(list)) fs[key] = list.map((p) => resolveSandboxPath(p, base));
		}
	}
	for (const file of out.credentials?.files ?? []) {
		if (typeof file.path === "string") file.path = resolveSandboxPath(file.path, base);
	}
	return out;
}

/**
 * Keys honoured from user settings only: each widens what a
 * sandboxed command can do (run apps, write anywhere, send a real credential somewhere,
 * swap the sandbox binary), so a checked-out repository must not be able to set it.
 */
function withoutUserOnlyKeys(project: SandboxSettings): SandboxSettings {
	const out = structuredClone(project);
	delete out.allowAppleEvents;
	delete out.ripgrep;
	// Binaries the runtime spawns: a repository must not name its own.
	delete out.bwrapPath;
	delete out.socatPath;
	if (out.filesystem) delete out.filesystem.disabled;
	if (out.network) {
		delete out.network.strictAllowlist;
		delete out.network.tlsTerminate;
	}
	const creds = out.credentials;
	if (creds) {
		delete creds.allowPlaintextInject;
		delete creds.awsPairs;
		delete creds.sigv4;
		// A `deny` entry only narrows access, so any scope may add one; a `mask` entry
		// authorizes the proxy to send the real value out.
		if (creds.files) creds.files = creds.files.filter((entry) => entry.mode !== "mask");
		if (creds.envVars) creds.envVars = creds.envVars.filter((entry) => entry.mode !== "mask");
	}
	return out;
}

/**
 * Scope merge for `sandbox`: arrays combine across scopes rather
 * than one replacing the other, objects merge at any depth, scalars take the
 * project's value — except the user-only keys above, which a project cannot set.
 */
export function mergeSandboxSettings(
	global: SandboxSettings | undefined,
	project: SandboxSettings | undefined,
): SandboxSettings | undefined {
	if (!global && !project) return undefined;
	return deepMerge(
		structuredClone(global ?? {}) as Mergeable,
		(project ? withoutUserOnlyKeys(project) : {}) as Mergeable,
	) as SandboxSettings;
}

function deepMerge(base: Mergeable, overrides: Mergeable): Mergeable {
	const out: Mergeable = { ...base };
	for (const key of Object.keys(overrides)) {
		const override = overrides[key];
		if (override === undefined) continue;
		const existing = out[key];
		if (Array.isArray(existing) && Array.isArray(override)) out[key] = [...new Set([...existing, ...override])];
		else if (isPlainObject(existing) && isPlainObject(override)) out[key] = deepMerge(existing, override);
		else out[key] = override;
	}
	return out;
}

/**
 * Rule lists are the union of both scopes: the one-level merge above would let
 * a project's `deny: []` replace the user's global deny list.
 */
export function permissions(sm: SettingsManager): PermissionSettings | undefined {
	const value = merged(sm).permissions as PermissionSettings | undefined;
	if (!value) return undefined;
	const global = (sm.getGlobalSettings() as unknown as Mergeable).permissions as PermissionSettings | undefined;
	const project = (sm.getProjectSettings() as unknown as Mergeable).permissions as PermissionSettings | undefined;
	const out = structuredClone(value);
	for (const list of ["allow", "ask", "deny"] as const) {
		const rules = [...new Set([...(global?.[list] ?? []), ...(project?.[list] ?? [])])];
		if (rules.length > 0) out[list] = rules;
	}
	return out;
}

/**
 * The starting permission mode, read from GLOBAL settings only.
 *
 * Deliberately not merged with project settings: a trusted project may add allow
 * rules, but letting it name the session's mode would let a repo switch the
 * safety layer off wholesale by shipping `defaultMode: "auto"`.
 */
export function globalPermissionDefaultMode(sm: SettingsManager): string | undefined {
	const global = sm.getGlobalSettings() as unknown as Mergeable;
	const value = (global.permissions as PermissionSettings | undefined)?.defaultMode;
	return typeof value === "string" ? value : undefined;
}

export function websearch(sm: SettingsManager): WebsearchSettings | undefined {
	const value = merged(sm).websearch as WebsearchSettings | undefined;
	return value ? { ...value } : undefined;
}

export function subagents(sm: SettingsManager): SubagentSettings | undefined {
	const value = merged(sm).subagents as SubagentSettings | undefined;
	return value ? structuredClone(value) : undefined;
}
