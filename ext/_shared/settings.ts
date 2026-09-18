/**
 * Settings keys bluclawd adds on top of pi's, and the readers for them.
 *
 * pi's `Settings` interface does not know these keys and pi's `SettingsManager`
 * has no getters for them, and — unlike most of what this layer reaches for —
 * `Settings` isn't part of pi's public package export at all, so it cannot even
 * be augmented by name from outside pi's own source. Every reader here goes
 * through an untyped `Record<string, unknown>` cast instead (`merged()` below)
 * rather than assuming a shape pi's own types don't promise.
 *
 * The merge below reproduces pi's own precedence: project settings override
 * global ones, one level deep for objects. Trust is already handled upstream —
 * `SettingsManager.loadFromStorage` returns empty project settings when the
 * project is not trusted, so a reader here can never see an untrusted project's
 * values.
 */
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Sandbox settings: Claude Code's `sandbox` keys. Everything the runtime
 * understands passes straight through (typed against its own config so a
 * renamed key is a compile error here, and an unknown one an init failure
 * there); the keys below are the ones Claude Code adds on top.
 */
export interface SandboxSettings extends Partial<Omit<SandboxRuntimeConfig, "network" | "filesystem">> {
	enabled?: boolean; // default: false — sandboxing is opt-in
	/** Refuse to run bash at all when the sandbox is enabled but failed to start.
	 *  default: false — the historical behaviour is an unsandboxed fallback. */
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

export interface StatuslineSettings {
	/** External command whose first stdout line joins the footer's status line. */
	command?: string;
	intervalMs?: number;
	/** Extra provider ids billed by subscription (`(subscription)` in the footer, `/usage`, `/status`); kimi-coding and opencode-go are built in. */
	subscriptionProviders?: string[];
	/** Currency of the cost figure in the footer and `/usage`, converted from USD at a daily rate. default: USD */
	currency?: string;
}

export interface WebsearchSettings {
	provider?: "exa" | "brave" | "tavily";
	apiKeyEnv?: string;
	keyless?: boolean;
}

/** Limits and model aliases for the `task` tool's in-process subagents. */
export interface SubagentSettings {
	/** Most tasks one parallel or chain call may carry. default: 8 */
	maxTasks?: number;
	/** Most children running at once within one call. default: 4 */
	maxConcurrent?: number;
	/** Turn cap for every child that declares none. default: unlimited */
	maxTurns?: number;
	/** Run-time cap in milliseconds for every child that declares none. default: unlimited */
	timeoutMs?: number;
	/** One tool call running longer than this (ms) stops the child. default: unlimited */
	toolTimeoutMs?: number;
	/** Tokens (input + output + cache reads and writes) a child may use in one run. default: unlimited */
	maxTokens?: number;
	/** `{soft, hard, block}` tool-call budget for every child that declares none. default: none */
	toolBudget?: { soft?: number; hard: number; block?: string[] | "*" };
	/** How deep children may nest: 1 = children cannot delegate, 2 = they can, once. default: 2 */
	maxDepth?: number;
	/** Children one top-level task call may start in total, nested and resumed ones included. default: 32 */
	maxSpawns?: number;
	/** A forked child whose inherited conversation is above this many tokens compacts it first. default: 60000 */
	forkCompactAbove?: number;
	/** Times a child whose acceptance gate failed is sent back to fix it. default: 1 */
	gateRetries?: number;
	/** Short model names a def's `model:` may use, e.g. `{ "fast": "opencode-go/kimi-k2" }`.
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

export function statusline(sm: SettingsManager): StatuslineSettings | undefined {
	const value = merged(sm).statusline as StatuslineSettings | undefined;
	return value ? { ...value } : undefined;
}

export function sandbox(sm: SettingsManager): SandboxSettings | undefined {
	const global = (sm.getGlobalSettings() as unknown as Mergeable).sandbox as SandboxSettings | undefined;
	const project = (sm.getProjectSettings() as unknown as Mergeable).sandbox as SandboxSettings | undefined;
	return mergeSandboxSettings(global, project);
}

/**
 * Claude Code's scope merge for `sandbox`: arrays combine across scopes rather
 * than one replacing the other, objects merge at any depth, scalars take the
 * project's value. `allowAppleEvents` is the one key a project may not set —
 * it removes code-execution isolation, so only the user's own settings count.
 */
export function mergeSandboxSettings(
	global: SandboxSettings | undefined,
	project: SandboxSettings | undefined,
): SandboxSettings | undefined {
	if (!global && !project) return undefined;
	const out = deepMerge(
		structuredClone(global ?? {}) as Mergeable,
		structuredClone(project ?? {}) as Mergeable,
	) as SandboxSettings;
	if (project && "allowAppleEvents" in project) {
		if (global?.allowAppleEvents === undefined) delete out.allowAppleEvents;
		else out.allowAppleEvents = global.allowAppleEvents;
	}
	return out;
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

export function permissions(sm: SettingsManager): PermissionSettings | undefined {
	const value = merged(sm).permissions as PermissionSettings | undefined;
	return value ? structuredClone(value) : undefined;
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
