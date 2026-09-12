import { describe, expect, it } from "vitest";
import { type EvalConfig, evaluatePostHook, evaluatePreHook } from "../ext/permissions/evaluate.ts";
import type { PermissionMode } from "../ext/permissions/modes.ts";
import type { Rules } from "../ext/permissions/rules.ts";

/**
 * The sandbox gates of evaluate.ts — Claude Code's auto-allow mode and the
 * unsandboxed retry — which the characterization table never reaches (it runs
 * with no sandbox posture at all).
 */
function cfg(over: Partial<EvalConfig> & { sandbox?: EvalConfig["sandbox"] }): EvalConfig {
	return {
		mode: "ask",
		rules: {},
		cliAllowRules: {},
		cwd: "/p",
		agentDir: "/a",
		configDirName: ".bluclawd",
		hasUI: true,
		...over,
	};
}

const active = (over: Partial<NonNullable<EvalConfig["sandbox"]>> = {}): EvalConfig["sandbox"] => ({
	active: true,
	autoAllowBashIfSandboxed: true,
	allowUnsandboxedCommands: true,
	isExcluded: (command) => command.startsWith("docker"),
	...over,
});

const verdict = (tool: string, input: Record<string, unknown>, c: EvalConfig) =>
	evaluatePreHook(tool, input, c) ?? evaluatePostHook(tool, input, c);

const MUTATING = { command: "npm install" };

describe("auto-allow: a sandboxed command runs without a prompt", () => {
	it.each<PermissionMode>(["ask", "edits", "auto"])("in %s mode", (mode) => {
		const v = verdict("bash", MUTATING, cfg({ mode, sandbox: active() }));
		expect(v).toMatchObject({ outcome: "allow", gate: "sandboxed" });
	});

	it("covers the monitor tool too — same shell, same sandbox", () => {
		expect(verdict("monitor", MUTATING, cfg({ sandbox: active() })).gate).toBe("sandboxed");
	});

	it("still prompts without a UI-less exception: headless stays allowed (nothing to ask)", () => {
		expect(verdict("bash", MUTATING, cfg({ hasUI: false, sandbox: active() })).outcome).toBe("allow");
	});

	it("does not apply while the sandbox is inactive, or when the extension is absent", () => {
		expect(verdict("bash", MUTATING, cfg({ sandbox: active({ active: false }) })).outcome).toBe("prompt");
		expect(verdict("bash", MUTATING, cfg({})).outcome).toBe("prompt");
	});

	it("is switched off by autoAllowBashIfSandboxed: false (regular permissions mode)", () => {
		const v = verdict("bash", MUTATING, cfg({ sandbox: active({ autoAllowBashIfSandboxed: false }) }));
		expect(v).toMatchObject({ outcome: "prompt", gate: "no-matching-rule" });
	});

	it("does not cover an excluded command — that one runs outside the sandbox", () => {
		const v = verdict("bash", { command: "docker ps" }, cfg({ sandbox: active() }));
		expect(v).toMatchObject({ outcome: "prompt", gate: "no-matching-rule" });
	});

	it("never overrides a deny rule", () => {
		const rules: Rules = { deny: ["Bash(npm install*)"] };
		expect(verdict("bash", MUTATING, cfg({ rules, sandbox: active() })).outcome).toBe("block");
	});

	it("skips a bare Bash ask rule but honours a content-scoped one", () => {
		expect(verdict("bash", MUTATING, cfg({ rules: { ask: ["Bash(*)"] }, sandbox: active() })).gate).toBe("sandboxed");
		expect(verdict("bash", MUTATING, cfg({ rules: { ask: ["Bash"] }, sandbox: active() })).gate).toBe("sandboxed");
		const scoped = verdict(
			"bash",
			{ command: "git push origin main" },
			cfg({ rules: { ask: ["Bash(git push *)"] }, sandbox: active() }),
		);
		expect(scoped).toMatchObject({ outcome: "prompt", gate: "ask-rule" });
	});

	it("never touches non-bash tools", () => {
		expect(verdict("write", { path: "x.ts", content: "" }, cfg({ sandbox: active() })).outcome).toBe("prompt");
	});
});

describe("the unsandboxed retry (dangerouslyDisableSandbox)", () => {
	const RETRY = { command: "npm install", dangerouslyDisableSandbox: true };

	it("goes through the regular flow and names itself in the prompt", () => {
		const v = verdict("bash", RETRY, cfg({ sandbox: active() }));
		expect(v).toMatchObject({ outcome: "prompt", gate: "no-matching-rule" });
		expect(v.reason).toContain("Bash command (unsandboxed): Bash(npm install)");
	});

	it("is never treated as read-only bash — leaving the sandbox is the thing to ask about", () => {
		// `head` is on the safe list; sandboxed it runs freely, unsandboxed it must prompt.
		const READ = { command: "head -c 20 ~/.ssh/id_rsa" };
		expect(verdict("bash", READ, cfg({ sandbox: active() })).gate).toBe("sandboxed");
		const v = verdict("bash", { ...READ, dangerouslyDisableSandbox: true }, cfg({ sandbox: active() }));
		expect(v).toMatchObject({ outcome: "prompt", gate: "no-matching-rule" });
		expect(v.reason).toContain("(unsandboxed)");
	});

	it("is blocked headless, where nobody can approve it", () => {
		expect(verdict("bash", RETRY, cfg({ hasUI: false, sandbox: active() })).outcome).toBe("block");
	});

	it("runs in auto mode like any other command, unless the Claude Code ask rule is set", () => {
		expect(verdict("bash", RETRY, cfg({ mode: "auto", sandbox: active() })).gate).toBe("auto-mode");
		const asked = verdict(
			"bash",
			RETRY,
			cfg({ mode: "auto", rules: { ask: ["Bash(dangerouslyDisableSandbox:true)"] }, sandbox: active() }),
		);
		expect(asked).toMatchObject({ outcome: "prompt", gate: "ask-rule" });
		expect(asked.reason).toContain("(unsandboxed)");
	});

	it("is ignored under allowUnsandboxedCommands: false — the command runs sandboxed, auto-allowed", () => {
		const v = verdict("bash", RETRY, cfg({ sandbox: active({ allowUnsandboxedCommands: false }) }));
		expect(v).toMatchObject({ outcome: "allow", gate: "sandboxed" });
		expect(v.reason).not.toContain("unsandboxed");
	});

	it("means nothing while the sandbox is inactive", () => {
		const v = verdict("bash", RETRY, cfg({ sandbox: active({ active: false }) }));
		expect(v).toMatchObject({ outcome: "prompt", gate: "no-matching-rule" });
		expect(v.reason).not.toContain("unsandboxed");
	});
});
