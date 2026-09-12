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
 *
 * Besides parsing, this module owns the two decisions that must be testable without
 * a transport: which transport an entry selects ({@link transportKind}) and whether
 * a project-declared server may connect at all ({@link needsApproval}).
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TSchema } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getDebugLogPath } from "../_shared/paths.ts";
import { resolveConfigValue } from "../_shared/resolve-config-value.ts";

const MCP_FILE = "mcp.json";
/** Claude Code's shared, commit-to-the-repo config at the project root. */
const SHARED_MCP_FILE = ".mcp.json";

/** Transports a server entry can select. See {@link transportKind}. */
export type TransportKind = "stdio" | "http" | "sse";

/** Which file an entry came from. Decides whether the approval gate applies. */
export type ServerSource = "global" | "project";

/** A single MCP server entry. `command` ⇒ stdio transport; `url` ⇒ HTTP transport. */
export interface ServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	/** Explicit transport, as Claude Code writes it. Absent ⇒ inferred from the
	 *  fields; required to reach the legacy SSE transport, which is never guessed. */
	type?: TransportKind;
	/** Which file this came from. Stamped by {@link loadMcpConfig} and NEVER read
	 *  out of the file itself — a repo that could declare itself `global` would
	 *  walk straight past {@link needsApproval}. */
	source?: ServerSource;
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

/** Read + JSON-parse a file expected to hold an object. Anything else ⇒ {}. */
function readJsonObject(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
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
		// Kept verbatim (not validated here) so an unknown transport surfaces as a
		// per-server notify at connect time rather than being silently inferred away.
		if (typeof v.type === "string") config.type = v.type as TransportKind;
		if (typeof v.disabled === "boolean") config.disabled = v.disabled;
		if (typeof v.deferTools === "boolean") config.deferTools = v.deferTools;
		out[name] = config;
	}
	return out;
}

/**
 * Pick the transport for a server entry, validating the config as it goes.
 *
 * `type` is Claude Code's field and wins when present; without it the transport is
 * inferred, exactly as before, from whichever of `command`/`url` is set. SSE is
 * reachable ONLY through an explicit `type: "sse"`: an SSE endpoint is just a URL,
 * so guessing would mean attempting both transports and paying the handshake
 * timeout twice on every genuinely misconfigured server, while hiding the mistake.
 *
 * Throws on a misconfiguration (unknown type, a type missing its required field,
 * neither or both of command/url) — the caller turns that into a per-server notify.
 */
export function transportKind(name: string, config: ServerConfig): TransportKind {
	const hasCommand = typeof config.command === "string" && config.command.length > 0;
	const hasUrl = typeof config.url === "string" && config.url.length > 0;

	if (config.type !== undefined) {
		if (config.type === "stdio") {
			if (!hasCommand) throw new Error(`server "${name}" has type "stdio" but no "command"`);
			return "stdio";
		}
		if (config.type === "http" || config.type === "sse") {
			if (!hasUrl) throw new Error(`server "${name}" has type "${config.type}" but no "url"`);
			return config.type;
		}
		throw new Error(`server "${name}" has unknown transport type "${config.type}" (expected stdio, http or sse)`);
	}

	if (hasCommand === hasUrl) {
		throw new Error(`server "${name}" must set exactly one of "command" (stdio) or "url" (http)`);
	}
	return hasCommand ? "stdio" : "http";
}

/** Recursively sort object keys so JSON.stringify is order-independent. Arrays keep
 *  their order — `args` is positional, so reordering it changes what runs. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as object).sort()) {
			out[key] = canonical((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

/**
 * Fingerprint of everything about a server that decides WHAT RUNS and WHERE
 * CREDENTIALS GO: the command line, its environment, the endpoint, the headers,
 * and the transport.
 *
 * `disabled`, `deferTools` and `source` are deliberately excluded — they change
 * how bluclawd presents a server, never what it executes, so toggling them must
 * not invalidate an approval the user already gave.
 *
 * Fields are fingerprinted as a canonicalised object rather than a joined string
 * so that text cannot migrate between neighbouring fields without changing the
 * digest (`command: "ab"` and `command: "a", args: ["b"]` differ).
 */
export function serverFingerprint(config: ServerConfig): string {
	const surface = {
		command: config.command,
		args: config.args,
		env: config.env,
		url: config.url,
		headers: config.headers,
		type: config.type,
	};
	return createHash("sha256")
		.update(JSON.stringify(canonical(surface)))
		.digest("hex");
}

