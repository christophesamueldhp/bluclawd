/**
 * MCP transport + tool-registration layer — PLAN.md F4.1.
 *
 * This module statically imports `@modelcontextprotocol/sdk`, whose transitive
 * tree is heavy, so it is ONLY reached via a dynamic `import("./client.ts")` from
 * index.ts when at least one server is configured — keeping the SDK out of the
 * startup path and the browser bundle. All pure/config logic lives in schema.ts.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	getDefaultEnvironment,
	StdioClientTransport,
	type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VERSION } from "../../../packages/coding-agent/src/config.ts";
import type { AgentToolResult, ExtensionAPI } from "../../../packages/coding-agent/src/core/extensions/types.ts";
import { resolveHeaders } from "../../../packages/coding-agent/src/core/resolve-config-value.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../../../packages/coding-agent/src/core/tools/truncate.ts";
import { mcpToolName, resolveServerEnv, type ServerConfig, toToolParameters } from "./schema.ts";

export type { Client };

/** Ceiling for the MCP handshake — a server that never speaks MCP (hung binary,
 * wrong command) must not leak its child/socket until shutdown. */
const CONNECT_TIMEOUT_MS = 30_000;

/** Total text budget per tool result — the shared built-in tool-output budget.
 * A misbehaving server must not flood the context window. */
const MAX_TEXT_CHARS = DEFAULT_MAX_BYTES;

/** Cap on one base64 image block (≈3MB decoded); larger becomes a placeholder. */
const MAX_IMAGE_CHARS = 4 * 1024 * 1024;

/** Structured details attached to each proxied MCP tool result. */
interface McpToolDetails {
	server: string;
	tool: string;
	isError: boolean;
}

/**
 * Spawn parameters for a stdio server. Exported for tests.
 *
 * NOTE: StdioClientTransport's `env` REPLACES the child environment (it does
 * not merge with process.env), so seed a safe default base then layer the
 * user's resolved vars on top.
 *
 * `stderr: "ignore"` — the SDK default is "inherit", which lets a chatty server
 * write straight onto the terminal (rendering over the TUI, polluting -p output).
 * Server failures still surface through the handshake error path.
 */
export function stdioTransportOptions(config: ServerConfig): StdioServerParameters {
	return {
		command: config.command as string,
		args: config.args,
		env: { ...getDefaultEnvironment(), ...resolveServerEnv(config.env) },
		stderr: "ignore",
	};
}

/**
 * Build and connect a transport for one server. `command` selects stdio, `url`
 * selects HTTP; having neither or both is a misconfiguration and throws (the
 * caller surfaces it as a notify + error status). Returns the connected Client.
 */
