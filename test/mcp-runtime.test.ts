// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are literal ${VAR} config text under test
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { listServerResources, readServerResource, registerServerTools } from "../ext/mcp/client.ts";
import {
	connectTimeoutMs,
	expandEnv,
	expandServerConfig,
	findResourceMentions,
	leakedCredential,
	parseMcpConfig,
	serverFingerprint,
	toolCallTimeouts,
} from "../ext/mcp/schema.ts";

describe("toolCallTimeouts (Claude Code's defaults)", () => {
	it("defaults to a ~28h wall clock, and a 30 min idle window for stdio / 5 min for remote", () => {
		expect(toolCallTimeouts({ command: "x" }, {})).toEqual({ total: 100_000_000, idle: 1_800_000 });
		expect(toolCallTimeouts({ url: "https://a" }, {})).toEqual({ total: 100_000_000, idle: 300_000 });
	});

	it("takes the per-server timeout over MCP_TOOL_TIMEOUT, ignoring values under 1000ms", () => {
		const env = { MCP_TOOL_TIMEOUT: "600000" };
		expect(toolCallTimeouts({ command: "x", timeout: 90_000 }, env).total).toBe(90_000);
		expect(toolCallTimeouts({ command: "x", timeout: 500 }, env).total).toBe(600_000);
	});

	it("never lets the idle window outlast the wall clock", () => {
		expect(toolCallTimeouts({ command: "x", timeout: 60_000 }, {})).toEqual({ total: 60_000, idle: 60_000 });
	});

	it("honours the idle override, with 0 switching the idle timer off", () => {
		expect(toolCallTimeouts({ url: "https://a" }, { CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "20000" }).idle).toBe(20_000);
		expect(toolCallTimeouts({ url: "https://a" }, { CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "0" }).idle).toBe(0);
	});

	it("reads MCP_TIMEOUT for the connect handshake, 30s by default", () => {
		expect(connectTimeoutMs({})).toBe(30_000);
		expect(connectTimeoutMs({ MCP_TIMEOUT: "5000" })).toBe(5_000);
		expect(connectTimeoutMs({ MCP_TIMEOUT: "junk" })).toBe(30_000);
	});

	it("parses timeout without letting it move the approval fingerprint", () => {
		const parsed = parseMcpConfig({ mcpServers: { s: { command: "x", timeout: 1234 } } }).s;
		expect(parsed.timeout).toBe(1234);
		expect(serverFingerprint(parsed)).toBe(serverFingerprint({ command: "x" }));
	});
});

describe("expandEnv", () => {
	it("expands ${VAR} and falls back to ${VAR:-default}", () => {
		expect(expandEnv("${HOST}/mcp", { HOST: "h" })).toEqual({ text: "h/mcp", missing: [] });
		expect(expandEnv("${PORT:-8080}", {})).toEqual({ text: "8080", missing: [] });
		expect(expandEnv("${PORT:-8080}", { PORT: "1" })).toEqual({ text: "1", missing: [] });
	});

	it("keeps an unset variable with no default as literal text and reports it", () => {
		expect(expandEnv("--token=${NOPE}", {})).toEqual({ text: "--token=${NOPE}", missing: ["NOPE"] });
	});

	it("leaves pi's bare $VAR form alone for the header/env resolver", () => {
		expect(expandEnv("Bearer $TOK", { TOK: "t" }).text).toBe("Bearer $TOK");
	});
});

describe("expandServerConfig", () => {
	it("expands command, args, env, url and headers without mutating the original", () => {
		const raw = {
			command: "${BIN:-node}",
			args: ["${DIR}/server.js"],
			env: { K: "${V:-v}" },
			url: undefined,
			headers: { A: "${H}" },
		};
		const { config, missing } = expandServerConfig(raw, { DIR: "/d", H: "h" });
		expect(config).toMatchObject({ command: "node", args: ["/d/server.js"], env: { K: "v" }, headers: { A: "h" } });
		expect(missing).toEqual([]);
		expect(raw.command).toBe("${BIN:-node}");
	});

	it("collects every missing name once", () => {
		expect(expandServerConfig({ url: "https://${X}/${X}/${Y}" }, {}).missing).toEqual(["X", "Y"]);
	});
});

describe("leakedCredential", () => {
	const env = {
		ANTHROPIC_API_KEY: "sk-ant-secret-value",
		OPENAI_API_KEY: "sk-openai-secret",
		NOTION_API_KEY: "n-key-1234",
	};

	it("names a model/cloud credential whose value ended up in a remote url or header", () => {
		expect(leakedCredential("https://evil.example/?k=sk-ant-secret-value", env)).toBe("ANTHROPIC_API_KEY");
		expect(leakedCredential("Bearer sk-openai-secret", env)).toBe("OPENAI_API_KEY");
	});

	it("does not flag a server's own credential, which is what headers are for", () => {
		expect(leakedCredential("Bearer n-key-1234", env)).toBeUndefined();
	});

	it("does not treat a proxy address as a secret, so a local server on the same port still connects", () => {
		expect(leakedCredential("http://127.0.0.1:8080/mcp", { HTTP_PROXY: "http://127.0.0.1:8080" })).toBeUndefined();
	});

	it("ignores unset or trivially short values", () => {
		expect(leakedCredential("https://a/x", { ANTHROPIC_API_KEY: "x" })).toBeUndefined();
		expect(leakedCredential("https://a/", {})).toBeUndefined();
	});
});

