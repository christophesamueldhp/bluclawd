import { describe, expect, it } from "vitest";
import { createSubagentPolicySnapshot } from "../ext/permissions/policy.ts";
import {
	createIsolatedSubagentPolicySnapshot,
	isValidIsolatedSubagentPolicySnapshot,
} from "../ext/subagents/execution-policy.ts";

describe("isolated policy snapshots", () => {
	it("copies and freezes explicit capabilities and deny rules without widening read-only policy", () => {
		const tools = ["read", "bash", "write"] as const;
		const denyRules = ["Read(**/.env)", "Bash(git push*)"];
		const result = createIsolatedSubagentPolicySnapshot({ cwd: "/project", denyRules, allowedTools: tools });
		expect(result.ok).toBe(true);
		const policy = result.snapshot!;
		denyRules.push("Read(**)");
		expect(policy.denyRules).toEqual(["Read(**/.env)", "Bash(git push*)"]);
		expect(policy.allowedTools).toEqual(["read", "bash", "write"]);
		expect(Object.isFrozen(policy)).toBe(true);
		expect(Object.isFrozen(policy.allowedTools)).toBe(true);
		expect(Object.isFrozen(policy.denyRules)).toBe(true);
		expect(isValidIsolatedSubagentPolicySnapshot(policy)).toBe(true);
		expect(isValidIsolatedSubagentPolicySnapshot(JSON.parse(JSON.stringify(policy)))).toBe(false);
		expect(createSubagentPolicySnapshot({ cwd: "/project", denyRules, allowedTools: tools as never }).ok).toBe(false);
	});

	it.each([
		{ cwd: "", allowedTools: ["bash"], denyRules: [] },
		{ cwd: "/project", allowedTools: [], denyRules: [] },
		{ cwd: "/project", allowedTools: ["read"], denyRules: [] },
		{ cwd: "/project", allowedTools: ["bash", "unknown"], denyRules: [] },
		{ cwd: "/project", allowedTools: ["bash"], denyRules: [null] },
		{ cwd: "/project", allowedTools: "bash", denyRules: [] },
	])("refuses malformed or shared-only policy: %j", (options) => {
		expect(createIsolatedSubagentPolicySnapshot(options as never).ok).toBe(false);
	});

	it("deduplicates an explicit editing tool selection", () => {
		const result = createIsolatedSubagentPolicySnapshot({
			cwd: "/project",
			denyRules: [],
			allowedTools: ["edit", "edit"],
		});
		expect(result.snapshot?.allowedTools).toEqual(["edit"]);
	});
});