export async function connectServer(
	name: string,
	config: ServerConfig,
	opts?: { connectTimeoutMs?: number; authProvider?: OAuthClientProvider },
): Promise<Client> {
	const hasCommand = typeof config.command === "string" && config.command.length > 0;
	const hasUrl = typeof config.url === "string" && config.url.length > 0;
	if (hasCommand === hasUrl) {
		throw new Error(`server "${name}" must set exactly one of "command" (stdio) or "url" (http)`);
	}

	const client = new Client({ name: "bluclawd", version: VERSION }, { capabilities: {} });

	let transport: StdioClientTransport | StreamableHTTPClientTransport;
	if (hasCommand) {
		transport = new StdioClientTransport(stdioTransportOptions(config));
	} else {
		// resolveHeaders falls back to process.env internally (same as resolveServerEnv),
		// so it needs no explicit env argument.
		// authProvider is supplied only for a server that has already been through
		// `/mcp login` (see oauth.ts authProviderFor). With it the SDK attaches the
		// bearer token and refreshes on 401; without it a 401 simply fails the
		// connect, which is what keeps login an explicit, user-initiated act.
		transport = new StreamableHTTPClientTransport(new URL(config.url as string), {
			requestInit: { headers: resolveHeaders(config.headers) },
			authProvider: opts?.authProvider,
		});
	}

	const timeoutMs = opts?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`server "${name}" did not complete the MCP handshake within ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	try {
		await Promise.race([client.connect(transport), timeout]);
	} catch (err) {
		// Kill the spawned stdio child / close the socket so a never-handshaking
		// server can't leak until shutdown.
		await transport.close().catch(() => {});
		throw err;
	} finally {
		clearTimeout(timer);
	}

	return client;
}

/**
 * Map an MCP callTool result's content into pi's content union. MCP text and image
 * blocks map to their pi equivalents (pi's ImageContent is `{ data, mimeType }`,
 * identical to MCP's image shape). Content pi cannot represent (audio, embedded
 * resource, resource link, or a malformed image) becomes a COMPACT text placeholder
 * — never a base64 dump — so we neither lie about it nor flood the context window.
 */
function mapContent(rawContent: unknown): (TextContent | ImageContent)[] {
	const items = Array.isArray(rawContent) ? rawContent : [];
	const content: (TextContent | ImageContent)[] = [];
	for (const item of items) {
		const obj = item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
		const type = obj?.type;
		if (type === "text") {
			const text = obj?.text;
			content.push({
				type: "text",
				text: typeof text === "string" ? text : String(text),
			});
		} else if (type === "image" && typeof obj?.data === "string" && typeof obj?.mimeType === "string") {
			content.push({ type: "image", data: obj.data, mimeType: obj.mimeType });
		} else {
			const label = typeof type === "string" ? type : "unknown";
			const mime = typeof obj?.mimeType === "string" ? ` (${obj.mimeType})` : "";
			content.push({
				type: "text",
				text: `[mcp: omitted ${label} content${mime}]`,
			});
		}
	}
	return content;
}

/**
 * Enforce the size caps on a mapped content array (2026-07-10 review Minor): text
 * blocks share one MAX_TEXT_CHARS budget (excess is cut and marked, like the
 * built-in tools' truncation), and any single image block over MAX_IMAGE_CHARS of
 * base64 becomes a compact placeholder instead of an OOM-sized payload.
 */
function capContent(content: (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
	const out: (TextContent | ImageContent)[] = [];
	let remaining = MAX_TEXT_CHARS;
	let truncated = false;
	for (const block of content) {
		if (block.type === "image") {
			out.push(
				block.data.length > MAX_IMAGE_CHARS
					? {
							type: "text",
							text: `[mcp: omitted oversized image content (${block.mimeType})]`,
						}
					: block,
			);
		} else if (remaining > 0) {
			if (block.text.length > remaining) {
				out.push({ type: "text", text: block.text.slice(0, remaining) });
				remaining = 0;
				truncated = true;
			} else {
				remaining -= block.text.length;
				out.push(block);
			}
		} else {
			truncated = true; // budget already spent: drop, mark once below
		}
	}
	if (truncated) {
		out.push({
			type: "text",
			text: `[mcp: text result truncated at ${formatSize(MAX_TEXT_CHARS)}]`,
		});
	}
	return out;
}

/** Join the text blocks of a content array (for building a thrown error message). */
function joinText(content: (TextContent | ImageContent)[]): string {
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

/** Name + description of one registered MCP tool (for /mcp and tool deferral). */
export interface RegisteredMcpTool {
	name: string;
	description: string;
}

/**
 * List a connected server's tools and register each on `pi`, namespaced as
 * `mcp__<server>__<tool>`, with `execute` proxying to `client.callTool`. Returns
 * the registered tools (namespaced name + description) so the caller can defer
 * or deactivate them. This is the seam the in-process round-trip test
 * exercises with a fake in-memory server.
 */
export async function registerServerTools(
	pi: ExtensionAPI,
	serverName: string,
	client: Client,
): Promise<RegisteredMcpTool[]> {
	const { tools } = await client.listTools();
	const registered: RegisteredMcpTool[] = [];
	for (const tool of tools) {
		const bareName = tool.name;
		registered.push({
			name: mcpToolName(serverName, bareName),
			description: tool.description ?? `MCP tool "${bareName}" from server "${serverName}".`,
		});
		pi.registerTool({
			name: mcpToolName(serverName, bareName),
			label: mcpToolName(serverName, bareName),
			description: tool.description ?? `MCP tool "${bareName}" from server "${serverName}".`,
			parameters: toToolParameters(tool.inputSchema),
			async execute(_toolCallId, params, signal): Promise<AgentToolResult<McpToolDetails>> {
				// Forward the abort signal so Esc cancels an in-flight MCP call.
				const result = await client.callTool(
					{
						name: bareName,
						arguments: (params ?? {}) as Record<string, unknown>,
					},
					undefined,
					{ signal },
				);
				// Cap BEFORE the isError branch so a runaway error text can't flood the
				// thrown message either.
				const content = capContent(mapContent(result.content));
				if (result.isError === true) {
					// Framework contract (AgentToolResult.execute): throw on failure instead of
					// encoding the error in content, so the loop/telemetry/hooks record a failure.
					throw new Error(joinText(content) || `MCP tool "${bareName}" on server "${serverName}" failed.`);
				}
				if (content.length === 0) content.push({ type: "text", text: "" });
				return {
					content,
					details: { server: serverName, tool: bareName, isError: false },
				};
			},
		});
	}
	return registered;
}