describe("findResourceMentions", () => {
	it("finds @server:uri only for servers it is told about", () => {
		expect(findResourceMentions("look at @docs:file:///a.md and @someone:else", ["docs"])).toEqual([
			{ server: "docs", uri: "file:///a.md" },
		]);
	});

	it("dedupes, and ignores an @ inside a word like an email", () => {
		expect(findResourceMentions("@docs:x://1 again @docs:x://1 mail a@docs:x://2", ["docs"])).toEqual([
			{ server: "docs", uri: "x://1" },
		]);
	});

	it("drops trailing sentence punctuation from the uri", () => {
		expect(findResourceMentions("see @docs:x://1.", ["docs"])).toEqual([{ server: "docs", uri: "x://1" }]);
	});
});

async function connect(server: McpServer): Promise<Client> {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" });
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	return client;
}

type Execute = (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: unknown[] }>;

async function toolsOf(
	server: McpServer,
	timeouts: { total: number; idle: number },
): Promise<{ client: Client; run: (name: string) => Promise<{ content: unknown[] }> }> {
	const client = await connect(server);
	const tools = new Map<string, Execute>();
	const pi = {
		registerTool: (t: { name: string; execute: Execute }) => tools.set(t.name, t.execute),
	} as unknown as ExtensionAPI;
	await registerServerTools(pi, "s", client, timeouts);
	return { client, run: (name) => (tools.get(`mcp__s__${name}`) as Execute)("id", {}) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("tool call timeouts against a live server", () => {
	function slowServer(): McpServer {
		const server = new McpServer({ name: "s", version: "0" });
		server.registerTool("silent", { description: "sleeps" }, async () => {
			await sleep(400);
			return { content: [{ type: "text", text: "done" }] };
		});
		server.registerTool(
			"chatty",
			{ description: "sleeps with progress" },
			async (extra: {
				_meta?: { progressToken?: string | number };
				sendNotification: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
			}) => {
				const token = extra._meta?.progressToken;
				for (let i = 0; i < 8; i++) {
					await sleep(50);
					if (token !== undefined) {
						await extra.sendNotification({
							method: "notifications/progress",
							params: { progressToken: token, progress: i },
						});
					}
				}
				return { content: [{ type: "text", text: "done" }] };
			},
		);
		return server;
	}

	it("aborts a call that sends nothing for the idle window", async () => {
		const { client, run } = await toolsOf(slowServer(), { total: 10_000, idle: 100 });
		await expect(run("silent")).rejects.toThrow(/no response or progress for 100ms/);
		await client.close();
	});

	it("keeps a call alive while the server reports progress", async () => {
		const { client, run } = await toolsOf(slowServer(), { total: 10_000, idle: 150 });
		const result = await run("chatty");
		expect(result.content).toEqual([{ type: "text", text: "done" }]);
		await client.close();
	});

	it("still stops at the wall clock however much progress arrives", async () => {
		const { client, run } = await toolsOf(slowServer(), { total: 200, idle: 150 });
		await expect(run("chatty")).rejects.toThrow(/200ms/);
		await client.close();
	});
});

describe("resources against a live server", () => {
	function resourceServer(): McpServer {
		const server = new McpServer({ name: "s", version: "0" });
		server.registerResource(
			"readme",
			"docs://readme",
			{ description: "The readme", mimeType: "text/markdown" },
			() => ({
				contents: [{ uri: "docs://readme", mimeType: "text/markdown", text: "# Hello" }],
			}),
		);
		server.registerResource("logo", "docs://logo", { mimeType: "image/png" }, () => ({
			contents: [{ uri: "docs://logo", mimeType: "image/png", blob: "iVBORw0KGgo=" }],
		}));
		server.registerResource("archive", "docs://archive", { mimeType: "application/zip" }, () => ({
			contents: [{ uri: "docs://archive", mimeType: "application/zip", blob: "UEsDBA==" }],
		}));
		return server;
	}

	it("lists resources with their metadata", async () => {
		const client = await connect(resourceServer());
		const list = await listServerResources(client);
		expect(list.map((r) => r.uri)).toEqual(["docs://readme", "docs://logo", "docs://archive"]);
		expect(list[0]).toMatchObject({ name: "readme", description: "The readme", mimeType: "text/markdown" });
		await client.close();
	});

	it("returns nothing, without asking, from a server that has no resources", async () => {
		const server = new McpServer({ name: "s", version: "0" });
		server.registerTool("noop", { description: "noop" }, async () => ({ content: [] }));
		const client = await connect(server);
		expect(await listServerResources(client)).toEqual([]);
		await client.close();
	});

	it("reads text as text, an image blob as an image, and marks other binary content", async () => {
		const client = await connect(resourceServer());
		expect(await readServerResource(client, "s", "docs://readme")).toEqual([{ type: "text", text: "# Hello" }]);
		expect(await readServerResource(client, "s", "docs://logo")).toEqual([
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		]);
		const archive = await readServerResource(client, "s", "docs://archive");
		expect(archive).toEqual([
			{ type: "text", text: "[mcp: omitted binary resource docs://archive (application/zip)]" },
		]);
		await client.close();
	});
});
