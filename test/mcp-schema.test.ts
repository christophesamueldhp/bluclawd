import { describe, expect, it } from "vitest";
import { parseMcpConfig, transportKind } from "../ext/mcp/schema.ts";

describe("parseMcpConfig transport type", () => {
	it("keeps an explicit type so sse servers survive the parse", () => {
		const servers = parseMcpConfig({
			mcpServers: {
				remote: { type: "sse", url: "https://example.com/sse" },
			},
		});
		expect(servers.remote.type).toBe("sse");
	});

	it("keeps Claude Code's redundant type alongside command", () => {
		const servers = parseMcpConfig({
			mcpServers: {
				playwright: { type: "stdio", command: "npx", args: ["@playwright/mcp@latest"] },
			},
		});
		expect(servers.playwright.type).toBe("stdio");
		expect(servers.playwright.command).toBe("npx");
	});

	it("leaves type undefined when the config omits it, so inference still applies", () => {
		const servers = parseMcpConfig({
			mcpServers: { legacy: { command: "foo" } },
		});
		expect(servers.legacy.type).toBeUndefined();
	});

	it("drops a non-string type rather than trusting it downstream", () => {
		const servers = parseMcpConfig({
			mcpServers: { odd: { type: 7, url: "https://example.com/mcp" } },
		});
		expect(servers.odd.type).toBeUndefined();
	});
});

describe("transportKind", () => {
	it("infers stdio from command and http from url when type is absent", () => {
		expect(transportKind("a", { command: "npx" })).toBe("stdio");
		expect(transportKind("b", { url: "https://example.com/mcp" })).toBe("http");
	});

	it("selects the sse transport only when the config asks for it", () => {
		expect(transportKind("c", { type: "sse", url: "https://example.com/sse" })).toBe("sse");
		// Without the explicit type an sse endpoint is still treated as http: guessing
		// would double the handshake timeout on every misconfigured server.
		expect(transportKind("c", { url: "https://example.com/sse" })).toBe("http");
	});

	it("honours an explicit type that agrees with the fields", () => {
		expect(transportKind("d", { type: "stdio", command: "npx" })).toBe("stdio");
		expect(transportKind("e", { type: "http", url: "https://example.com/mcp" })).toBe("http");
	});

	it("rejects a type whose required field is missing", () => {
		expect(() => transportKind("f", { type: "sse", command: "npx" })).toThrow(/"url"/);
		expect(() => transportKind("g", { type: "stdio", url: "https://example.com/mcp" })).toThrow(/"command"/);
	});

	it("rejects an unknown type instead of silently falling back to inference", () => {
		expect(() => transportKind("h", { type: "websocket", url: "https://example.com" } as never)).toThrow(/websocket/);
	});

	it("still rejects a config that sets neither or both of command and url", () => {
		expect(() => transportKind("i", {})).toThrow(/exactly one/);
		expect(() => transportKind("j", { command: "npx", url: "https://example.com/mcp" })).toThrow(/exactly one/);
	});
});
