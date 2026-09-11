import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProtectedPath } from "../ext/permissions/rules.ts";

/**
 * The protected-path screen guards configuration; two subtrees under the config
 * dir hold working data a subagent must be able to write — its worktree copy of
 * the repository and its own memory file. Mirrors the `.claude/worktrees` carve-out.
 */
describe("protected-path carve-outs for subagent working data", () => {
	const cwd = "/proj";
	const agentDir = "/home/u/.pi/agent";
	const check = (p: string) => isProtectedPath(p, cwd, agentDir, ".bluclawd");

	it("exempts a worktree's ordinary files but not the config dirs inside it", () => {
		expect(check(join(cwd, ".bluclawd", "worktrees", "w1", "src", "a.ts"))).toBe(false);
		expect(check(join(cwd, ".bluclawd", "worktrees", "w1", ".bluclawd", "settings.json"))).toBe(true);
		expect(check(join(cwd, ".bluclawd", "worktrees", "w1", ".git", "config"))).toBe(true);
	});

	it("exempts agent memory in the project and user scopes", () => {
		expect(check(join(cwd, ".bluclawd", "agent-memory", "scout", "MEMORY.md"))).toBe(false);
		expect(check(join(cwd, ".bluclawd", "agent-memory-local", "scout", "MEMORY.md"))).toBe(false);
		expect(check(join(agentDir, "agent-memory", "scout", "MEMORY.md"))).toBe(false);
	});

	it("keeps everything else under the config dir and the agent dir protected", () => {
		expect(check(join(cwd, ".bluclawd", "settings.json"))).toBe(true);
		expect(check(join(cwd, ".bluclawd", "agents", "x.md"))).toBe(true);
		expect(check(join(agentDir, "auth.json"))).toBe(true);
		expect(check(join(agentDir, "agents", "x.md"))).toBe(true);
	});
});
