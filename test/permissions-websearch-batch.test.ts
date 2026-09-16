import { describe, expect, it } from "vitest";
import { type EvalConfig, evaluatePostHook, evaluatePreHook } from "../ext/permissions/evaluate.ts";

/** websearch `queries` is a batch: each query must meet the WebSearch rules a single `query` meets. */
function cfg(rules: EvalConfig["rules"], mode: EvalConfig["mode"] = "auto"): EvalConfig {
	return { mode, rules, cliAllowRules: {}, cwd: "/p", agentDir: "/a", configDirName: ".bluclawd", hasUI: true };
}

const verdict = (input: Record<string, unknown>, c: EvalConfig) =>
	evaluatePreHook("websearch", input, c) ?? evaluatePostHook("websearch", input, c);

describe("websearch batch queries under WebSearch rules", () => {
	it("a deny rule on any query in the batch blocks the call", () => {
		const v = verdict(
			{ queries: ["vitest mocks", "acme internal secret roadmap"] },
			cfg({ deny: ["WebSearch(*secret*)"] }),
		);
		expect(v).toMatchObject({ outcome: "block", gate: "deny-rule" });
		expect(JSON.stringify(v)).toContain("acme internal secret roadmap");
	});

	it("a deny rule still applies when query and queries are both given", () => {
		const v = verdict({ query: "fine", queries: ["secret plans"] }, cfg({ deny: ["WebSearch(*secret*)"] }));
		expect(v).toMatchObject({ outcome: "block" });
	});

	it("an ask rule on one query prompts, labelled with that query", () => {
		const v = verdict({ queries: ["vitest mocks", "competitor pricing"] }, cfg({ ask: ["WebSearch(competitor*)"] }));
		expect(v).toMatchObject({ outcome: "prompt", gate: "ask-rule" });
		expect(JSON.stringify(v)).toContain("competitor pricing");
	});

	it("a batch with no matching rule behaves like a single search", () => {
		expect(verdict({ queries: ["a", "b"] }, cfg({ deny: ["WebSearch(*secret*)"] }))).toMatchObject({
			outcome: "allow",
		});
		const asked = verdict({ queries: ["first query", "b"] }, cfg({}, "ask"));
		expect(JSON.stringify(asked)).toContain("first query");
	});
});
