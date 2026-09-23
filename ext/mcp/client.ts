/**
 * MCP transport + tool-registration layer — PLAN.md F4.1.
 *
 * This module statically imports `@modelcontextprotocol/sdk`, whose transitive
 * tree is heavy, so it is ONLY reached via a dynamic `import("./client.ts")` from
 * index.ts when at least one server is configured — keeping the SDK out of the
 * startup path and the browser bundle. All pure/config logic lives in schema.ts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize, VERSION } from "@earendil-works/pi-coding-agent";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
	getDefaultEnvironment,
	StdioClientTransport,
	type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	CreateMessageRequestSchema,
	ElicitRequestSchema,
	ErrorCode,
	McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { resolveHeaders } from "../_shared/resolve-config-value.ts";
import type { ElicitAnswer, ElicitParams } from "./elicit.ts";
import type { SamplingParams, SamplingReply } from "./sampling.ts";
import {
	connectTimeoutMs,
	leakedCredential,
	mcpToolName,
	type PromptArgument,
	resolveServerEnv,
	type ServerConfig,
	toToolParameters,
	transportKind,
} from "./schema.ts";

export type { Client };

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

export interface ClientHandlers {
	/** Called when the server announces its tool, prompt or resource list changed. The
	 *  SDK only subscribes when the server advertises `listChanged`. */
	onListChanged?: (list: "tools" | "prompts" | "resources") => void;
	/** Answers the server's elicitation (form input) requests; the capability is
	 *  only advertised when this is supplied. */
	onElicit?: (params: ElicitParams) => Promise<ElicitAnswer>;
	/** Answers the server's sampling requests; advertised only when supplied. */
	onSample?: (params: SamplingParams) => Promise<SamplingReply>;
}

/** An unconnected Client carrying the capabilities and handlers for `handlers`. */
export function createClient(handlers: ClientHandlers = {}): Client {
	const { onListChanged, onElicit, onSample } = handlers;
	const client = new Client(
		{ name: "bluclawd", version: VERSION },
		{
			capabilities: {
				...(onElicit && { elicitation: { form: {} } }),
				...(onSample && { sampling: {} }),
			},
			// autoRefresh off: the caller re-lists through registerServerTools, which is
			// what re-registers the tools; a second listTools here would be wasted.
			listChanged: onListChanged && {
				tools: { autoRefresh: false, onChanged: () => onListChanged("tools") },
				prompts: { autoRefresh: false, onChanged: () => onListChanged("prompts") },
				resources: { autoRefresh: false, onChanged: () => onListChanged("resources") },
			},
		},
	);
	if (onElicit) client.setRequestHandler(ElicitRequestSchema, (request) => onElicit(request.params as ElicitParams));
	if (onSample)
		client.setRequestHandler(CreateMessageRequestSchema, (request) => onSample(request.params as SamplingParams));
	return client;
}

/**
 * Build and connect a transport for one server. {@link transportKind} picks it and
 * rejects a misconfiguration by throwing (the caller surfaces that as a notify +
 * error status). Returns the connected Client.
 */
