import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildExecutionSandboxConfig } from "../ext/subagents/execution-policy.ts";
import { createExecutionFixture, nativeExecutionCandidate } from "./helpers/subagent-execution-fixture.ts";

const fixtures: Awaited<ReturnType<typeof createExecutionFixture>>[] = [];
afterEach(async () => {
	for (const f of fixtures.splice(0)) await f.cleanup();
});
async function fixture() {
	const f = await createExecutionFixture();
	fixtures.push(f);
	return f;
}

describe.skipIf(!nativeExecutionCandidate)("native execution sandbox configuration", () => {
	it("confines writes to the workspace/scratch while retaining private Git as read-only", async () => {
		const f = await fixture();
		const config = buildExecutionSandboxConfig(f.policy, f.workspace, f.runtimeReadPaths);
		expect(config.filesystem.allowWrite).toEqual([
			{ path: f.workspace.root, literal: true },
			{ path: f.workspace.scratchDir, literal: true },
		]);
		expect(config.filesystem.denyWrite).toContainEqual({ path: f.workspace.gitDir, literal: true });
		expect(config.network.allowedDomains).toEqual([]);
		expect(config.network.strictAllowlist).toBe(true);
		expect(config.network.allowAllUnixSockets).toBe(false);
		expect(config.network.denyMachLookup).toEqual(["com.apple.securityd.xpc", "com.apple.SecurityServer"]);
	});

	it("keeps required broker denials independent of returned config mutations", async () => {
		const f = await fixture();
		const config = buildExecutionSandboxConfig(f.policy, f.workspace, f.runtimeReadPaths);
		config.network.denyMachLookup?.splice(0);
		expect(buildExecutionSandboxConfig(f.policy, f.workspace, f.runtimeReadPaths).network.denyMachLookup).toEqual([
			"com.apple.securityd.xpc",
			"com.apple.SecurityServer",
		]);
	});

	it("refuses serialized policy references before constructing an executable policy", async () => {
		const f = await fixture();
		expect(() => buildExecutionSandboxConfig({ ...f.policy }, f.workspace, f.runtimeReadPaths)).toThrow();
	});

	it("refuses runtime roots exposing parent, other runs or compiler/control storage", async () => {
		const f = await fixture();
		for (const unsafe of [
			"/",
			f.f.parentCwd,
			f.f.stateDir,
			dirname(f.workspace.root),
			f.sibling.root,
			join(f.f.stateDir, "bluclawd", "subagents", "parent", "native"),
		]) {
			expect(() => buildExecutionSandboxConfig(f.policy, f.workspace, [...f.runtimeReadPaths, unsafe])).toThrow();
		}
	});

	it("refuses a source checkout presented as the private workspace", async () => {
		const f = await fixture();
		expect(() =>
			buildExecutionSandboxConfig(
				f.policy,
				{
					...f.workspace,
					root: f.f.parentCwd,
					gitDir: join(f.f.parentCwd, ".git"),
					executionCwd: f.f.parentCwd,
				},
				f.runtimeReadPaths,
			),
		).toThrow();
	});

	it("refuses a workspace cwd outside the private checkout", async () => {
		const f = await fixture();
		expect(() =>
			buildExecutionSandboxConfig(f.policy, { ...f.workspace, executionCwd: f.f.parentCwd }, f.runtimeReadPaths),
		).toThrow();
	});
});
