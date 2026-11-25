/**
 * pi's `Settings` type is not exported and has no getters for these keys, so
 * every reader goes through an untyped `Record<string, unknown>` cast.
 * `SettingsManager` already returns empty project settings for an untrusted
 * project, so a reader here never sees an untrusted project's values.
 */
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PORT } from "../../daemon/remote/pairing.ts";

type Mergeable = Record<string, unknown>;

function isPlainObject(value: unknown): value is Mergeable {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergedOneLevel(sm: SettingsManager): Mergeable {
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

export function prefersReducedMotion(sm: SettingsManager): boolean {
	return mergedOneLevel(sm).prefersReducedMotion === true;
}

/**
 * The deny rules of both scopes, combined, because pi's own merge replaces arrays, which would
 * let a project's `deny: []` drop the user's global rules.
 */
export function denyRules(sm: SettingsManager): string[] {
	return [...new Set([...(rulesOf(sm.getGlobalSettings()) ?? []), ...(rulesOf(sm.getProjectSettings()) ?? [])])];
}

export function invalidDenyScopes(sm: SettingsManager): Array<"global" | "project"> {
	return (["global", "project"] as const).filter(
		(scope) => rulesOf(scope === "global" ? sm.getGlobalSettings() : sm.getProjectSettings()) === undefined,
	);
}

function rulesOf(settings: unknown): string[] | undefined {
	const permissions = isPlainObject(settings) ? settings.permissions : undefined;
	const deny = isPlainObject(permissions) ? permissions.deny : undefined;
	if (deny === undefined) return [];
	if (Array.isArray(deny) && deny.every((rule) => typeof rule === "string")) return deny;
	return undefined;
}

export function remotePort(sm: SettingsManager): number {
	const port = (mergedOneLevel(sm).remote as { port?: unknown } | undefined)?.port;
	return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

export function runsInPanes(sm: SettingsManager): boolean {
	return (mergedOneLevel(sm).subagents as { panes?: unknown } | undefined)?.panes !== false;
}