export async function connectServer(
	name: string,
	config: ServerConfig,
	opts?: ClientHandlers & {
		connectTimeoutMs?: number;
		authProvider?: OAuthClientProvider;
	},
): Promise<Client> {
	const kind = transportKind(name, config);
	const client = createClient(opts);

	let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
	if (kind === "stdio") {
		transport = new StdioClientTransport(stdioTransportOptions(config));
	} else {
		// resolveHeaders falls back to process.env internally (same as resolveServerEnv),
		// so it needs no explicit env argument.
		// authProvider is supplied only for a server that has already been through
		// `/mcp login` (see oauth.ts authProviderFor). With it the SDK attaches the
		// bearer token and refreshes on 401; without it a 401 simply fails the
		// connect, which is what keeps login an explicit, user-initiated act.
		//
		// Both HTTP transports take the same two options. The SSE transport's
		// `requestInit` doc comment says "recurring POST requests", but its
		// _commonHeaders() is also what builds the headers for the initial event
		// stream (sdk 1.29.0 client/sse.js), so configured headers and a refreshed
		// OAuth token both reach the GET — `headers` and /mcp login work for an SSE
		// server exactly as they do for a streamable-http one.
		const headers = resolveHeaders(config.headers);
		// No expansion path may carry the agent's own model/cloud key to a server
		// (see leakedCredential). Checked on resolved values, before any request.
		const leakedIn = [
			["url", config.url as string],
			...Object.entries(headers ?? {}).map(([k, v]) => [`header "${k}"`, v]),
		].find(([, value]) => leakedCredential(value) !== undefined);
		if (leakedIn) {
			throw new Error(
				`server "${name}": refusing to connect — its ${leakedIn[0]} contains the value of ${leakedCredential(leakedIn[1])}`,
			);
		}
		const options = {
			requestInit: { headers },
			authProvider: opts?.authProvider,
		};
		const url = new URL(config.url as string);
		transport =
			kind === "sse" ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
	}

	// A server that never speaks MCP (hung binary, wrong command) must not leak its
	// child/socket until shutdown.
	const timeoutMs = opts?.connectTimeoutMs ?? connectTimeoutMs();
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
 * blocks share one MAX_TEXT_CHARS budget, and any single image block over
 * MAX_IMAGE_CHARS of base64 becomes a compact placeholder instead of an OOM-sized
 * payload. Text past the budget is not lost: the full text is saved to a private
 * temp file and the note names it, so the model can page through it with read/grep
 * (Claude Code does the same for an oversized MCP result).
 */
export function capContent(
	content: (TextContent | ImageContent)[],
	server: string,
	tool: string,
): (TextContent | ImageContent)[] {
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
		const saved = saveFullText(joinText(content), server, tool);
		out.push({
			type: "text",
			text: saved
				? `[mcp: text result truncated at ${formatSize(MAX_TEXT_CHARS)}; full output saved to ${saved} ]`
				: `[mcp: text result truncated at ${formatSize(MAX_TEXT_CHARS)}]`,
		});
	}
	return out;
}

/** Write an oversized result to a 0600 file in a 0700 temp dir. Undefined if that fails. */
function saveFullText(text: string, server: string, tool: string): string | undefined {
	try {
		const dir = join(tmpdir(), "bluclawd-mcp-output");
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const safe = `${server}-${tool}`.replace(/[^\w.-]/g, "_");
		const file = join(dir, `${safe}-${Date.now()}-${process.pid}.txt`);
		writeFileSync(file, text, { mode: 0o600 });
		return file;
	} catch {
		return undefined;
	}
}