/** Approved server fingerprints for one project, keyed by server name. */
export type ProjectApprovals = Record<string, string>;

/**
 * Must this server be approved by the user before bluclawd connects it?
 *
 * Only project-sourced servers are gated. This is the one control that reaches
 * them: a `Mcp(server:tool)` deny rule gates a tool CALL, but a stdio server is
 * spawned at session_start, so by the time any rule could apply the process is
 * already running. Project trust does not cover it either — `defaultProjectTrust`
 * can be `always`, in which case cloning a repo would be enough to run its
 * command.
 *
 * The approval records a fingerprint, not just a name, so editing an approved
 * entry's command re-gates it instead of inheriting the old consent.
 */
export function needsApproval(
	name: string,
	config: ServerConfig,
	approvals: ProjectApprovals,
	enableAllProjectServers: boolean,
): boolean {
	if (config.source !== "project") return false;
	if (enableAllProjectServers) return false;
	return approvals[name] !== serverFingerprint(config);
}

/**
 * Split servers about to be connected into those allowed through and those the
 * approval gate holds back.
 *
 * Applied at the single point where a transport is opened rather than at
 * session_start, because session_start is not the only way in: `/mcp reconnect`,
 * `/mcp enable` after a disable, and `/mcp login` all re-drive a connection, and
 * each one would otherwise start a server the user never approved.
 */
export function partitionByApproval<T extends { name: string; config: ServerConfig }>(
	targets: T[],
	approvals: ProjectApprovals,
	enableAllProjectServers: boolean,
): { allowed: T[]; gated: T[] } {
	const allowed: T[] = [];
	const gated: T[] = [];
	for (const target of targets) {
		(needsApproval(target.name, target.config, approvals, enableAllProjectServers) ? gated : allowed).push(target);
	}
	return { allowed, gated };
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
 * project `<cwd>/<CONFIG_DIR_NAME>/mcp.json` ONLY when the project is trusted. On a
 * name collision the project entry wins.
 */
export function loadMcpConfig(ctx: ExtensionContext): Record<string, ServerConfig> {
	const stamp = (servers: Record<string, ServerConfig>, source: ServerSource): Record<string, ServerConfig> => {
		for (const config of Object.values(servers)) config.source = source;
		return servers;
	};

	const global = stamp(parseMcpFile(join(getAgentDir(), MCP_FILE)), "global");
	if (!ctx.isProjectTrusted()) return global;
	// `.mcp.json` is the shared, committed convention; `<configDir>/mcp.json` is
	// this agent's own override and wins over it. Both are project-sourced, so
	// both go through the approval gate.
	const shared = stamp(parseMcpFile(join(ctx.cwd, SHARED_MCP_FILE)), "project");
	const project = stamp(parseMcpFile(join(ctx.cwd, CONFIG_DIR_NAME, MCP_FILE)), "project");
	return { ...global, ...shared, ...project };
}

/**
 * Server approvals recorded for `cwd`, read from the GLOBAL settings file.
 *
 * Global on purpose: a project-scoped record would let the repo being gated write
 * its own approval. Anything unreadable or misshapen yields no approvals — this
 * must fail closed, since the failure mode of the alternative is running a
 * stranger's command.
 */
export function approvalsForProject(cwd: string): ProjectApprovals {
	const settings = readJsonObject(join(getAgentDir(), "settings.json"));
	const mcp = settings.mcp;
	if (!mcp || typeof mcp !== "object") return {};
	const byProject = (mcp as Record<string, unknown>).approvedProjectServers;
	if (!byProject || typeof byProject !== "object") return {};
	const entry = (byProject as Record<string, unknown>)[cwd];
	if (!entry || typeof entry !== "object") return {};
	return stringRecord(entry as object);
}

/** Has the user opted out of the project-server gate entirely? Global settings only. */
export function enableAllProjectServers(): boolean {
	const mcp = readJsonObject(join(getAgentDir(), "settings.json")).mcp;
	if (!mcp || typeof mcp !== "object") return false;
	return (mcp as Record<string, unknown>).enableAllProjectMcpServers === true;
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
	// Same precedence as loadMcpConfig, so the file edited is the one that actually
	// defines the server the user is looking at.
	const candidates = [
		...(ctx.isProjectTrusted() ? [join(ctx.cwd, CONFIG_DIR_NAME, MCP_FILE), join(ctx.cwd, SHARED_MCP_FILE)] : []),
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
