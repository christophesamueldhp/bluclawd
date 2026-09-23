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
import { parseDef } from "../ext/subagents/defs.ts";
import { childLoaderOptions, childToolLists, runSubagent } from "../ext/subagents/engine.ts";

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

	it("refuses an inline server: it would start a process no approval covers", () => {
		expect(def("\n  - docs: { command: evil }")).toMatchObject({ problem: expect.stringMatching(/mcp\.json/) });
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

	it("puts the tools past an allowlist, which would otherwise hide them", () => {
		const def = {
			name: "w",
			description: "d",
			systemPrompt: "",
			source: "user",
			filePath: "/x",
			tools: ["read"],
		} as any;
		expect(childToolLists(def, false, false, ["mcp__s__one"]).tools).toEqual(["read", "mcp__s__one"]);
		expect(childToolLists({ ...def, tools: undefined }, false, false, ["mcp__s__one"]).tools).toBeUndefined();
	});

	it("loads the lent tools and the servers' instructions into the child", () => {
		const lent: string[] = [];
		const server = lendable({ instructions: "Use one wisely.", lend: () => lent.push("s") });
		const ctx = { cwd: process.cwd(), isProjectTrusted: () => false } as any;
		const def = { name: "w", description: "d", systemPrompt: "", source: "user", filePath: "/x/w.md" } as any;
		const options = childLoaderOptions(ctx, def, { mode: "auto", mcp: [server] });
		const ext = options.extensionFactories.find((e: any) => e.name === "subagent-mcp") as any;
		ext.factory({ registerTool: () => {} });
		expect(lent).toEqual(["s"]);
		expect(options.appendSystemPrompt?.join("\n")).toContain("Use one wisely.");
		const without = childLoaderOptions(ctx, def, { mode: "auto" });
		expect(without.extensionFactories.map((e: any) => e.name)).not.toContain("subagent-mcp");
	});

	it("keeps the parent's deny rules on a borrowed tool", async () => {
		const check = { mode: "auto" as const, rules: { deny: ["Mcp(s:one)"] }, cwd: process.cwd(), asker: "w" };
		expect(await checkAsParent("mcp__s__one", {}, check)).toBeTruthy();
		expect(await checkAsParent("mcp__s__two", {}, check)).toBeUndefined();
	});
});

describe("runSubagent with mcpServers", () => {
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
		rmSync(home, { recursive: true, force: true });
	});

	const model = { provider: "p", id: "m" } as any;
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
			sessionId: "c",
			subscribe: () => () => {},
			abort: async () => {},
			dispose: () => {},
			getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
			async prompt() {
				messages.push({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" });
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

	it("gives the child the server's tools, past its allowlist", async () => {
		publishMcpServers(() => [lendable()]);
		const c = child();
		const result = await runSubagent({
			def: def({ tools: ["read"], mcpServers: ["s"] }),
			task: "t",
			ctx: ctx(),
			createSession: c.create,
		});
		expect(result.status).toBe("ok");
		expect(c.received().tools).toEqual(["read", "mcp__s__one"]);
	});

	it("still lets disallowedTools narrow a lent server, since pi's exclusions beat its allowlist", async () => {
		publishMcpServers(() => [lendable()]);
		const c = child();
		await runSubagent({
			def: def({ tools: ["read"], mcpServers: ["s"], disallowedTools: ["mcp__s__one"] }),
			task: "t",
			ctx: ctx(),
			createSession: c.create,
		});
		expect(c.received().excludeTools).toContain("mcp__s__one");
	});

	it("fails before starting when a server cannot be lent, or the agent is an external runner", async () => {
		publishMcpServers(() => [lendable({ status: "connecting" })]);
		const c = child();
		const pending = await runSubagent({
			def: def({ mcpServers: ["s"] }),
			task: "t",
			ctx: ctx(),
			createSession: c.create,
		});
		expect(pending.status).toBe("failed");
		expect(pending.errorMessage).toMatch(/connecting/);

		publishMcpServers(() => [lendable()]);
		const runner = await runSubagent({
			def: def({ mcpServers: ["s"], runner: { command: "cat", args: [] } }),
			task: "t",
			ctx: ctx(),
			createSession: c.create,
		});
		expect(runner.status).toBe("failed");
		expect(runner.errorMessage).toMatch(/MCP/);
		expect(c.received()).toBeUndefined();
	});
});
