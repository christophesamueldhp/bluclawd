import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { capContent, listServerPrompts, registerServerTools } from "../ext/mcp/client.ts";
import {
	formatServerInstructions,
	loadMcpConfig,
	parsePromptArgs,
	promptMessagesToText,
	setServerDisabled,
} from "../ext/mcp/schema.ts";

describe("formatServerInstructions", () => {
	it("returns nothing when no server supplied instructions", () => {
		expect(formatServerInstructions([])).toBeUndefined();
		expect(formatServerInstructions([{ name: "a", instructions: "  " }])).toBeUndefined();
	});

	it("gives each server its own heading under one section", () => {
		const text = formatServerInstructions([
			{ name: "github", instructions: "Use search first." },
			{ name: "docs", instructions: "Cite the page." },
		]);
		expect(text).toContain("# MCP Server Instructions");
		expect(text).toContain("## github\nUse search first.");
		expect(text).toContain("## docs\nCite the page.");
	});

	it("caps one server's instructions so a verbose server cannot fill the prompt", () => {
		const text = formatServerInstructions([{ name: "big", instructions: "x".repeat(10_000) }]) ?? "";
		expect(text.length).toBeLessThan(3_000);
		expect(text).toContain("[truncated]");
	});
});

describe("parsePromptArgs", () => {
	const defs = [{ name: "title", required: true }, { name: "priority" }];

	it("maps whitespace-separated positional words onto the declared arguments in order", () => {
		expect(parsePromptArgs("fix-login high", defs)).toEqual({ args: { title: "fix-login", priority: "high" } });
	});

	it("puts leftover words into the last argument rather than dropping them", () => {
		expect(parsePromptArgs("a b c", defs)).toEqual({ args: { title: "a", priority: "b c" } });
	});

	it("reports a missing required argument by name", () => {
		expect(parsePromptArgs("", defs)).toEqual({ error: "missing required argument: title" });
	});

	it("accepts no arguments for a prompt that declares none", () => {
		expect(parsePromptArgs("", undefined)).toEqual({ args: {} });
	});
});

