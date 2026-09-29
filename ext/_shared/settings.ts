/**
 * Settings keys bluclawd adds on top of pi's, and the readers for them.
 *
 * pi's `Settings` type is not exported and has no getters for these keys, so
 * every reader goes through an untyped `Record<string, unknown>` cast.
 * `SettingsManager` already returns empty project settings for an untrusted
 * project, so a reader here never sees an untrusted project's values.
 */
import type { SettingsManager } from "@earendil-works/pi-coding-agent";

interface PermissionSettings {
	deny?: string[];
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
