/**
 * The `sandbox` settings, and the `srt` config they make together with the deny rules.
 *
 * Only global settings are read: a repository's files must not loosen or switch off the sandbox.
 */
import { isAbsolute, join } from "node:path";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { pathRule } from "../permissions/rules.ts";

export interface SandboxSettings {
	allowedDomains: string[];
	allowWrite: string[];
	denyRead: string[];
	denyWrite: string[];
}

export type SandboxSetting =
	| { kind: "off" }
	| { kind: "on"; settings: SandboxSettings }
	| { kind: "invalid"; reason: string };

/** The fields of `srt`'s `SandboxRuntimeConfig` that bluclawd sets. */
export interface RuntimeConfig {
	network: { allowedDomains: string[]; deniedDomains: string[] };
	filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A list of strings, or the reason it is not one. */
function strings(value: unknown, name: string): string[] | string {
	if (value === undefined) return [];
	return Array.isArray(value) && value.every((v) => typeof v === "string")
		? value
		: `${name} is not a list of strings`;
}

export function sandboxSetting(sm: SettingsManager): SandboxSetting {
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
	if (!isPlainObject(network)) return { kind: "invalid", reason: "sandbox.network is not an object" };
	if (!isPlainObject(filesystem)) return { kind: "invalid", reason: "sandbox.filesystem is not an object" };
	const lists = {
		allowedDomains: strings(network.allowedDomains, "sandbox.network.allowedDomains"),
		allowWrite: strings(filesystem.allowWrite, "sandbox.filesystem.allowWrite"),
		denyRead: strings(filesystem.denyRead, "sandbox.filesystem.denyRead"),
		denyWrite: strings(filesystem.denyWrite, "sandbox.filesystem.denyWrite"),
	};
	for (const list of Object.values(lists)) if (typeof list === "string") return { kind: "invalid", reason: list };
	return value.enabled === true ? { kind: "on", settings: lists as SandboxSettings } : { kind: "off" };
}

/**
 * A rule or settings path as the sandbox takes it: absolute, since `srt` on Linux skips a
 * pattern whose first component is a wildcard. A relative path is under the working directory.
 */
function sandboxPath(path: string, cwd: string, home: string): string {
	if (path.startsWith("//")) return path.slice(1);
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return isAbsolute(path) ? path : join(cwd, path);
}

export function runtimeConfig(
	settings: SandboxSettings,
	denyRules: string[],
	cwd: string,
	home: string,
	tmp: string,
): RuntimeConfig {
	const ruled = (verbs: string[]) =>
		denyRules.flatMap((rule) => {
			const parsed = pathRule(rule);
			return parsed && verbs.includes(parsed.verb) ? [parsed.path] : [];
		});
	const paths = (list: string[]) => [...new Set(list.map((path) => sandboxPath(path, cwd, home)))];
	return {
		network: { allowedDomains: [...settings.allowedDomains], deniedDomains: [] },
		filesystem: {
			denyRead: paths([...ruled(["Read"]), ...settings.denyRead]),
			allowWrite: paths([cwd, tmp, ...settings.allowWrite]),
			denyWrite: paths([...ruled(["Edit", "Write"]), ...settings.denyWrite]),
		},
	};
}