describe("promptMessagesToText", () => {
	it("returns a single user message's text unchanged", () => {
		expect(promptMessagesToText([{ role: "user", content: { type: "text", text: "Review this" } }])).toBe(
			"Review this",
		);
	});

	it("keeps role markers when a prompt carries a conversation", () => {
		const text = promptMessagesToText([
			{ role: "user", content: { type: "text", text: "Q" } },
			{ role: "assistant", content: { type: "text", text: "A" } },
		]);
		expect(text).toBe("[user]\nQ\n\n[assistant]\nA");
	});

	it("inlines an embedded text resource and marks what it cannot carry", () => {
		const text = promptMessagesToText([
			{ role: "user", content: { type: "resource", resource: { uri: "file:///a.md", text: "body" } } },
			{ role: "user", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
		]);
		expect(text).toContain("body");
		expect(text).toContain("[mcp: omitted image content (image/png)]");
	});
});

describe("capContent", () => {
	it("passes a small result through untouched", () => {
		const content = [{ type: "text" as const, text: "ok" }];
		expect(capContent(content, "srv", "tool")).toEqual(content);
	});

	it("saves an oversized result to a file and tells the model where, instead of dropping the rest", () => {
		const full = `${"a".repeat(60_000)}TAIL`;
		const out = capContent([{ type: "text", text: full }], "srv", "tool");
		const note = out.at(-1);
		expect(note?.type).toBe("text");
		const match = /saved to (\S+)/.exec(note?.type === "text" ? note.text : "");
		expect(match).not.toBeNull();
		const path = match?.[1] ?? "";
		expect(readFileSync(path, "utf-8")).toBe(full);
		rmSync(path, { force: true });
	});
});

describe("MCP server round trip (in-memory)", () => {
	async function connect(server: McpServer): Promise<Client> {
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test", version: "0" });
		await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
		return client;
	}

	it("lists a server's prompts with their arguments", async () => {
		const server = new McpServer({ name: "s", version: "0" });
		server.registerPrompt("review", { description: "Review a PR", argsSchema: { pr: z.string() } }, ({ pr }) => ({
			messages: [{ role: "user", content: { type: "text", text: `review ${pr}` } }],
		}));
		const client = await connect(server);
		const prompts = await listServerPrompts(client);
		expect(prompts).toEqual([
			{ name: "review", description: "Review a PR", arguments: [{ name: "pr", required: true }] },
		]);
		await client.close();
	});

	it("returns no prompts for a server without the prompts capability, without asking it", async () => {
		const server = new McpServer({ name: "s", version: "0" });
		server.registerTool("noop", { description: "noop" }, async () => ({ content: [] }));
		const client = await connect(server);
		expect(await listServerPrompts(client)).toEqual([]);
		await client.close();
	});

	it("re-registering after a tool list change reports the new set", async () => {
		const server = new McpServer({ name: "s", version: "0" });
		server.registerTool("one", { description: "first" }, async () => ({ content: [] }));
		const client = await connect(server);
		const registered: string[] = [];
		const pi = { registerTool: (t: { name: string }) => registered.push(t.name) } as unknown as ExtensionAPI;
		expect((await registerServerTools(pi, "s", client)).map((t) => t.name)).toEqual(["mcp__s__one"]);
		server.registerTool("two", { description: "second" }, async () => ({ content: [] }));
		expect((await registerServerTools(pi, "s", client)).map((t) => t.name)).toEqual(["mcp__s__one", "mcp__s__two"]);
		await client.close();
	});
});

describe("disabling a project server leaves the committed file alone", () => {
	let home: string;
	let cwd: string;
	let saved: Record<string, string | undefined>;
	const ctx = () => ({ cwd, isProjectTrusted: () => true }) as unknown as ExtensionContext;
	const settingsPath = () => join(home, ".pi", "agent", "settings.json");

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-mcp-home-"));
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-mcp-cwd-"));
		saved = { HOME: process.env.HOME };
		for (const key of Object.keys(process.env)) {
			if (key.endsWith("_CODING_AGENT_DIR")) {
				saved[key] = process.env[key];
				delete process.env[key];
			}
		}
		process.env.HOME = home;
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("applies a per-project override recorded in the global settings", () => {
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { team: { command: "npx" } } }));
		writeFileSync(settingsPath(), JSON.stringify({ mcp: { disabledProjectServers: { [cwd]: { team: true } } } }));
		expect(loadMcpConfig(ctx()).team.disabled).toBe(true);
	});

	it("lets an override re-enable a server the file itself disables", () => {
		writeFileSync(
			join(cwd, ".mcp.json"),
			JSON.stringify({ mcpServers: { team: { command: "npx", disabled: true } } }),
		);
		writeFileSync(settingsPath(), JSON.stringify({ mcp: { disabledProjectServers: { [cwd]: { team: false } } } }));
		expect(loadMcpConfig(ctx()).team.disabled).toBe(false);
	});

	it("never applies another project's override, nor one to a global server", () => {
		writeFileSync(join(home, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: { mine: { command: "x" } } }));
		writeFileSync(
			settingsPath(),
			JSON.stringify({ mcp: { disabledProjectServers: { "/elsewhere": { mine: true }, [cwd]: { mine: true } } } }),
		);
		expect(loadMcpConfig(ctx()).mine.disabled).toBeUndefined();
	});

	it("still edits the user's own global mcp.json for a global server", () => {
		const file = join(home, ".pi", "agent", "mcp.json");
		writeFileSync(file, JSON.stringify({ mcpServers: { mine: { command: "x" } } }));
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { mine: { command: "project" } } }));
		expect(setServerDisabled("mine", true)).toEqual({ file });
		expect(JSON.parse(readFileSync(file, "utf-8")).mcpServers.mine.disabled).toBe(true);
		expect(existsSync(join(cwd, ".mcp.json"))).toBe(true);
		expect(JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf-8")).mcpServers.mine.disabled).toBeUndefined();
	});
});
