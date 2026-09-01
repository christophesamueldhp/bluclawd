/**
 * MCP bridge core extension (Model Context Protocol) — PLAN.md F4.1 + audit B.5.
 *
 * Bridges MCP servers declared in `mcp.json` into bluclawd by registering each
 * server's tools as `mcp__<server>__<tool>`. Config is loaded from
 * `<agentDir>/mcp.json` (global, always) and `<cwd>/.bluclawd/mcp.json` (project,
 * ONLY when the project is trusted), in Claude Code's `{ "mcpServers": { … } }`
 * shape.
 *
 * STARTUP COST (Trap): the `@modelcontextprotocol/sdk` transitive tree is heavy,
 * so this file never statically imports client.ts or the SDK. Config parsing lives
 * in schema.ts (SDK-free). Only when there is ≥1 configured server does
 * session_start dynamically `import("./client.ts")` and connect.
 *
 * NON-BLOCKING (interactive): connecting is fire-and-forget — session_start
 * returns immediately so a slow/hung remote server can't stall launch. Each
 * server connects independently under its own try/catch; failures surface as a
 * footer status + notify, never a crash. Live tool registration after startup
 * is supported. HEADLESS (-p/RPC, `!ctx.hasUI`): session_start awaits the
 * connections instead — the only turn starts right after it, so tools must be
 * registered by then. The per-server handshake timeout in client.ts bounds the
 * wait.
 *
 * MANAGEMENT (audit B.5): `/mcp` lists servers; `/mcp enable|disable <server>`
 * toggles a server live AND persists `disabled` into the defining mcp.json;
 * `/mcp reconnect [server]` closes and re-drives connections.
 *
 * OAUTH (audit B.5): `/mcp login <server>` runs the browser flow (see oauth.ts)
 * and `/mcp logout <server>` forgets the credential. Login is ONLY ever explicit:
 * connectTargets attaches an authProvider just for servers that already hold a
 * credential, so a 401 fails the connect rather than opening a browser chosen by
 * whatever URL happened to be in mcp.json.
 *
 * DEFERRED TOOLS (audit B.5): a server with `deferTools: true` gets its tools
 * registered but immediately DEACTIVATED, so their schemas stay out of the
 * model's context. A single `mcp_find_tools` search tool (registered only when
 * something is deferred) lets the model find and activate them on demand —
 * this is the context-saver for 60-tool servers like github.
 *
 * LIFECYCLE: session_start re-fires on resume and /reload (reload also fires
 * session_shutdown first, which closes clients). An `epoch` counter, bumped on
 * every session_start and session_shutdown, invalidates any in-flight connect so a
 * connect that resolves after the session ended neither registers tools nor leaks
 * an open client.
 *
 * Idempotent factory (Trap): the body only registers managed pi.on(...) handlers
 * and the /mcp command — no file I/O and no connecting at load time.
 */

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { openBrowser } from "../../../packages/coding-agent/src/utils/open-browser.ts";
import type { Client, RegisteredMcpTool } from "./client.ts";
import { McpCredentialStore } from "./credential-store.ts";
import { isAuthFailure, loadMcpConfig, type ServerConfig, setServerDisabled } from "./schema.ts";

type ConnectionStatus = "connecting" | "connected" | "error" | "disabled";

interface Connection {
	name: string;
	config: ServerConfig;
	status: ConnectionStatus;
	toolCount: number;
	tools: RegisteredMcpTool[];
	error?: string;
	client?: Client;
}

