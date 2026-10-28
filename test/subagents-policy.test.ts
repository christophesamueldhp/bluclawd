import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createChildPolicyExtension,
	createSubagentPolicySnapshot,
	evaluateSubagentDelegationDeny,
	evaluateToolCallDeny,
	filterChildToolResult,
} from "../ext/permissions/policy.ts";

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

	it("fails closed when child policy snapshot is uninitialized or malformed", () => {
		expect(
			createSubagentPolicySnapshot({
				cwd: "",
				denyRules: [],
				allowedTools: ["read"],
			}).ok,
		).toBe(false);

		expect(
			createSubagentPolicySnapshot({
				cwd: "/proj",
				denyRules: ["Read(.env)", 42 as unknown as string],
				allowedTools: ["read"],
			}).ok,
		).toBe(false);

		expect(
			createSubagentPolicySnapshot({
				cwd: "/proj",
				denyRules: [],
				allowedTools: ["read", "bash" as any],
			}).ok,
		).toBe(false);

		expect(
			createSubagentPolicySnapshot({
				cwd: "/proj",
				denyRules: [],
				allowedTools: [],
			}).ok,
		).toBe(false);

		expect(() => createChildPolicyExtension(undefined as any)).toThrow(/policy snapshot/i);
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

	it("redacts denied paths from recursive grep, find, and ls results and clears structuredContent on redaction", () => {
		const cwd = makeTempDir("search");
		mkdirSync(join(cwd, "secrets"), { recursive: true });
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, ".env"), "API_KEY=123\n", "utf8");
		writeFileSync(join(cwd, "secrets", "key.pem"), "PEM\n", "utf8");
		writeFileSync(join(cwd, "src", "index.ts"), "export const ok = 1;\n", "utf8");

		const snapResult = createSubagentPolicySnapshot({
			cwd,
			denyRules: ["Read(**/.env*)", "Read(secrets/**)"],
			allowedTools: ["read", "grep", "find", "ls"],
		});
		expect(snapResult.ok).toBe(true);
		const snapshot = snapResult.snapshot!;

		// 1. Recursive grep filtering + structuredContent clearing
		const grepFiltered = filterChildToolResult(snapshot, {
			toolName: "grep",
			input: { pattern: "KEY" },
			content: [
				{
					type: "text",
					text: ".env:1: API_KEY=123\nsecrets/key.pem:1: PEM\nsrc/index.ts:1: export const ok = 1;",
				},
			],
			structuredContent: { matches: [".env", "secrets/key.pem", "src/index.ts"] },
			isError: false,
		});
		expect(grepFiltered).toBeDefined();
		expect(grepFiltered?.content).toEqual([{ type: "text", text: "src/index.ts:1: export const ok = 1;" }]);
		expect(grepFiltered?.structuredContent).toBeUndefined();

		// 2. Recursive find filtering
		const findFiltered = filterChildToolResult(snapshot, {
			toolName: "find",
			input: { pattern: "*" },
			content: [
				{
					type: "text",
					text: ".env\nsecrets/key.pem\nsrc/index.ts\n\n[1000 results limit reached]",
				},
			],
			isError: false,
		});
		expect(findFiltered).toEqual({
			content: [{ type: "text", text: "src/index.ts\n\n[1000 results limit reached]" }],
			structuredContent: undefined,
		});

		// 3. Directory ls filtering
		const lsFiltered = filterChildToolResult(snapshot, {
			toolName: "ls",
			input: {},
			content: [
				{
					type: "text",
					text: ".env\nsecrets/\nsrc/",
				},
			],
			isError: false,
		});
		expect(lsFiltered).toEqual({
			content: [{ type: "text", text: "src/" }],
			structuredContent: undefined,
		});
	});

	it("enforces intersection of capability ceiling, definition tools, and parent deny rules at execution time", async () => {
		const cwd = makeTempDir("exec-gate");
		const snapResult = createSubagentPolicySnapshot({
			cwd,
			denyRules: ["Read(secret.txt)"],
			allowedTools: ["read"], // grep/find/ls excluded by definition
		});
		expect(snapResult.ok).toBe(true);

		const handlers: Record<string, (event: any, ctx: any) => Promise<any>> = {};
		const ext = createChildPolicyExtension(snapResult.snapshot!);
		ext({
			on: (event: string, handler: any) => {
				handlers[event] = handler;
			},
		} as any);

		// Allowed tool on allowed path passes
		expect(await handlers.tool_call({ toolName: "read", input: { path: "public.txt" } }, { cwd })).toBeUndefined();

		// Allowed tool on denied path is blocked
		const deniedRead = await handlers.tool_call({ toolName: "read", input: { path: "secret.txt" } }, { cwd });
		expect(deniedRead?.block).toBe(true);

		// Read-only tool omitted from definition's `tools` (`grep`) is blocked at execution time
		const omittedTool = await handlers.tool_call({ toolName: "grep", input: { pattern: "x" } }, { cwd });
		expect(omittedTool?.block).toBe(true);
		expect(omittedTool?.reason).toContain('Tool "grep" is not permitted');

		// Forbidden tools (`bash`, `write`, `edit`, `subagent`, `codemode`, `mcp__x__y`) are blocked even if somehow invoked
		for (const forbidden of ["bash", "write", "edit", "subagent", "codemode", "mcp__srv__tool"]) {
			const res = await handlers.tool_call({ toolName: forbidden, input: {} }, { cwd });
			expect(res?.block, forbidden).toBe(true);
		}

		// Snapshot is frozen so task text or role instructions cannot mutate deny rules or allowedTools at runtime
		expect(Object.isFrozen(snapResult.snapshot)).toBe(true);
		expect(Object.isFrozen(snapResult.snapshot!.denyRules)).toBe(true);
		expect(Object.isFrozen(snapResult.snapshot!.allowedTools)).toBe(true);
	});
});
