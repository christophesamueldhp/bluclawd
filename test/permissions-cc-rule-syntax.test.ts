/**
 * Claude Code rule spellings a user copies from its settings must mean the same here:
 * `Edit` covers Write, `Read` covers Grep/Find/Ls, `mcp__server[__tool]`, `Bash(x *)`
 * as a prefix, and `//abs` paths. Driven through the evaluator, as enforcement is.
 */
import { describe, expect, it } from "vitest";
import { type EvalConfig, evaluatePostHook, evaluatePreHook } from "../ext/permissions/evaluate.ts";
import { decide, parseRuleSpec } from "../ext/permissions/rules.ts";
import { sandboxListsFromRules } from "../ext/sandbox/config.ts";

const cwd = "/proj";

function cfg(over: Partial<EvalConfig> = {}): EvalConfig {
	return {
		mode: "auto",
		rules: {},
		cliAllowRules: {},
		cwd,
		agentDir: "/home/u/.pi/agent",
		configDirName: ".bluclawd",
		hasUI: true,
		...over,
	};
}

function verdict(tool: string, input: Record<string, unknown>, c: EvalConfig) {
	return evaluatePreHook(tool, input, c) ?? evaluatePostHook(tool, input, c);
}

describe("Edit rules cover the write tool", () => {
	it("deny: Edit(./x) blocks a write to ./x", () => {
		const v = verdict("write", { path: "./x" }, cfg({ rules: { deny: ["Edit(./x)"] } }));
		expect(v.outcome).toBe("block");
		expect(v.gate).toBe("deny-rule");
	});

	it("allow: Edit(src/**) runs a write under src in ask mode", () => {
		const c = cfg({ mode: "ask", rules: { allow: ["Edit(src/**)"] } });
		expect(verdict("write", { path: "src/a.ts" }, c).outcome).toBe("allow");
	});

	it("a Write rule still does not reach the edit tool", () => {
		expect(decide({ deny: ["Write(./x)"] }, "edit", { path: "./x" }, cwd)).toBeNull();
	});
});

describe("Read rules cover grep, find and ls", () => {
	it("deny: Read(.env) blocks a grep of .env", () => {
		expect(verdict("grep", { pattern: "KEY", path: ".env" }, cfg({ rules: { deny: ["Read(.env)"] } })).outcome).toBe(
			"block",
		);
	});

	it("deny: Read(secrets/**) blocks find and ls under it", () => {
		const c = cfg({ rules: { deny: ["Read(secrets/**)"] } });
		expect(verdict("find", { pattern: "*", path: "secrets/a" }, c).outcome).toBe("block");
		expect(verdict("ls", { path: "secrets/a" }, c).outcome).toBe("block");
	});
});

describe("mcp__ rule spellings", () => {
	it("mcp__server__* and bare mcp__server cover every tool of that server", () => {
		for (const rule of ["mcp__github__*", "mcp__github"]) {
			expect(verdict("mcp__github__get_me", {}, cfg({ rules: { deny: [rule] } })).outcome).toBe("block");
			expect(decide({ deny: [rule] }, "mcp__gitlab__get_me", {}, cwd)).toBeNull();
		}
	});

	it("mcp__server__tool names one tool", () => {
		const rules = { deny: ["mcp__github__get_me"] };
		expect(decide(rules, "mcp__github__get_me", {}, cwd)).toBe("deny");
		expect(decide(rules, "mcp__github__list_issues", {}, cwd)).toBeNull();
	});

	it("parses as a rule spec, so /permissions and the CLI flags accept it", () => {
		expect(parseRuleSpec("mcp__github__get_me")).toEqual({ tool: "mcp__github__get_me", input: {} });
		expect(parseRuleSpec("mcp__github")).toEqual({ tool: "mcp__github__*", input: {} });
	});
});

describe("Bash(cmd *) is the prefix form", () => {
	it("deny: Bash(rm *) blocks bare rm, and rm with arguments", () => {
		const c = cfg({ rules: { deny: ["Bash(rm *)"] } });
		expect(verdict("bash", { command: "rm" }, c).outcome).toBe("block");
		expect(verdict("bash", { command: "rm -rf build" }, c).outcome).toBe("block");
	});

	it("does not reach a longer command name", () => {
		expect(decide({ allow: ["Bash(ls *)"] }, "bash", { command: "lsof" }, cwd)).toBeNull();
		expect(decide({ allow: ["Bash(ls *)"] }, "bash", { command: "ls" }, cwd)).toBe("allow");
	});

	it("leaves `**` and an escaped `\\*` alone", () => {
		expect(decide({ allow: ["Bash(ls \\*)"] }, "bash", { command: "ls" }, cwd)).toBeNull();
		expect(decide({ allow: ["Bash(ls **)"] }, "bash", { command: "ls" }, cwd)).toBeNull();
	});
});

describe("//abs path rules", () => {
	it("match the absolute path", () => {
		expect(decide({ deny: ["Read(//etc/**)"] }, "read", { path: "/etc/hosts" }, cwd)).toBe("deny");
		expect(decide({ deny: ["Edit(//tmp/scratch.txt)"] }, "write", { path: "/tmp/scratch.txt" }, cwd)).toBe("deny");
	});

	it("reach the sandbox as the same absolute path", () => {
		const lists = sandboxListsFromRules({ deny: ["Edit(//tmp/x)", "Read(//etc/secret)"] }, cwd);
		expect(lists.denyWrite).toEqual(["/tmp/x"]);
		expect(lists.denyRead).toEqual(["/etc/secret"]);
	});
});
