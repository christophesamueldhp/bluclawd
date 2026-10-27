import childProcess from "node:child_process";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentPolicySnapshot } from "../ext/permissions/policy.ts";
import * as executionPolicy from "../ext/subagents/execution-policy.ts";

const unavailable = "Isolated subagents unavailable: sandbox runtime lacks required Mach-lookup denial support.";
const probeConfig = () => ({
	network: {
		allowedDomains: [],
		deniedDomains: [],
		denyMachLookup: ["com.apple.securityd.xpc", "com.apple.SecurityServer"],
	},
	filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
});
function accepted() {
	const parsed = SandboxRuntimeConfigSchema.safeParse(probeConfig());
	if (!parsed.success) throw new Error("Installed public schema must support the approved artifact.");
	return parsed;
}
function rejectProcessWork() {
	return ["spawn", "spawnSync", "execFile", "execFileSync"].map((method) =>
		vi.spyOn(childProcess, method as "spawn").mockImplementation(() => {
			throw new Error("Preflight must not start a process.");
		}),
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isolated Mach runtime schema preflight", () => {
	it("accepts actual public-schema retention without process work or a native-support claim", () => {
		const processes = rejectProcessWork();
		expect(() => executionPolicy.assertNativeMachLookupDenialSupport()).not.toThrow();
		for (const process of processes) expect(process).not.toHaveBeenCalled();
	});

	it("refuses an old schema that strips the required denial array", () => {
		const parsed = accepted();
		Reflect.deleteProperty(parsed.data.network, "denyMachLookup");
		vi.spyOn(SandboxRuntimeConfigSchema, "safeParse").mockReturnValue(parsed);
		const processes = rejectProcessWork();
		expect(() => executionPolicy.assertNativeMachLookupDenialSupport()).toThrow(unavailable);
		for (const process of processes) expect(process).not.toHaveBeenCalled();
	});

	it("refuses a schema rejecting the required config", () => {
		const rejected = SandboxRuntimeConfigSchema.safeParse({});
		expect(rejected.success).toBe(false);
		vi.spyOn(SandboxRuntimeConfigSchema, "safeParse").mockReturnValue(rejected);
		expect(() => executionPolicy.assertNativeMachLookupDenialSupport()).toThrow(unavailable);
	});

	it("normalizes a broken schema exception to the bounded unavailable error", () => {
		vi.spyOn(SandboxRuntimeConfigSchema, "safeParse").mockImplementation(() => {
			throw new Error("Internal schema failure must not escape.");
		});
		expect(() => executionPolicy.assertNativeMachLookupDenialSupport()).toThrow(unavailable);
	});

	it.each([
		{ names: [] },
		{ names: ["com.apple.securityd.xpc"] },
		{ names: ["com.apple.SecurityServer", "com.apple.securityd.xpc"] },
		{ names: ["com.apple.securityd.xpc", "com.apple.SecurityServer", "com.example.extra"] },
		{ names: ["com.apple.securityd.xpc", "com.apple.securityd.xpc"] },
	])("refuses modified required arrays: %j", ({ names }) => {
		const parsed = accepted();
		parsed.data.network.denyMachLookup = names;
		vi.spyOn(SandboxRuntimeConfigSchema, "safeParse").mockReturnValue(parsed);
		expect(() => executionPolicy.assertNativeMachLookupDenialSupport()).toThrow(unavailable);
	});

	it("refuses sparse arrays instead of accepting their unvisited empty slots", () => {
		const parsed = accepted();
		parsed.data.network.denyMachLookup = new Array<string>(2);
		vi.spyOn(SandboxRuntimeConfigSchema, "safeParse").mockReturnValue(parsed);
		expect(() => executionPolicy.assertNativeMachLookupDenialSupport()).toThrow(unavailable);
	});

	it("refuses malformed schema output without exposing its shape as an internal error", () => {
		const parsed = accepted();
		Reflect.deleteProperty(parsed.data, "network");
		vi.spyOn(SandboxRuntimeConfigSchema, "safeParse").mockReturnValue(parsed);
		expect(() => executionPolicy.assertNativeMachLookupDenialSupport()).toThrow(unavailable);
	});

	it("checks required names anew and never lets a schema mutate the fixed policy", () => {
		const actual = SandboxRuntimeConfigSchema.safeParse.bind(SandboxRuntimeConfigSchema);
		const schema = vi.spyOn(SandboxRuntimeConfigSchema, "safeParse").mockImplementationOnce((input) => {
			Reflect.get(input as object, "network").denyMachLookup.splice(0);
			return actual(input);
		});
		expect(() => executionPolicy.assertNativeMachLookupDenialSupport()).toThrow(unavailable);
		schema.mockRestore();
		expect(() => executionPolicy.assertNativeMachLookupDenialSupport()).not.toThrow();
	});

	it("refuses missing support before touching workspace paths", () => {
		const rejected = SandboxRuntimeConfigSchema.safeParse({});
		vi.spyOn(SandboxRuntimeConfigSchema, "safeParse").mockReturnValue(rejected);
		const policy = executionPolicy.createIsolatedSubagentPolicySnapshot({
			cwd: "/project",
			denyRules: [],
			allowedTools: ["bash"],
		}).snapshot!;
		let workspaceReads = 0;
		const workspace = {
			get root() {
				workspaceReads++;
				throw new Error("Workspace touched before schema preflight.");
			},
		};
		expect(() => executionPolicy.buildExecutionSandboxConfig(policy, workspace as never, [])).toThrow(unavailable);
		expect(workspaceReads).toBe(0);
	});

	it("validates policy authority before querying runtime support", () => {
		const schema = vi.spyOn(SandboxRuntimeConfigSchema, "safeParse");
		expect(() => executionPolicy.buildExecutionSandboxConfig({} as never, {} as never, [])).toThrow(
			"Invalid isolated execution policy",
		);
		expect(schema).not.toHaveBeenCalled();
	});

	it("imports lazily and preserves legacy readers even with a rejecting old schema", async () => {
		vi.resetModules();
		const schema = vi.spyOn(SandboxRuntimeConfigSchema, "safeParse").mockImplementation(() => {
			throw new Error("Legacy paths must not query native runtime capability.");
		});
		const processes = rejectProcessWork();
		const policy = await import("../ext/subagents/execution-policy.ts");
		expect(
			policy.createIsolatedSubagentPolicySnapshot({ cwd: "/project", denyRules: [], allowedTools: ["bash"] }).ok,
		).toBe(true);
		expect(
			createSubagentPolicySnapshot({ cwd: "/project", denyRules: [], allowedTools: ["read", "grep", "find", "ls"] })
				.ok,
		).toBe(true);
		expect(schema).not.toHaveBeenCalled();
		for (const process of processes) expect(process).not.toHaveBeenCalled();
	});
});
