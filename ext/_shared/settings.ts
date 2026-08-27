/**
 * Settings keys bluclawd adds on top of pi's, and the readers for them.
 *
 * pi's `Settings` interface does not know these keys and pi's `SettingsManager`
 * has no getters for them. Rather than edit either — the one thing this branch
 * does not do — the keys are declared here by TypeScript module augmentation and
 * read through pi's public `getGlobalSettings()` / `getProjectSettings()`.
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
	defaultMode?: "default" | "acceptEdits" | "auto" | "bypass" | "dontAsk";
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

declare module "../../../packages/coding-agent/src/core/settings-manager.ts" {
	interface Settings {
		/** "provider/model-id" used by the /fast command; unset disables it. */
		fastModel?: string;
		statusline?: StatuslineSettings;
		permissions?: PermissionSettings;
		websearch?: WebsearchSettings;
		sandbox?: SandboxSettings;
	}
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
 * safety layer off wholesale by shipping `defaultMode: "bypass"`.
 */
export function globalPermissionDefaultMode(sm: SettingsManager): string | undefined {
	return sm.getGlobalSettings().permissions?.defaultMode;
}

export function websearch(sm: SettingsManager): WebsearchSettings | undefined {
	const value = merged(sm).websearch as WebsearchSettings | undefined;
	return value ? { ...value } : undefined;
}
