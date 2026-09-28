/**
 * Write primitives that take their target as an argument, not a redirect. In ask and
 * edits mode a write to protected config prompts; auto and allow rules run it.
 */
import { describe, expect, it } from "vitest";
import { bashWriteTargets } from "../ext/permissions/bash-targets.ts";
import { type EvalConfig, evaluatePostHook, evaluatePreHook } from "../ext/permissions/evaluate.ts";

const c: EvalConfig = {
	mode: "ask",
	rules: {},
	cliAllowRules: {},
	cwd: "/proj",
	agentDir: "/home/u/.pi/agent",
	configDirName: ".bluclawd",
	hasUI: true,
};

function verdict(tool: string, input: Record<string, unknown>, over: Partial<EvalConfig> = {}) {
	const cfg = { ...c, ...over };
	return evaluatePreHook(tool, input, cfg) ?? evaluatePostHook(tool, input, cfg);
}

function gate(command: string) {
	return verdict("bash", { command }).gate;
}

describe("protected writes through argument-taking primitives", () => {
	it.each([
		"rm -rf .git",
		"rmdir .husky",
		"unlink .mcp.json",
		"touch .git/hooks/pre-commit",
		"mkdir -p .vscode",
		"truncate -s 0 .bluclawd/settings.json",
		"chmod +x .git/hooks/pre-push",
		"chown me .bluclawd/hooks.json",
		"sed -i 's/a/b/' .bluclawd/settings.json",
		"sed -i.bak -e 's/a/b/' .git/config",
		"perl -pi -e 's/a/b/' .git/config",
		"dd if=/dev/zero of=.git/index bs=1 count=1",
		"rsync -a hooks/ .git/hooks",
		"nohup rm -rf .git",
		"env X=1 rm -rf .git",
		"sh -c 'rm -rf .git'",
		"npm test && rm -rf .git",
	])("%s prompts in ask mode", (command) => {
		expect(gate(command)).toBe("write-protected-path");
	});

	it.each(["rm -rf build", "sed -i 's/a/b/' src/x.ts", "sed -n 1,5p .git/config", "mkdir -p dist", "dd if=a of=b"])(
		"%s is not screened",
		(command) => {
			expect(gate(command)).not.toBe("write-protected-path");
		},
	);

	it("prompts in edits mode too, and blocks headless", () => {
		const hook = { path: ".git/hooks/pre-commit" };
		expect(verdict("write", hook, { mode: "edits" }).gate).toBe("write-protected-path");
		expect(verdict("write", hook, { hasUI: false }).outcome).toBe("block");
	});

	it("runs in auto mode, and under an allow rule in any mode", () => {
		const hook = { path: ".git/hooks/pre-commit" };
		expect(verdict("write", hook, { mode: "auto" }).gate).toBe("auto-mode");
		expect(verdict("write", hook, { rules: { allow: ["Edit(.git/**)"] } }).gate).toBe("allow-rule");
		expect(verdict("bash", { command: "rm -rf .git" }, { mode: "auto" }).gate).toBe("auto-mode");
	});

	it("names the targets, not the flags or the sed script's own words", () => {
		expect(bashWriteTargets("rm -rf a b")).toEqual(["a", "b"]);
		expect(bashWriteTargets("dd if=x of=y")).toEqual(["y"]);
		expect(bashWriteTargets("rsync -av src/ dst")).toEqual(["dst"]);
		expect(bashWriteTargets("sed -n 1p f")).toEqual([]);
	});
});
