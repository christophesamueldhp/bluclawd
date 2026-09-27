import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LendableMcpServer, publishMcpServers } from "../ext/_shared/mcp-lending.ts";
import { registerListedTools, registerServerTools } from "../ext/mcp/client.ts";
import { checkAsParent } from "../ext/permissions/subagent-gate.ts";
import { borrowMcpServers } from "../ext/subagents/child-mcp.ts";
import { parseDef, resolveChildTools } from "../ext/subagents/defs.ts";
import { childLoaderOptions, childToolPool, forgetResumableForTests, runSubagent } from "../ext/subagents/engine.ts";

const timeouts = { total: 10_000, idle: 0 };

async function connect(): Promise<Client> {
	const server = new McpServer({ name: "s", version: "0" });
	server.registerTool("one", { description: "says one" }, async () => ({ content: [{ type: "text", text: "one" }] }));
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" });
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	return client;
}

type Execute = (id: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
function fakePi() {
	const tools = new Map<string, Execute>();
	return {
		tools,
		pi: { registerTool: (t: { name: string; execute: Execute }) => tools.set(t.name, t.execute) } as any,
	};
}

const lendable = (over: Partial<LendableMcpServer> = {}): LendableMcpServer => ({
	name: "s",
	status: "connected",
	toolNames: ["mcp__s__one"],
	lend: () => {},
	...over,
});

afterEach(() => publishMcpServers(() => []));

describe("mcpServers frontmatter", () => {
	const def = (value: string) => parseDef(`---\nname: x\ndescription: d\nmcpServers: ${value}\n---\nbody\n`);

	it("names servers in either spelling, keeping their case", () => {
		expect(def("github, Docs")).toMatchObject({ mcpServers: ["github", "Docs"] });
		expect(def("[github]")).toMatchObject({ mcpServers: ["github"] });
	});

	it("drops an inline server, which would start a process no approval covers, and still loads the def", () => {
		const parsed = def("\n  - docs: { command: evil }\n  - github");
		expect(parsed).not.toHaveProperty("problem");
		expect(parsed).toMatchObject({ name: "x", mcpServers: ["github"] });
		expect(def("\n  - docs: { command: evil }")).not.toHaveProperty("mcpServers");
	});
});

describe("borrowing the parent's servers", () => {
	it("lends only connected servers, and says why another cannot be lent", () => {
		publishMcpServers(() => [lendable(), lendable({ name: "p", status: "needs-approval" })]);
		expect(borrowMcpServers(["s"])).toMatchObject({ servers: [{ name: "s" }] });
		expect(borrowMcpServers(["p"])).toMatchObject({ problem: expect.stringMatching(/"p".*needs-approval/) });
		expect(borrowMcpServers(["nope"])).toMatchObject({ problem: expect.stringMatching(/"nope".*not configured/) });
	});

	it("calls through the parent's client as it is at call time", async () => {
		const parent = fakePi();
		const first = await connect();
		const registered = await registerServerTools(parent.pi, "s", first, timeouts);
		let live: Client | undefined = first;

		const child = fakePi();
		registerListedTools(
			child.pi,
			"s",
			() => live,
			registered.map((t) => t.listed),
			timeouts,
		);
		const call = () => (child.tools.get("mcp__s__one") as Execute)("id", {});
		expect((await call()).content[0].text).toBe("one");

		await first.close();
		live = await connect();
		expect((await call()).content[0].text).toBe("one");
		live = undefined;
		await expect(call()).rejects.toThrow(/not connected/);
	});

	it("narrows the lent tools by the def's allowlist, as Claude Code does", () => {
		const pool = childToolPool({ canSpawn: false, mcpTools: ["mcp__s__one"] });
		expect(resolveChildTools({ tools: ["Read"] }, pool).tools).toEqual(["read"]);
		expect(resolveChildTools({ tools: ["Read", "mcp__s"] }, pool).tools).toEqual(["read", "mcp__s__one"]);
		expect(resolveChildTools({}, pool).tools).toContain("mcp__s__one");
	});

	it("loads the lent tools and the servers' instructions into the child", () => {
		const lent: string[] = [];
		const server = lendable({ instructions: "Use one wisely.", lend: () => lent.push("s") });
		const ctx = { cwd: process.cwd(), isProjectTrusted: () => false } as any;
		const def = { name: "w", description: "d", systemPrompt: "", source: "user", filePath: "/x/w.md" } as any;
		const options = childLoaderOptions(ctx, def, { mode: "auto", systemPrompt: "S", mcp: [server] });
		const ext = options.extensionFactories?.find((e: any) => e.name === "subagent-mcp") as any;
		ext.factory({ registerTool: () => {} });
		expect(lent).toEqual(["s"]);
		expect(options.appendSystemPrompt?.join("\n")).toContain("Use one wisely.");
		const without = childLoaderOptions(ctx, def, { mode: "auto", systemPrompt: "S" });
		expect(without.extensionFactories?.map((e: any) => e.name)).not.toContain("subagent-mcp");
		expect(without.appendSystemPrompt).toEqual([]);
	});

	it("keeps the parent's deny rules on a borrowed tool", async () => {
		const check = { mode: "auto" as const, rules: { deny: ["Mcp(s:one)"] }, cwd: process.cwd(), asker: "w" };
		expect(await checkAsParent("mcp__s__one", {}, check)).toBeTruthy();
		expect(await checkAsParent("mcp__s__two", {}, check)).toBeUndefined();
	});
});

describe("runSubagent with the parent's MCP servers", () => {
	let home: string;
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-mcp-home-"));
		saved = { HOME: process.env.HOME };
		for (const key of Object.keys(process.env)) {
			if (key.endsWith("_CODING_AGENT_DIR")) {
				saved[key] = process.env[key];
				delete process.env[key];
			}
		}
		process.env.HOME = home;
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		forgetResumableForTests();
		rmSync(home, { recursive: true, force: true });
	});

	const model = { provider: "p", id: "m", name: "m" } as any;
	const ctx = () =>
		({
			cwd: home,
			isProjectTrusted: () => true,
			model,
			modelRegistry: { find: () => model, getAll: () => [model] },
		}) as any;
	const def = (over: object = {}) =>
		({ name: "w", description: "d", systemPrompt: "", source: "user", filePath: "/x/w.md", ...over }) as any;

	function child() {
		let received: any;
		const messages: any[] = [];
		const session = {
			state: { messages },
			subscribe: () => () => {},
			abort: async () => {},
			dispose: () => {},
			getSessionStats: () => ({
				tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				cost: 0,
				assistantMessages: 0,
			}),
			async prompt() {
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					stopReason: "stop",
					timestamp: Date.now(),
				});
			},
		};
		return {
			received: () => received,
			create: async (o: any) => {
				received = o;
				return { session: session as any };
			},
		};
	}

	it("gives every child the tools of every connected server, and none of the others", async () => {
		publishMcpServers(() => [
			lendable(),
			lendable({ name: "p", status: "needs-approval", toolNames: ["mcp__p__x"] }),
		]);
		const c = child();
		const result = await runSubagent({ def: def(), task: "t", ctx: ctx(), createSession: c.create });
		expect(result.status).toBe("ok");
		expect(c.received().tools).toContain("mcp__s__one");
		expect(c.received().tools).not.toContain("mcp__p__x");
	});

	it("lets a def's tools and disallowedTools narrow a lent server", async () => {
		publishMcpServers(() => [lendable()]);
		const allow = child();
		await runSubagent({
			def: def({ tools: ["Read", "mcp__s"] }),
			task: "t",
			ctx: ctx(),
			createSession: allow.create,
		});
		expect(allow.received().tools).toEqual(["read", "mcp__s__one"]);
		const deny = child();
		await runSubagent({
			def: def({ mcpServers: ["s"], disallowedTools: ["mcp__s__one"] }),
			task: "t",
			ctx: ctx(),
			createSession: deny.create,
		});
		expect(deny.received().tools).not.toContain("mcp__s__one");
	});

	it("fails before starting when a server the def requires is not connected", async () => {
		publishMcpServers(() => [lendable({ status: "connecting" }), lendable({ name: "other" })]);
		const c = child();
		const pending = await runSubagent({
			def: def({ mcpServers: ["s"] }),
			task: "t",
			ctx: ctx(),
			createSession: c.create,
		});
		expect(pending.status).toBe("failed");
		expect(pending.errorMessage).toBe(
			"Agent 'w' requires MCP servers matching: s. MCP servers with tools: other. Use /mcp to configure and authenticate the required MCP servers.",
		);
		const missing = await runSubagent({
			def: def({ mcpServers: ["nope"] }),
			task: "t",
			ctx: ctx(),
			createSession: c.create,
		});
		expect(missing.errorMessage).toMatch(/requires MCP servers matching: nope/);
		expect(c.received()).toBeUndefined();
	});
});
