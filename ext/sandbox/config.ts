/**
 * The `sandbox` settings, and the `srt` config they make together with the deny rules. Every
 * key besides `enabled` is `srt`'s own and is handed to it as written; bluclawd adds the deny
 * rules' paths, the project and temp to the four path and domain lists.
 *
 * Only global settings are read: a repository's files must not loosen or switch off the sandbox.
 */
import { isAbsolute, join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { pathRule } from "../permissions/rules.ts";

export interface SandboxSettings {
	allowedDomains: string[];
	allowWrite: string[];
	denyRead: string[];
	denyWrite: string[];
	/** The `sandbox` object as written, without `enabled`. */
	written: Record<string, unknown>;
}

export type SandboxSetting =
	| { kind: "off" }
	| { kind: "on"; settings: SandboxSettings }
	| { kind: "invalid"; reason: string };

/** An `srt` config before `srt`'s schema has checked it. */
export interface RuntimeConfig {
	network: { allowedDomains: string[]; [key: string]: unknown };
	filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[]; [key: string]: unknown };
	[key: string]: unknown;
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
	const { enabled, ...written } = value;
	return enabled === true
		? { kind: "on", settings: { ...(lists as Omit<SandboxSettings, "written">), written } }
		: { kind: "off" };
}

/**
 * A rule or settings path as the sandbox takes it: absolute, since `srt` on Linux skips a
 * pattern whose first component is a wildcard. A relative path is under the working directory.
 */
function sandboxPath(written: string, cwd: string, home: string): string {
	// `srt` refuses a deny glob ending in a separator, since as a pattern it can match no path.
	const path = written.replace(/(.)\/+$/, "$1");
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
	const { network, filesystem, ...rest } = settings.written;
	return {
		...rest,
		network: { deniedDomains: [], ...(network as object), allowedDomains: [...settings.allowedDomains] },
		filesystem: {
			...(filesystem as object),
			denyRead: paths([...ruled(["Read"]), ...settings.denyRead]),
			allowWrite: paths([cwd, tmp, ...settings.allowWrite]),
			denyWrite: paths([...ruled(["Edit", "Write"]), ...settings.denyWrite]),
		},
	};
}

/** Paths of the keys in `given` that `kept` lacks. */
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
 * The config as `srt` takes it, or what is wrong with it. `srt` checks only a config it reads
 * from a file, and its schema drops a key it does not know, which would leave a misspelled
 * protection off.
 */
export async function checkRuntimeConfig(config: RuntimeConfig): Promise<SandboxRuntimeConfig | string> {
	const { SandboxRuntimeConfigSchema } = await import("@anthropic-ai/sandbox-runtime");
	const result = SandboxRuntimeConfigSchema.safeParse(config);
	if (!result.success) {
		return result.error.issues.map((issue) => `${["sandbox", ...issue.path].join(".")}: ${issue.message}`).join("; ");
	}
	const dropped = droppedKeys(config, result.data, "sandbox");
	return dropped.length > 0 ? `${dropped.join(", ")} is not a sandbox setting` : result.data;
}
