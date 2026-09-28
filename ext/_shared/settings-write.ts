/**
 * Persisting bluclawd's own settings key `mcp` (MCP server approvals) to
 * settings.json. pi's `SettingsManager` has no public way to persist a key it does
 * not know, so these writers do their own read-modify-write of the file pi reads.
 *
 * Each writer touches **only** the one top-level key it owns, merging into
 * whatever else is on disk, and takes pi's `proper-lockfile` lock on the file
 * so a concurrent writer serialises rather than interleaves.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";

function globalSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function readObject(path: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		// A malformed file reads as {} so the write re-creates a well-formed one
		// rather than throwing in the middle of a permission prompt.
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
