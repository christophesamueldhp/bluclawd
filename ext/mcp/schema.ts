/**
 * Pure, SDK-free helpers for the MCP bridge — PLAN.md F4.1.
 *
 * This module holds everything that does NOT touch the `@modelcontextprotocol/sdk`
 * so it can be imported at startup (by index.ts) and unit-tested without any
 * transport. The SDK-touching transport/registration lives in client.ts, which is
 * only ever dynamically imported when there is at least one configured server (its
 * heavy transitive tree must stay out of the startup path and the browser bundle).
 *
 * Config shape follows Claude Code's `mcp.json`:
 *
 *   { "mcpServers": {
 *       "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
 *       "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer $TOK" } }
 *   } }
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TSchema } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getDebugLogPath } from "../_shared/paths.ts";
import { resolveConfigValue } from "../_shared/resolve-config-value.ts";

const MCP_FILE = "mcp.json";

/** A single MCP server entry. `command` ⇒ stdio transport; `url` ⇒ HTTP transport. */
export interface ServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	/** Configured but not connected; toggled by `/mcp enable|disable` (audit B.5). */
	disabled?: boolean;
	/** Register this server's tools deferred: schemas stay out of the model's
	 *  context until activated via the mcp_find_tools search tool (audit B.5). */
	deferTools?: boolean;
}

/**
 * Namespaced tool name exposed to the LLM for an MCP tool.
 *
 * SECURITY: the name is parsed back into (server, tool) by the permission
 * engine with a non-greedy `^mcp__(.+?)__(.+)$`, so the SHORTEST server name
 * always wins. A server literally named `docs__evil` would therefore be read
 * as server `docs` — inheriting `Mcp(docs:*)` grants — and could register a
 * name colliding with another server's tool. `__` in a server name is rejected
 * at config load (see validateServerName) so that ambiguity cannot exist.
 */
export function mcpToolName(server: string, tool: string): string {
	return `mcp__${server}__${tool}`;
}

/** Reject server names that would make {@link mcpToolName} ambiguous. */
export function validateServerName(name: string): string | undefined {
	if (name.includes("__")) {
		return `MCP server name "${name}" contains "__", which makes its tool names ambiguous with other servers. Rename it.`;
	}
	if (name.length === 0) return "MCP server name must not be empty.";
	return undefined;
}

/**
 * Wrap an MCP tool's JSON-Schema `inputSchema` as a TypeBox schema unchanged
 * (`Type.Unsafe` passthrough). A TypeBox object IS a JSON Schema, so this flows
 * through every provider adapter; validation stays on the MCP server side. A
 * missing/empty schema defaults to an empty object schema.
 */
export function toToolParameters(inputSchema: unknown): TSchema {
	const schema =
		inputSchema &&
		typeof inputSchema === "object" &&
		!Array.isArray(inputSchema) &&
		Object.keys(inputSchema).length > 0
			? (inputSchema as Record<string, unknown>)
			: { type: "object", properties: {} };
	return Type.Unsafe(schema);
}

/** Append a best-effort diagnostic line to the debug log. Never throws. */
function debugLog(message: string): void {
	try {
		appendFileSync(getDebugLogPath(), `[mcp] ${new Date().toISOString()} ${message}\n`);
	} catch {
		// Logging must never affect behavior.
	}
}

/** Keep only string-valued entries of an object. */
function stringRecord(value: object): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

/**
 * Parse the `mcpServers` map out of an already-parsed mcp.json value. Defensive:
 * a non-object, a missing/invalid `mcpServers`, or a non-object entry all yield an
 * empty map (never throws). Command-vs-url discrimination is validated later, at
 * connect time, so a misconfigured entry surfaces as a notify rather than being
 * silently dropped here.
 */
