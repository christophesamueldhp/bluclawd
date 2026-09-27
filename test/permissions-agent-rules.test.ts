import { describe, expect, it } from "vitest";
import { agentType, decide, parseRuleSpec } from "../ext/permissions/rules.ts";

const agent = (input: Record<string, unknown>) => ({ description: "x", prompt: "y", ...input });

describe("Agent(...) rules, Claude Code's spelling", () => {
	it("matches the agent type, with an omitted type meaning general-purpose", () => {
		expect(decide({ deny: ["Agent(Explore)"] }, "agent", agent({ subagent_type: "Explore" }))).toBe("deny");
		expect(decide({ deny: ["Agent(Explore)"] }, "agent", agent({ subagent_type: "Plan" }))).toBeNull();
		expect(decide({ deny: ["Agent(general-purpose)"] }, "agent", agent({}))).toBe("deny");
		expect(agentType({ subagent_type: "  " })).toBe("general-purpose");
	});

	it("matches the type as lookup does, case- and separator-insensitively", () => {
		expect(decide({ deny: ["Agent(explore)"] }, "agent", agent({ subagent_type: "Explore" }))).toBe("deny");
		expect(decide({ deny: ["Agent(Explore)"] }, "agent", agent({ subagent_type: "explore" }))).toBe("deny");
		expect(decide({ deny: ["Agent(code-reviewer)"] }, "agent", agent({ subagent_type: "Code Reviewer" }))).toBe(
			"deny",
		);
	});

	it("reads the legacy Task(...) spelling as Agent(...)", () => {
		expect(decide({ deny: ["Task(Explore)"] }, "agent", agent({ subagent_type: "Explore" }))).toBe("deny");
		expect(parseRuleSpec("Task(Plan)")).toEqual({ tool: "agent", input: { subagent_type: "Plan" } });
	});

	it("treats a bare verb as every subject", () => {
		expect(decide({ deny: ["Agent"] }, "agent", agent({ subagent_type: "anything" }))).toBe("deny");
		expect(decide({ deny: ["Bash"] }, "bash", { command: "ls" })).toBe("deny");
		expect(decide({ allow: ["Bash"] }, "bash", { command: "git status && npm test" })).toBe("allow");
	});

	it("matches parameter rules for deny and ask only, never on an omitted parameter", () => {
		const call = agent({ subagent_type: "Explore", model: "opus", isolation: "worktree" });
		expect(decide({ deny: ["Agent(model:opus)"] }, "agent", call)).toBe("deny");
		expect(decide({ ask: ["Agent(isolation:*)"] }, "agent", call)).toBe("ask");
		expect(decide({ deny: ["Agent(isolation:*)"] }, "agent", agent({ subagent_type: "Explore" }))).toBeNull();
		expect(decide({ allow: ["Agent(model:opus)"] }, "agent", call)).toBeNull();
	});
});
