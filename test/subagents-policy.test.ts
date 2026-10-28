import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateSubagentDelegationDeny, evaluateToolCallDeny } from "../ext/permissions/policy.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-policy-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("Task 2 (M1) — Reusable read policy and Subagent deny rules", () => {
	it("evaluates Subagent and Subagent(agentName) deny rules before admission", () => {
		const cwd = "/proj";

		const blockAll = evaluateSubagentDelegationDeny(["Subagent"], "explorer", cwd);
		expect(blockAll.blocked).toBe(true);
		expect(blockAll.reason).toContain("Blocked by permission rule (deny): Subagent");

		const blockExplorer = evaluateSubagentDelegationDeny(["Subagent(explorer)"], "explorer", cwd);
		expect(blockExplorer.blocked).toBe(true);
		expect(blockExplorer.reason).toContain("Subagent(explorer)");

		const allowReviewer = evaluateSubagentDelegationDeny(["Subagent(explorer)"], "reviewer", cwd);
		expect(allowReviewer.blocked).toBe(false);

		const blockGlob = evaluateSubagentDelegationDeny(["Subagent(rev*)"], "reviewer", cwd);
		expect(blockGlob.blocked).toBe(true);
	});

	it("blocks denied direct reads across relative paths, absolute paths, and symlink escapes", () => {
		const cwd = makeTempDir("cwd");
		const outside = makeTempDir("outside");
		mkdirSync(join(cwd, "secrets"), { recursive: true });
		writeFileSync(join(cwd, ".env"), "SECRET=1\n", "utf8");
		writeFileSync(join(cwd, "secrets", "token.txt"), "TOKEN=abc\n", "utf8");
		writeFileSync(join(outside, "id_rsa"), "PRIVATE_KEY\n", "utf8");
		symlinkSync(join(outside, "id_rsa"), join(cwd, "linked_key"));

		const rules = ["Read(.env)", "Read(secrets/**)", `Read(${outside}/**)`];

		// Relative & normalized paths
		expect(evaluateToolCallDeny(rules, "read", { path: ".env" }, cwd)?.block).toBe(true);
		expect(evaluateToolCallDeny(rules, "read", { path: "./.env" }, cwd)?.block).toBe(true);
		expect(evaluateToolCallDeny(rules, "read", { path: "sub/../.env" }, cwd)?.block).toBe(true);
		expect(evaluateToolCallDeny(rules, "read", { path: "secrets/token.txt" }, cwd)?.block).toBe(true);

		// Absolute paths
		expect(evaluateToolCallDeny(rules, "read", { path: join(cwd, ".env") }, cwd)?.block).toBe(true);

		// Symlink escape to denied outside directory
		expect(evaluateToolCallDeny(rules, "read", { path: "linked_key" }, cwd)?.block).toBe(true);

		// Allowed file
		expect(evaluateToolCallDeny(rules, "read", { path: "README.md" }, cwd)).toBeUndefined();
	});
});
