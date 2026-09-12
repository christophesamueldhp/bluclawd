import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	approvalsForProject,
	enableAllProjectServers,
	loadMcpConfig,
	needsApproval,
	partitionByApproval,
	type ServerConfig,
	serverFingerprint,
} from "../ext/mcp/schema.ts";

describe("serverFingerprint", () => {
	it("is stable across key order, so re-serialising a config does not force re-approval", () => {
		const a: ServerConfig = { command: "npx", args: ["x"], env: { A: "1", B: "2" } };
		const b: ServerConfig = { env: { B: "2", A: "1" }, args: ["x"], command: "npx" };
		expect(serverFingerprint(a)).toBe(serverFingerprint(b));
	});

	it("changes when anything that decides what runs changes", () => {
		const base: ServerConfig = { command: "npx", args: ["a"], env: { K: "1" } };
		const fingerprint = serverFingerprint(base);
		expect(serverFingerprint({ ...base, command: "node" })).not.toBe(fingerprint);
		expect(serverFingerprint({ ...base, args: ["b"] })).not.toBe(fingerprint);
		expect(serverFingerprint({ ...base, args: ["a", "--extra"] })).not.toBe(fingerprint);
		expect(serverFingerprint({ ...base, env: { K: "2" } })).not.toBe(fingerprint);
	});

	it("changes when the endpoint or the credentials sent to it change", () => {
		const base: ServerConfig = { url: "https://a.example.com/mcp", headers: { Authorization: "Bearer $A" } };
		const fingerprint = serverFingerprint(base);
		expect(serverFingerprint({ ...base, url: "https://evil.example.com/mcp" })).not.toBe(fingerprint);
		expect(serverFingerprint({ ...base, headers: { Authorization: "Bearer $B" } })).not.toBe(fingerprint);
		expect(serverFingerprint({ ...base, type: "sse" })).not.toBe(fingerprint);
	});

	it("ignores presentation-only fields, which cannot change what executes", () => {
		const base: ServerConfig = { command: "npx", args: ["a"] };
		const fingerprint = serverFingerprint(base);
		expect(serverFingerprint({ ...base, deferTools: true })).toBe(fingerprint);
		expect(serverFingerprint({ ...base, disabled: true })).toBe(fingerprint);
		// `source` is ours, not the file's — it must never move the fingerprint.
		expect(serverFingerprint({ ...base, source: "project" })).toBe(fingerprint);
	});

	it("does not collide when a value's text shifts between neighbouring fields", () => {
		expect(serverFingerprint({ command: "ab", args: [] })).not.toBe(serverFingerprint({ command: "a", args: ["b"] }));
	});
});

describe("needsApproval", () => {
	const project: ServerConfig = { command: "npx", args: ["evil"], source: "project" };

	it("never gates a server the user configured globally", () => {
		expect(needsApproval("playwright", { ...project, source: "global" }, {}, false)).toBe(false);
	});

	it("gates a project server that has never been approved", () => {
		expect(needsApproval("playwright", project, {}, false)).toBe(true);
	});

	it("lets through a project server whose exact config was approved", () => {
		expect(needsApproval("playwright", project, { playwright: serverFingerprint(project) }, false)).toBe(false);
	});

	it("re-gates an approved server whose command was changed afterwards", () => {
		const approvals = { playwright: serverFingerprint(project) };
		const swapped: ServerConfig = { ...project, args: ["something-else"] };
		expect(needsApproval("playwright", swapped, approvals, false)).toBe(true);
	});

	it("does not let an approval for one server vouch for a different name", () => {
		const approvals = { playwright: serverFingerprint(project) };
		expect(needsApproval("other", project, approvals, false)).toBe(true);
	});

	it("honours the global opt-out for people who accept the risk", () => {
		expect(needsApproval("playwright", project, {}, true)).toBe(false);
	});
});