/** Most matches mcp_find_tools will activate in one call (context guard). */
const FIND_TOOLS_MAX_MATCHES = 10;

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function factory(pi: ExtensionAPI): void {
	// Session-scoped state, rebuilt on every session_start. `epoch` guards against
	// in-flight connects resolving after a shutdown/reload (see file header).
	let connections: Connection[] = [];
	let epoch = 0;
	// Deferred (registered-but-inactive) MCP tools by namespaced name (audit B.5).
	const deferredTools = new Map<string, RegisteredMcpTool>();
	let findToolsRegistered = false;

	function updateStatus(ctx: ExtensionContext): void {
		const disabled = connections.filter((c) => c.status === "disabled").length;
		const total = connections.length - disabled;
		const connected = connections.filter((c) => c.status === "connected").length;
		const tools = connections.reduce((n, c) => n + c.toolCount, 0);
		const failed = connections.filter((c) => c.status === "error").length;
		let text = `mcp: ${connected}/${total} servers, ${tools} tools`;
		if (failed > 0) text += `, ${failed} failed`;
		if (disabled > 0) text += `, ${disabled} disabled`;
		ctx.ui.setStatus("mcp", text);
	}

	/** Register the deferred-tool search tool once per factory instance. */
	function ensureFindToolsRegistered(): void {
		if (findToolsRegistered) return;
		findToolsRegistered = true;
		pi.registerTool({
			name: "mcp_find_tools",
			label: "MCP Tool Search",
			description:
				"Search deferred MCP tools by keyword and activate the matches so they become callable. Some MCP servers register their tools deferred (schemas kept out of context); use this to find and enable the ones you need.",
			parameters: Type.Object({
				query: Type.String({
					description: "Keywords matched against tool names and descriptions (every word must match).",
				}),
			}),
			async execute(_toolCallId, params) {
				const terms = String(params.query ?? "")
					.toLowerCase()
					.split(/\s+/)
					.filter(Boolean);
				if (terms.length === 0) {
					const all = [...deferredTools.values()].map((t) => `- ${t.name}: ${t.description}`);
					return {
						content: [
							{
								type: "text",
								text: all.length
									? `Deferred MCP tools (pass a query to activate):\n${all.join("\n")}`
									: "No deferred MCP tools.",
							},
						],
						details: { activated: [] as string[] },
					};
				}
				const matches = [...deferredTools.values()].filter((t) => {
					const haystack = `${t.name} ${t.description}`.toLowerCase();
					return terms.every((term) => haystack.includes(term));
				});
				if (matches.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `No deferred MCP tools matched "${params.query}". ${deferredTools.size} remain deferred.`,
							},
						],
						details: { activated: [] as string[] },
					};
				}
				const activated = matches.slice(0, FIND_TOOLS_MAX_MATCHES);
				const names = activated.map((t) => t.name);
				pi.setActiveTools([...new Set([...pi.getActiveTools(), ...names])]);
				for (const name of names) deferredTools.delete(name);
				const lines = activated.map((t) => `- ${t.name}: ${t.description}`);
				const dropped = matches.length - activated.length;
				return {
					content: [
						{
							type: "text",
							text: `Activated ${activated.length} tool${activated.length === 1 ? "" : "s"} (callable from the next turn):\n${lines.join("\n")}${dropped > 0 ? `\n(${dropped} more matched — narrow the query to activate them)` : ""}`,
						},
					],
					details: { activated: names },
				};
			},
		});
	}

	/** Deactivate a server's freshly registered tools and index them for search. */
	function deferServerTools(registered: RegisteredMcpTool[]): void {
		for (const tool of registered) deferredTools.set(tool.name, tool);
		const names = new Set(registered.map((t) => t.name));
		pi.setActiveTools(pi.getActiveTools().filter((n) => !names.has(n)));
		ensureFindToolsRegistered();
	}

	async function connectOne(
		conn: Connection,
		ctx: ExtensionContext,
		myEpoch: number,
		connectServer: (name: string, config: ServerConfig) => Promise<Client>,
		registerServerTools: (pi: ExtensionAPI, name: string, client: Client) => Promise<RegisteredMcpTool[]>,
		hadCredential = false,
	): Promise<void> {
		try {
			const client = await connectServer(conn.name, conn.config);
			if (myEpoch !== epoch) {
				// Session ended/reloaded while connecting — don't register; close to avoid a leak.
				await client.close().catch(() => {});
				return;
			}
			conn.client = client;
			const registered = await registerServerTools(pi, conn.name, client);
			if (myEpoch !== epoch) {
				await client.close().catch(() => {});
				return;
			}
			conn.status = "connected";
			conn.tools = registered;
			conn.toolCount = registered.length;
			if (conn.config.deferTools && registered.length > 0) {
				deferServerTools(registered);
			} else if (registered.length > 0) {
				// Re-registration of a known name does not auto-activate (the registry
				// only auto-activates NEW names), so an enable/reconnect after a
				// disable would leave the tools invisible — activate explicitly.
				const active = new Set(pi.getActiveTools());
				const missing = registered.map((t) => t.name).filter((n) => !active.has(n));
				if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
			}
		} catch (err) {
			if (myEpoch !== epoch) return;
			conn.status = "error";
			conn.error = errMsg(err);
			// A 401 on a server we hold no credential for is not a fault to report —
			// it just means "log in". Say so, since the raw transport error does not.
			const needsLogin = !hadCredential && isAuthFailure(conn.error);
			const hint = needsLogin ? ` — run /mcp login ${conn.name} to authenticate.` : "";
			ctx.ui.notify(`MCP server "${conn.name}" failed: ${conn.error}${hint}`, "warning");
		}
		if (myEpoch === epoch) updateStatus(ctx);
	}

	async function connectTargets(ctx: ExtensionContext, myEpoch: number, targets: Connection[]): Promise<void> {
		let mod: typeof import("./client.ts");
		try {
			mod = await import("./client.ts");
		} catch (err) {
			if (myEpoch !== epoch) return;
			for (const c of targets) {
				c.status = "error";
				c.error = "failed to load MCP SDK";
			}
			ctx.ui.notify(`MCP: failed to load the SDK: ${errMsg(err)}`, "error");
			updateStatus(ctx);
			return;
		}
		if (myEpoch !== epoch) return;
		const { connectServer, registerServerTools } = mod;

		// Attach stored OAuth credentials, if any. authProviderFor yields a provider
		// only when this exact server URL has already been through `/mcp login`, so an
		// un-authenticated server connects (and 401s) without any browser flow.
		//
		// Consulted lazily and only for http servers. The store reads on demand and
		// writes nothing until a login happens, so connecting to stdio servers
		// creates no file. Failure here is non-fatal — connect without credentials
		// and let the individual server report its own 401.
		const providers = new Map<string, import("./oauth.ts").McpOAuthProvider>();
		const httpTargets = targets.filter((t) => typeof t.config.url === "string" && t.config.url.length > 0);
		if (httpTargets.length > 0) {
			try {
				const { authProviderFor } = await import("./oauth.ts");
				const storage = McpCredentialStore.create();
				for (const target of httpTargets) {
					const provider = authProviderFor({
						storage,
						server: target.name,
						config: target.config,
						hasUI: ctx.hasUI,
						openBrowser: async (url) => openBrowser(url),
					});
					if (provider) providers.set(target.name, provider);
				}
			} catch (err) {
				ctx.ui.notify(`MCP: could not read stored credentials: ${errMsg(err)}`, "warning");
			}
		}
		if (myEpoch !== epoch) return;

		const connectWithAuth = (name: string, config: ServerConfig) => {
			const authProvider = providers.get(name);
			return authProvider ? connectServer(name, config, { authProvider }) : connectServer(name, config);
		};

		await Promise.allSettled(
			targets.map((conn) =>
				connectOne(conn, ctx, myEpoch, connectWithAuth, registerServerTools, providers.has(conn.name)),
			),
		);
	}

	async function connectAll(ctx: ExtensionContext, myEpoch: number): Promise<void> {
		await connectTargets(
			ctx,
			myEpoch,
			connections.filter((c) => c.status !== "disabled"),
		);
	}

	/** Close a connection's client and deactivate + un-defer its tools. */
	async function teardownConnection(conn: Connection): Promise<void> {
		const client = conn.client;
		conn.client = undefined;
		const names = new Set(conn.tools.map((t) => t.name));
		if (names.size > 0) {
			pi.setActiveTools(pi.getActiveTools().filter((n) => !names.has(n)));
			for (const name of names) deferredTools.delete(name);
		}
		conn.tools = [];
		conn.toolCount = 0;
		if (client) await client.close().catch(() => {});
	}

	pi.on("session_start", async (_event, ctx) => {
		const myEpoch = ++epoch;
		deferredTools.clear();
		const servers = loadMcpConfig(ctx);
		const names = Object.keys(servers);
		connections = names.map((name) => ({
			name,
			config: servers[name],
			status: servers[name].disabled ? "disabled" : "connecting",
			toolCount: 0,
			tools: [],
		}));
		if (names.length === 0) {
			ctx.ui.setStatus("mcp", undefined);
			return;
		}
		updateStatus(ctx);
		if (connections.every((c) => c.status === "disabled")) return;
		if (ctx.hasUI) {
			// Fire-and-forget: don't block interactive launch on server connections.
			void connectAll(ctx, myEpoch).catch(() => {});
		} else {
			// Headless (-p/RPC): the only turn starts right after session_start, so
			// tools must be registered before this handler resolves or the model
			// never sees them. Bounded by client.ts's per-server handshake timeout;
			// connectAll never rejects (per-connection failures fail open).
			await connectAll(ctx, myEpoch);
		}
	});

	pi.on("session_shutdown", async () => {
		epoch++; // invalidate any in-flight connect
		deferredTools.clear();
		const clients = connections.map((c) => c.client).filter((c): c is Client => !!c);
		connections = [];
		await Promise.allSettled(clients.map((c) => c.close()));
	});

	pi.registerCommand("mcp", {
		description:
			"List or manage MCP servers: /mcp [enable|disable <server> | login|logout <server> | reconnect [server]]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0];

			if (sub === "login" || sub === "logout") {
				const name = parts[1];
				if (!name) {
					ctx.ui.notify(`Usage: /mcp ${sub} <server>`, "warning");
					return;
				}
				const conn = connections.find((c) => c.name === name);
				if (!conn) {
					ctx.ui.notify(`MCP: no server named "${name}".`, "warning");
					return;
				}

				const { loginServer, logoutServer } = await import("./oauth.ts");
				const storage = McpCredentialStore.create();

				if (sub === "logout") {
					logoutServer({ storage, server: name });
					ctx.ui.notify(
						`Signed out of MCP server "${name}". Run /mcp reconnect ${name} to drop the session.`,
						"info",
					);
					return;
				}

				if (!conn.config.url) {
					ctx.ui.notify(`MCP: "${name}" is a stdio server; OAuth applies to url servers only.`, "warning");
					return;
				}

				// Snapshot BEFORE the login, which blocks on a human for up to 5 minutes.
				// Reading `epoch` after that await would always compare equal to itself,
				// leaving the reconnect below unguarded against a /reload mid-login.
				const myEpoch = epoch;

				ctx.ui.notify(`Opening your browser to sign in to "${name}"…`, "info");
				try {
					await loginServer({
						storage,
						server: name,
						serverUrl: conn.config.url,
						hasUI: ctx.hasUI,
						openBrowser: async (url) => {
							// Always print it. A browser launch is best-effort and silent on
							// failure, and over SSH there is no browser to launch at all —
							// without the URL the user just waits out the timeout.
							ctx.ui.notify(`If your browser does not open, visit:\n${url}`, "info");
							openBrowser(url);
						},
					});
				} catch (err) {
					ctx.ui.notify(`MCP login for "${name}" failed: ${errMsg(err)}`, "error");
					return;
				}
				// The credential is saved either way; only the live reconnect is unsafe
				// against a session that was reloaded while the browser was open.
				if (myEpoch !== epoch) {
					ctx.ui.notify(
						`Signed in to "${name}", but the session reloaded during login. Run /mcp reconnect ${name}.`,
						"warning",
					);
					return;
				}

				ctx.ui.notify(`Signed in to "${name}". Reconnecting…`, "info");
				// The pre-login connection (typically failed on 401) still owns a client
				// and tool registrations; drop them before reconnecting with credentials.
				await teardownConnection(conn);
				conn.status = "connecting";
				await connectTargets(ctx, myEpoch, [conn]);
				return;
			}

			if (sub === "enable" || sub === "disable") {
				const name = parts[1];
				if (!name) {
					ctx.ui.notify(`Usage: /mcp ${sub} <server>`, "warning");
					return;
				}
				const disabled = sub === "disable";
				const result = setServerDisabled(ctx, name, disabled);
				if ("error" in result) {
					ctx.ui.notify(`MCP: ${result.error}`, "error");
					return;
				}
				const conn = connections.find((c) => c.name === name);
				if (conn) {
					conn.config.disabled = disabled;
					if (disabled) {
						await teardownConnection(conn);
						conn.status = "disabled";
						conn.error = undefined;
					} else if (conn.status === "disabled") {
						conn.status = "connecting";
						updateStatus(ctx);
						await connectTargets(ctx, epoch, [conn]);
					}
					updateStatus(ctx);
				}
				ctx.ui.notify(
					`MCP server "${name}" ${disabled ? "disabled" : "enabled"} (persisted to ${result.file}).`,
					"info",
				);
				return;
			}

			if (sub === "reconnect") {
				const name = parts[1];
				const targets = connections.filter((c) => (name ? c.name === name : c.status !== "disabled"));
				if (targets.length === 0) {
					ctx.ui.notify(name ? `MCP: no server named "${name}".` : "MCP: no servers to reconnect.", "warning");
					return;
				}
				for (const conn of targets) {
					await teardownConnection(conn);
					conn.status = "connecting";
					conn.error = undefined;
				}
				updateStatus(ctx);
				await connectTargets(ctx, epoch, targets);
				const summary = targets
					.map(
						(c) =>
							`${c.name}: ${c.status === "connected" ? `connected, ${c.toolCount} tools` : (c.error ?? c.status)}`,
					)
					.join(" · ");
				ctx.ui.notify(`MCP reconnect — ${summary}`, "info");
				return;
			}

			if (parts.length > 0) {
				ctx.ui.notify(
					"Usage: /mcp [enable|disable <server> | login|logout <server> | reconnect [server]]",
					"warning",
				);
				return;
			}

			if (connections.length === 0) {
				ctx.ui.notify(
					"No MCP servers configured. Add an mcp.json (global agent dir or project .bluclawd/).",
					"info",
				);
				return;
			}
			const lines = connections.map((c) => {
				const kind = c.config.command ? "stdio" : c.config.url ? "http" : "?";
				const deferred = c.config.deferTools ? ", deferred" : "";
				const state =
					c.status === "connected"
						? `connected, ${c.toolCount} tool${c.toolCount === 1 ? "" : "s"}${deferred}`
						: c.status === "connecting"
							? "connecting…"
							: c.status === "disabled"
								? "disabled"
								: `error: ${c.error ?? "unknown"}`;
				return `• ${c.name} (${kind}) — ${state}`;
			});
			lines.push("");
			lines.push("Manage: /mcp enable|disable <server> · /mcp login|logout <server> · /mcp reconnect [server]");
			ctx.ui.notify(`MCP servers:\n${lines.join("\n")}`, "info");
		},
	});
}

const mcpExtension: InlineExtension = { name: "mcp", factory };
export default mcpExtension.factory;
