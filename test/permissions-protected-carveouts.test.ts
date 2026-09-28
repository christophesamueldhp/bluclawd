import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProtectedPath } from "../ext/permissions/rules.ts";

/**
 * The protected-path screen guards configuration. Its one carve-out is Claude Code's
 * `.claude/worktrees`, which holds working copies; the config dir and the agent dir
 * have none — their former subagent working-data exemptions went with subagents.
 */
describe("protected-path carve-outs", () => {
	const cwd = "/proj";
	const agentDir = "/home/u/.pi/agent";
	const check = (p: string) => isProtectedPath(p, cwd, agentDir, ".bluclawd");

	it("exempts a .claude worktree's ordinary files but not the config dirs inside it", () => {
		expect(check(join(cwd, ".claude", "worktrees", "w1", "src", "a.ts"))).toBe(false);
		expect(check(join(cwd, ".claude", "worktrees", "w1", ".bluclawd", "settings.json"))).toBe(true);
		expect(check(join(cwd, ".claude", "worktrees", "w1", ".git", "config"))).toBe(true);
	});

	it("protects the whole config dir, including the former subagent subtrees", () => {
		expect(check(join(cwd, ".bluclawd", "worktrees", "w1", "src", "a.ts"))).toBe(true);
		expect(check(join(cwd, ".bluclawd", "agent-memory", "scout", "MEMORY.md"))).toBe(true);
		expect(check(join(cwd, ".bluclawd", "agent-memory-local", "scout", "MEMORY.md"))).toBe(true);
		expect(check(join(cwd, ".bluclawd", "settings.json"))).toBe(true);
		expect(check(join(cwd, ".bluclawd", "agents", "x.md"))).toBe(true);
	});

	it("protects the whole agent dir", () => {
		expect(check(join(agentDir, "agent-memory", "scout", "MEMORY.md"))).toBe(true);
		expect(check(join(agentDir, "auth.json"))).toBe(true);
		expect(check(join(agentDir, "agents", "x.md"))).toBe(true);
	});
});
