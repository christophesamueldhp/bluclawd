/**
 * Settings keys bluclawd adds on top of pi's, and the readers for them.
 *
 * pi's `Settings` type is not exported and has no getters for these keys, so
 * every reader goes through an untyped `Record<string, unknown>` cast.
 * `SettingsManager` already returns empty project settings for an untrusted
 * project, so a reader here never sees an untrusted project's values.
 */
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

export interface PermissionSettings {
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
 * The deny rules of both scopes, combined: pi's own merge replaces arrays, which would
 * let a project's `deny: []` drop the user's global rules.
 */
export function denyRules(sm: SettingsManager): string[] {
	const of = (settings: unknown) =>
		((settings as Mergeable).permissions as PermissionSettings | undefined)?.deny ?? [];
	return [...new Set([...of(sm.getGlobalSettings()), ...of(sm.getProjectSettings())])];
}

export function websearch(sm: SettingsManager): WebsearchSettings | undefined {
	const value = merged(sm).websearch as WebsearchSettings | undefined;
	return value ? { ...value } : undefined;
}

export function subagents(sm: SettingsManager): SubagentSettings | undefined {
	const value = merged(sm).subagents as SubagentSettings | undefined;
	return value ? structuredClone(value) : undefined;
}
