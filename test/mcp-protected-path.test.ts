import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProtectedPath, isReadProtectedPath } from "../ext/permissions/rules.ts";

const CWD = "/repo";
const AGENT = "/home/u/.pi/agent";
const CONFIG = ".pi";

const protectedWrite = (path: string) => isProtectedPath(path, CWD, AGENT, CONFIG);
const protectedRead = (path: string) => isReadProtectedPath(path, CWD, AGENT, CONFIG);

describe(".mcp.json is agent configuration, not ordinary project content", () => {
	it("gates writing the shared project MCP config", () => {
		// bluclawd spawns whatever `command` this file names, at session_start,
		// before any Mcp() rule could apply — so the write itself is the gate.
		expect(protectedWrite(join(CWD, ".mcp.json"))).toBe(true);
	});

	it("gates reading it, because it can hold a literal bearer token", () => {
		expect(protectedRead(join(CWD, ".mcp.json"))).toBe(true);
	});

	it("still leaves ordinary project files alone", () => {
		expect(protectedWrite(join(CWD, "src", "index.ts"))).toBe(false);
		expect(protectedWrite(join(CWD, "mcp.json.md"))).toBe(false);
		expect(protectedRead(join(CWD, "src", "index.ts"))).toBe(false);
	});

	it("keeps gating the config-dir copy it sits beside", () => {
		expect(protectedWrite(join(CWD, CONFIG, "mcp.json"))).toBe(true);
		expect(protectedRead(join(CWD, CONFIG, "mcp.json"))).toBe(true);
	});
});