export function parseMcpConfig(raw: unknown): Record<string, ServerConfig> {
	if (!raw || typeof raw !== "object") return {};
	const servers = (raw as Record<string, unknown>).mcpServers;
	if (!servers || typeof servers !== "object") return {};

	const out: Record<string, ServerConfig> = {};
	for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		// An ambiguous name would let this server inherit another's Mcp() rules.
		if (validateServerName(name)) continue;
		const v = value as Record<string, unknown>;
		const config: ServerConfig = {};
		if (typeof v.command === "string") config.command = v.command;
		if (Array.isArray(v.args)) config.args = v.args.filter((a): a is string => typeof a === "string");
		if (v.env && typeof v.env === "object") config.env = stringRecord(v.env as object);
		if (typeof v.url === "string") config.url = v.url;
		if (v.headers && typeof v.headers === "object") config.headers = stringRecord(v.headers as object);
		if (typeof v.disabled === "boolean") config.disabled = v.disabled;
		if (typeof v.deferTools === "boolean") config.deferTools = v.deferTools;
		out[name] = config;
	}
	return out;
}

/** Read + JSON-parse an mcp.json file into a server map. Missing/unreadable/malformed ⇒ {}. */
function parseMcpFile(path: string): Record<string, ServerConfig> {
	if (!existsSync(path)) return {};
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		debugLog(`ignoring malformed ${path}: ${String(err)}`);
		return {};
	}
	return parseMcpConfig(parsed);
}

/**
 * Load the effective server map: the global `<agentDir>/mcp.json` always, plus the
 * project `<cwd>/.bluclawd/mcp.json` ONLY when the project is trusted. On a name
 * collision the project entry wins.
 */
export function loadMcpConfig(ctx: ExtensionContext): Record<string, ServerConfig> {
	const global = parseMcpFile(join(getAgentDir(), MCP_FILE));
	const project = ctx.isProjectTrusted() ? parseMcpFile(join(ctx.cwd, CONFIG_DIR_NAME, MCP_FILE)) : {};
	return { ...global, ...project };
}

/**
 * Persist a server's `disabled` flag into the mcp.json file that defines it
 * (audit B.5, `/mcp enable|disable`). The project file wins when it defines the
 * server (mirroring loadMcpConfig's precedence) and is only considered when the
 * project is trusted. Raw JSON is minimally edited: only the server object's
 * `disabled` key changes (removed entirely when enabling). Returns the file
 * written, or an error string.
 */
export function setServerDisabled(
	ctx: ExtensionContext,
	name: string,
	disabled: boolean,
): { file: string } | { error: string } {
	const candidates = [
		...(ctx.isProjectTrusted() ? [join(ctx.cwd, CONFIG_DIR_NAME, MCP_FILE)] : []),
		join(getAgentDir(), MCP_FILE),
	];
	for (const file of candidates) {
		if (!existsSync(file)) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf-8"));
		} catch {
			continue; // malformed file cannot define the server
		}
		const servers = (parsed as Record<string, unknown> | null)?.mcpServers;
		if (!servers || typeof servers !== "object") continue;
		const entry = (servers as Record<string, unknown>)[name];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		if (disabled) (entry as Record<string, unknown>).disabled = true;
		else delete (entry as Record<string, unknown>).disabled;
		try {
			writeFileSync(file, `${JSON.stringify(parsed, null, "\t")}\n`);
		} catch (err) {
			return { error: `could not write ${file}: ${String(err)}` };
		}
		return { file };
	}
	return { error: `server "${name}" not found in any mcp.json` };
}

/**
 * Resolve `$ENV` references in a stdio server's `env` map via the shared
 * config-value resolver (reads process.env). Entries whose variables are unset are
 * dropped, mirroring resolveHeaders() for HTTP headers.
 */
export function resolveServerEnv(env?: Record<string, string>): Record<string, string> {
	if (!env) return {};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		const resolved = resolveConfigValue(value);
		if (resolved !== undefined) out[key] = resolved;
	}
	return out;
}

/**
 * Does a connect failure mean "you are not logged in"?
 *
 * Lives here rather than in oauth.ts because index.ts needs it on the startup path,
 * and this module is the SDK-free half. Deliberately narrow: a handshake timeout or
 * a missing binary is not an auth problem, and 403 means authenticated-but-not-
 * permitted, which logging in again will not fix.
 */
export function isAuthFailure(message: string): boolean {
	const text = message.toLowerCase();
	if (text.includes("403") || text.includes("forbidden")) return false;
	return text.includes("401") || text.includes("unauthorized") || text.includes("invalid_token");
}
