/**
 * Write primitives that take their target as an argument, not a redirect. The
 * protected-path gate is mode-independent, so each must prompt even in auto mode.
 */
import { describe, expect, it } from "vitest";
import { bashWriteTargets } from "../ext/permissions/bash-targets.ts";
import { type EvalConfig, evaluatePostHook, evaluatePreHook } from "../ext/permissions/evaluate.ts";

const c: EvalConfig = {
	mode: "auto",
	rules: {},
	cliAllowRules: {},
	cwd: "/proj",
	agentDir: "/home/u/.pi/agent",
	configDirName: ".bluclawd",
	hasUI: true,
};

function gate(command: string) {
	return (evaluatePreHook("bash", { command }, c) ?? evaluatePostHook("bash", { command }, c)).gate;
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
	])("%s prompts in auto mode", (command) => {
		expect(gate(command)).toBe("write-protected-path");
	});

	it.each(["rm -rf build", "sed -i 's/a/b/' src/x.ts", "sed -n 1,5p .git/config", "mkdir -p dist", "dd if=a of=b"])(
		"%s is not screened",
		(command) => {
			expect(gate(command)).not.toBe("write-protected-path");
		},
	);

	it("names the targets, not the flags or the sed script's own words", () => {
		expect(bashWriteTargets("rm -rf a b")).toEqual(["a", "b"]);
		expect(bashWriteTargets("dd if=x of=y")).toEqual(["y"]);
		expect(bashWriteTargets("rsync -av src/ dst")).toEqual(["dst"]);
		expect(bashWriteTargets("sed -n 1p f")).toEqual([]);
	});
});
