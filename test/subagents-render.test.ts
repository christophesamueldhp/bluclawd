import { describe, expect, it } from "vitest";
import { emptyUsage, renderCall, renderResult, type SingleResult } from "../ext/subagents/render.ts";

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as any;
const running = (agent: string, turns: number): SingleResult => ({
	agent,
	agentSource: "user",
	task: "t",
	status: "running",
	messages: [],
	stderr: "",
	usage: { ...emptyUsage(), turns, input: 1200, output: 300 },
});

describe("subagent rendering", () => {
	it("shows a running child's turns and tokens so progress is visible before it finishes", () => {
		const out = renderResult(
			{
				content: [{ type: "text", text: "" }],
				details: { mode: "parallel", agentScope: "user", projectAgentsDir: null, results: [running("explore", 3)] },
			},
			{ expanded: false },
			theme,
			undefined,
		) as { render(w: number): string[] };
		expect(out.render(120).join("\n")).toMatch(/3 turns ↑1\.2k ↓300/);
	});

	it("omits the scope tag when the call left agentScope to the default", () => {
		const out = renderCall({ agent: "explore", task: "look" }, theme, undefined) as { render(w: number): string[] };
		expect(out.render(120).join("\n")).not.toContain("[user]");
	});
});