describe("partitionByApproval", () => {
	// Every path that reaches a transport goes through this, not just session_start:
	// /mcp reconnect, /mcp enable after a disable, and /mcp login all re-drive a
	// connection, and each one would otherwise start a server the user never approved.
	const conn = (name: string, config: ServerConfig) => ({ name, config });
	const globalServer = conn("safe", { command: "npx", source: "global" as const });
	const projectServer = conn("repo", { command: "evil", source: "project" as const });

	it("holds back an unapproved project server while letting the rest through", () => {
		const { allowed, gated } = partitionByApproval([globalServer, projectServer], {}, false);
		expect(allowed.map((c) => c.name)).toEqual(["safe"]);
		expect(gated.map((c) => c.name)).toEqual(["repo"]);
	});

	it("lets an approved project server through", () => {
		const approvals = { repo: serverFingerprint(projectServer.config) };
		const { allowed, gated } = partitionByApproval([projectServer], approvals, false);
		expect(allowed.map((c) => c.name)).toEqual(["repo"]);
		expect(gated).toEqual([]);
	});

	it("lets everything through under the global opt-out", () => {
		const { gated } = partitionByApproval([projectServer], {}, true);
		expect(gated).toEqual([]);
	});
});

describe("loadMcpConfig sources", () => {
	let home: string;
	let cwd: string;
	let saved: Record<string, string | undefined>;

	const ctxFor = (trusted: boolean) => ({ cwd, isProjectTrusted: () => trusted }) as unknown as ExtensionContext;
	const write = (path: string, servers: Record<string, unknown>) => {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify({ mcpServers: servers }));
	};

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

	it("reads a project .mcp.json, the convention repos actually commit", () => {
		write(join(cwd, ".mcp.json"), { shared: { command: "npx" } });
		const servers = loadMcpConfig(ctxFor(true));
		expect(servers.shared).toBeDefined();
		expect(servers.shared.source).toBe("project");
	});

	it("tags the global file as global so it is never gated", () => {
		write(join(home, ".pi", "agent", "mcp.json"), { mine: { command: "npx" } });
		expect(loadMcpConfig(ctxFor(true)).mine.source).toBe("global");
	});

	it("lets the pi-specific project file override the shared one", () => {
		write(join(cwd, ".mcp.json"), { dup: { command: "shared" } });
		write(join(cwd, ".pi", "mcp.json"), { dup: { command: "pi-specific" } });
		expect(loadMcpConfig(ctxFor(true)).dup.command).toBe("pi-specific");
	});

	it("lets a project file override the global one, but the entry stays project-sourced", () => {
		write(join(home, ".pi", "agent", "mcp.json"), { dup: { command: "global" } });
		write(join(cwd, ".mcp.json"), { dup: { command: "project" } });
		const server = loadMcpConfig(ctxFor(true)).dup;
		expect(server.command).toBe("project");
		expect(server.source).toBe("project");
	});

	it("ignores both project files entirely when the project is not trusted", () => {
		write(join(cwd, ".mcp.json"), { shared: { command: "npx" } });
		write(join(cwd, ".pi", "mcp.json"), { pi: { command: "npx" } });
		expect(Object.keys(loadMcpConfig(ctxFor(false)))).toEqual([]);
	});

	it("refuses a file-supplied source, which would otherwise buy a repo its way past the gate", () => {
		write(join(cwd, ".mcp.json"), { sneaky: { command: "npx", source: "global" } });
		expect(loadMcpConfig(ctxFor(true)).sneaky.source).toBe("project");
	});
});

describe("approvalsForProject", () => {
	let home: string;
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-mcp-appr-"));
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
	});

	const writeSettings = (value: unknown) =>
		writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify(value));

	it("reads the approvals recorded for this project only", () => {
		writeSettings({
			mcp: {
				approvedProjectServers: {
					"/a": { one: "fp-one" },
					"/b": { two: "fp-two" },
				},
			},
		});
		expect(approvalsForProject("/a")).toEqual({ one: "fp-one" });
		expect(approvalsForProject("/c")).toEqual({});
	});

	it("reads the opt-out only as a real boolean true", () => {
		expect(enableAllProjectServers()).toBe(false);
		writeSettings({ mcp: { enableAllProjectMcpServers: true } });
		expect(enableAllProjectServers()).toBe(true);
		// A truthy string must not disable the gate.
		writeSettings({ mcp: { enableAllProjectMcpServers: "true" } });
		expect(enableAllProjectServers()).toBe(false);
	});

	it("treats a missing or malformed settings file as no approvals, never as blanket approval", () => {
		expect(approvalsForProject("/a")).toEqual({});
		writeFileSync(join(home, ".pi", "agent", "settings.json"), "{ not json");
		expect(approvalsForProject("/a")).toEqual({});
		writeSettings({ mcp: { approvedProjectServers: "nonsense" } });
		expect(approvalsForProject("/a")).toEqual({});
	});
});
