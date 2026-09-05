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
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

/** Sandbox settings, passed through to @anthropic-ai/sandbox-runtime. */
export interface SandboxSettings {
	enabled?: boolean; // default: false — sandboxing is opt-in
	/** Refuse to run bash at all when the sandbox is enabled but failed to start.
	 *  default: false — the historical behaviour is an unsandboxed fallback. */
	strict?: boolean;
	network?: { allowedDomains?: string[]; deniedDomains?: string[] };
	filesystem?: {
		denyRead?: string[];
		allowWrite?: string[];
		denyWrite?: string[];
	};
	ignoreViolations?: Record<string, string[]>;
	enableWeakerNestedSandbox?: boolean;
}

export interface PermissionSettings {
	/** Mode the session starts in. Read from GLOBAL settings only — a project must not name it. */
	defaultMode?: "ask" | "edits" | "auto" | "always" | "never" | "default" | "acceptEdits" | "bypass" | "dontAsk";
	allow?: string[];
	ask?: string[];
	deny?: string[];
	/** auto mode reverts to prompting after N blocks */
	autoMode?: { maxConsecutiveBlocks?: number; maxTotalBlocks?: number };
}

export interface StatuslineSettings {
	command: string;
	intervalMs?: number;
}

export interface WebsearchSettings {
	provider?: "exa" | "brave" | "tavily";
	apiKeyEnv?: string;
	keyless?: boolean;
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
	const value = merged(sm).sandbox as SandboxSettings | undefined;
	return value ? structuredClone(value) : undefined;
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
 * safety layer off wholesale by shipping `defaultMode: "always"`.
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