/** Join the text blocks of a content array (thrown error messages, saved full output). */
function joinText(content: (TextContent | ImageContent)[]): string {
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

/** A readable error for the SDK's RequestTimeout, undefined for anything else. */
function timeoutError(
	err: unknown,
	server: string,
	tool: string,
	timeouts: { total: number; idle: number },
): Error | undefined {
	if (!(err instanceof McpError) || err.code !== ErrorCode.RequestTimeout) return undefined;
	// The SDK (1.29.0 shared/protocol.js) tells the two apart only by message text.
	const hitTotal = err.message.includes("Maximum total timeout") || timeouts.idle <= 0;
	const why = hitTotal
		? `exceeded its ${timeouts.total}ms limit (per-server "timeout" or MCP_TOOL_TIMEOUT)`
		: `sent no response or progress for ${timeouts.idle}ms (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT)`;
	return new Error(`MCP tool "${tool}" on server "${server}" ${why}.`);
}

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

/** Name + description of one registered MCP tool (for /mcp and tool deferral). */
export interface RegisteredMcpTool {
	name: string;
	description: string;
	/** As the server listed it: what registering the tool again (on a subagent) needs. */
	listed: ListedTool;
}

/**
 * List a connected server's tools and register each on `pi`, namespaced as
 * `mcp__<server>__<tool>`, with `execute` proxying to `client.callTool`. Returns
 * the registered tools (namespaced name + description) so the caller can defer
 * or deactivate them. This is the seam the in-process round-trip test
 * exercises with a fake in-memory server.
 */
export async function registerServerTools(
	pi: Pick<ExtensionAPI, "registerTool">,
	serverName: string,
	client: Client,
	timeouts: { total: number; idle: number },
): Promise<RegisteredMcpTool[]> {
	const { tools } = await client.listTools();
	return registerListedTools(pi, serverName, () => client, tools, timeouts);
}

/**
 * Register already-listed tools, calling through whatever client `getClient`
 * returns at call time: a subagent borrowing the parent's server then follows a
 * reconnect instead of holding a closed client.
 */
export function registerListedTools(
	pi: Pick<ExtensionAPI, "registerTool">,
	serverName: string,
	getClient: () => Client | undefined,
	tools: readonly ListedTool[],
	timeouts: { total: number; idle: number },
): RegisteredMcpTool[] {
	const registered: RegisteredMcpTool[] = [];
	for (const tool of tools) {
		const bareName = tool.name;
		registered.push({
			name: mcpToolName(serverName, bareName),
			description: tool.description ?? `MCP tool "${bareName}" from server "${serverName}".`,
			listed: tool,
		});
		pi.registerTool({
			name: mcpToolName(serverName, bareName),
			label: mcpToolName(serverName, bareName),
			description: tool.description ?? `MCP tool "${bareName}" from server "${serverName}".`,
			parameters: toToolParameters(tool.inputSchema),
			async execute(_toolCallId, params, signal): Promise<AgentToolResult<McpToolDetails>> {
				// Forward the abort signal so Esc cancels an in-flight MCP call. The SDK's
				// per-request timer is the IDLE window: reset by each progress notification,
				// capped by the wall clock. `onprogress` must be set — it is what makes the
				// SDK send a progressToken, and without one no server reports progress.
				const client = getClient();
				if (!client) throw new Error(`MCP server "${serverName}" is not connected.`);
				let result: Awaited<ReturnType<Client["callTool"]>>;
				try {
					result = await client.callTool(
						{
							name: bareName,
							arguments: (params ?? {}) as Record<string, unknown>,
						},
						undefined,
						{
							signal,
							timeout: timeouts.idle > 0 ? timeouts.idle : timeouts.total,
							resetTimeoutOnProgress: timeouts.idle > 0,
							maxTotalTimeout: timeouts.total,
							onprogress: () => {},
						},
					);
				} catch (err) {
					throw timeoutError(err, serverName, bareName, timeouts) ?? err;
				}
				// Cap BEFORE the isError branch so a runaway error text can't flood the
				// thrown message either.
				const content = capContent(mapContent(result.content), serverName, bareName);
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

/** An MCP prompt as offered to the user: `/mcp__<server>__<name>`. */
export interface McpPrompt {
	name: string;
	description?: string;
	arguments?: PromptArgument[];
}

/** List a server's prompts. Empty without asking when it lacks the prompts capability. */
export async function listServerPrompts(client: Client): Promise<McpPrompt[]> {
	if (!client.getServerCapabilities()?.prompts) return [];
	const { prompts } = await client.listPrompts();
	return prompts.map((p) => ({
		name: p.name,
		...(p.description ? { description: p.description } : {}),
		...(p.arguments?.length
			? {
					arguments: p.arguments.map((a) => ({
						name: a.name,
						...(a.description ? { description: a.description } : {}),
						...(a.required ? { required: true } : {}),
					})),
				}
			: {}),
	}));
}

/** One MCP resource as listed to the model. */
export interface McpResource {
	uri: string;
	name: string;
	title?: string;
	description?: string;
	mimeType?: string;
}

/** Stop paging a runaway resource list here. */
const MAX_LISTED_RESOURCES = 1000;

/** List a server's resources (all pages, capped). Empty without asking when it lacks the capability. */
export async function listServerResources(client: Client): Promise<McpResource[]> {
	if (!client.getServerCapabilities()?.resources) return [];
	const out: McpResource[] = [];
	let cursor: string | undefined;
	do {
		const page = await client.listResources(cursor ? { cursor } : undefined);
		for (const r of page.resources) {
			out.push({
				uri: r.uri,
				name: r.name,
				...(r.title ? { title: r.title } : {}),
				...(r.description ? { description: r.description } : {}),
				...(r.mimeType ? { mimeType: r.mimeType } : {}),
			});
		}
		cursor = page.nextCursor;
	} while (cursor && out.length < MAX_LISTED_RESOURCES);
	return out.slice(0, MAX_LISTED_RESOURCES);
}

/**
 * Read one resource into pi content: text stays text, an image blob becomes an image
 * block, and other binary content a compact placeholder (never a base64 dump). The
 * same size caps as a tool result apply, including the full-text spill file.
 */
export async function readServerResource(
	client: Client,
	server: string,
	uri: string,
): Promise<(TextContent | ImageContent)[]> {
	const { contents } = await client.readResource({ uri });
	const blocks = contents.map((c) => {
		if ("text" in c && typeof c.text === "string") return { type: "text", text: c.text };
		if ("blob" in c && typeof c.blob === "string" && c.mimeType?.startsWith("image/")) {
			return { type: "image", data: c.blob, mimeType: c.mimeType };
		}
		return { type: "text", text: `[mcp: omitted binary resource ${c.uri}${c.mimeType ? ` (${c.mimeType})` : ""}]` };
	});
	return capContent(mapContent(blocks), server, "resource");
}
