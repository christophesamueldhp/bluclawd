/**
 * Persisting bluclawd's own settings keys (permission rules, MCP server
 * approvals) to settings.json.
 *
 * pi's `SettingsManager` has a typed setter per key and keeps its write path
 * private, so there is no public way to persist a key pi does not know about.
 * Rather than edit that file, these writers do their own locked
 * read-modify-write of the same JSON files pi reads.
 *
 * Two properties make that safe enough to be the same risk the fork already
 * carried: each writer touches **only** the one top-level key it owns
 * (`permissions` for the rule writers, `mcp` for the MCP approval record),
 * merging into whatever else is on disk at the time; and they take pi's own
 * advisory lock
 * (`proper-lockfile` on the settings file) so a concurrent writer serialises
 * rather than interleaves. The fork's version wrote through a second
 * `SettingsManager` instance, which had the same last-writer-wins exposure.
 *
 * Trust is the caller's job — `addProjectRule` throws rather than silently
 * writing into an untrusted project, mirroring pi's own
 * `assertProjectTrustedForWrite`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import type { PermissionSettings } from "./settings.ts";

type RuleList = "allow" | "ask" | "deny";

function globalSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function projectSettingsPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "settings.json");
}

function readObject(path: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		// A malformed or non-object settings file is left alone by returning {};
		// the caller's write then re-creates a well-formed one rather than
		// throwing in the middle of a permission prompt.
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** Locked read-modify-write of one settings file, touching only `key`. */
async function updateKey<T>(path: string, key: string, update: (current: T) => T | undefined): Promise<boolean> {
	mkdirSync(dirname(path), { recursive: true });
	if (!existsSync(path)) writeFileSync(path, "{}\n", "utf-8");

	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(path, {
			retries: { retries: 5, minTimeout: 20, maxTimeout: 200 },
		});
	} catch {
		// Could not take the lock — refuse rather than race another writer.
		return false;
	}

	try {
		const settings = readObject(path);
		const current = (settings[key] ?? {}) as T;
		const next = update(structuredClone(current));
		if (next === undefined) return false;
		settings[key] = next;
		writeFileSync(path, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8");
		return true;
	} finally {
		await release?.().catch(() => {});
	}
}

function withRule(permissions: PermissionSettings, list: RuleList, rule: string): PermissionSettings | undefined {
	const rules = permissions[list] ?? [];
	if (rules.includes(rule)) return undefined; // idempotent: nothing to write
	return { ...permissions, [list]: [...rules, rule] };
}

function withoutRule(permissions: PermissionSettings, rule: string): PermissionSettings | undefined {
	let removed = false;
	const next: PermissionSettings = { ...permissions };
	for (const list of ["allow", "ask", "deny"] as const) {
		const rules = next[list];
		if (rules?.includes(rule)) {
			next[list] = rules.filter((entry) => entry !== rule);
			removed = true;
		}
	}
	return removed ? next : undefined;
}

export async function addGlobalRule(list: RuleList, rule: string): Promise<void> {
	await updateKey<PermissionSettings>(globalSettingsPath(), "permissions", (p) => withRule(p, list, rule));
}

export async function addProjectRule(cwd: string, list: RuleList, rule: string, trusted: boolean): Promise<void> {
	if (!trusted) throw new Error("Refusing to write project permission rules: project is not trusted");
	await updateKey<PermissionSettings>(projectSettingsPath(cwd), "permissions", (p) => withRule(p, list, rule));
}

export async function removeGlobalRule(rule: string): Promise<boolean> {
	return updateKey<PermissionSettings>(globalSettingsPath(), "permissions", (p) => withoutRule(p, rule));
}

export async function removeProjectRule(cwd: string, rule: string, trusted: boolean): Promise<boolean> {
	if (!trusted) return false;
	return updateKey<PermissionSettings>(projectSettingsPath(cwd), "permissions", (p) => withoutRule(p, rule));
}

/** The `mcp` settings key this layer owns: the approval record and per-project enable/disable choices. */
interface McpSettings {
	approvedProjectServers?: Record<string, Record<string, string>>;
	disabledProjectServers?: Record<string, Record<string, boolean>>;
	enableAllProjectMcpServers?: boolean;
}

/**
 * Record the user's approval of one project-declared MCP server.
 *
 * Always written to the GLOBAL settings file, never the project's: the repo whose
 * server is being approved must not be able to supply its own approval. Keyed by
 * absolute project path, then server name, storing the config fingerprint so a
 * later edit to that entry re-gates it.
 */
export async function approveProjectServer(cwd: string, name: string, fingerprint: string): Promise<boolean> {
	return updateKey<McpSettings>(globalSettingsPath(), "mcp", (mcp) => {
		const byProject = { ...(mcp.approvedProjectServers ?? {}) };
		byProject[cwd] = { ...(byProject[cwd] ?? {}), [name]: fingerprint };
		return { ...mcp, approvedProjectServers: byProject };
	});
}

/**
 * Record `/mcp enable|disable` for one project-declared server in the GLOBAL
 * settings, so the committed `.mcp.json` the server came from is never rewritten.
 */
export async function setProjectServerDisabled(cwd: string, name: string, disabled: boolean): Promise<boolean> {
	return updateKey<McpSettings>(globalSettingsPath(), "mcp", (mcp) => {
		const byProject = { ...(mcp.disabledProjectServers ?? {}) };
		byProject[cwd] = { ...(byProject[cwd] ?? {}), [name]: disabled };
		return { ...mcp, disabledProjectServers: byProject };
	});
}
