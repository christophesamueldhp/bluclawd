import { describe, expect, it } from "vitest";
import {
	doneLine,
	emptyUsage,
	formatDuration,
	formatTokens,
	headerName,
	registerAgentColor,
	renderCall,
	renderResult,
	type SingleResult,
	totalTokens,
} from "../ext/subagents/render.ts";

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as any;

const toolCall = (name: string, args: object) => ({ type: "toolCall", name, arguments: args });
const result = (over: Partial<SingleResult> = {}): SingleResult => ({
	agent: "Explore",
	agentSource: "built-in",
	task: "look around",
	status: "ok",
	messages: [],
	stderr: "",
	usage: emptyUsage(),
	...over,
});

const draw = (component: unknown) =>
	(component as { render(w: number): string[] })
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trimEnd();
const call = (args: object) => draw(renderCall(args as never, theme, undefined));
const shown = (
	r: SingleResult | undefined,
	opts: { expanded?: boolean; isPartial?: boolean; launched?: boolean } = {},
) =>
	draw(
		renderResult(
			{
				content: [{ type: "text", text: "plain text" }],
				details:
					r || opts.launched
						? { agentType: "Explore", description: "d", result: r, launched: opts.launched }
						: undefined,
			} as never,
			{ expanded: opts.expanded ?? false, isPartial: opts.isPartial },
			theme,
			undefined,
		),
	);

describe("number formats", () => {
	it("counts tokens and time as Claude Code does", () => {
		expect(formatTokens(950)).toBe("950");
		expect(formatTokens(12_345)).toBe("12.3k");
		expect(formatTokens(2000)).toBe("2k");
		expect(formatTokens(1_200_000)).toBe("1.2M");
		expect(formatDuration(8_400)).toBe("8s");
		expect(formatDuration(65_000)).toBe("1m 5s");
	});

	it("counts the last request's tokens, falling back to the run's usage", () => {
		const usage = { input: 1000, output: 200, cacheRead: 50, cacheWrite: 0 };
		const withMessage = result({
			messages: [{ role: "assistant", content: [], usage } as never],
			usage: { ...emptyUsage(), input: 99_999 },
		});
		expect(totalTokens(withMessage)).toBe(1250);
		expect(totalTokens(result({ usage: { ...emptyUsage(), input: 10, output: 5 } }))).toBe(15);
	});

	it("reads Done with singular and plural tool uses", () => {
		expect(doneLine(result({ toolUses: 1, durationMs: 3000 }))).toBe("Done (1 tool use · 0 tokens · 3s)");
		expect(doneLine(result({ toolUses: 3, durationMs: 8000, usage: { ...emptyUsage(), input: 12_300 } }))).toBe(
			"Done (3 tool uses · 12.3k tokens · 8s)",
		);
	});
});

describe("renderCall", () => {
	it("reads Type(description), with the default agent as Agent", () => {
		expect(headerName(undefined)).toBe("Agent");
		expect(call({ description: "find  the\nbug", subagent_type: "general-purpose" })).toBe("Agent(find the bug)");
		expect(call({ description: "find it" })).toBe("Agent(find it)");
		expect(call({ description: "look", subagent_type: "Explore" })).toBe("Explore(look)");
		expect(call({ subagent_type: "Explore" })).toBe("Explore");
	});

	it("colours the name by the agent's registered colour", () => {
		registerAgentColor("painted", "cyan");
		try {
			expect(call({ description: "d", subagent_type: "painted" })).toContain("\x1b[36mpainted\x1b[39m");
		} finally {
			registerAgentColor("painted", undefined);
		}
		expect(call({ description: "d", subagent_type: "painted" })).not.toContain("\x1b[36m");
	});
});

describe("renderResult", () => {
	it("marks a background launch", () => {
		expect(shown(undefined, { launched: true })).toMatch(
			/⎿ {2}Backgrounded agent \(\/tasks to manage · .* to expand\)/,
		);
	});

	it("shows the tool result's text when there are no details", () => {
		expect(shown(undefined)).toBe("plain text");
	});

	it("shows Initializing… until a running child makes its first tool call", () => {
		expect(shown(result({ status: "running" }))).toBe("  ⎿  Initializing…");
	});

	it("shows a running child's last three tool calls and counts the rest", () => {
		const r = result({
			status: "running",
			messages: [
				{
					role: "assistant",
					content: [
						toolCall("read", { path: "/a.ts" }),
						toolCall("read", { path: "/b.ts" }),
						toolCall("grep", { pattern: "foo", path: "/src" }),
						toolCall("bash", { command: "npm test" }),
						toolCall("websearch", { query: "q" }),
					],
				} as never,
			],
		});
		const out = shown(r);
		expect(out).not.toContain("/a.ts");
		expect(out).toContain("grep foo in /src");
		expect(out).toContain("$ npm test");
		expect(out).toContain('websearch {"query":"q"}');
		expect(out).toMatch(/\+2 more tool uses \(.* to expand\)/);
		expect(shown(r, { expanded: true })).toContain("/a.ts");
		// A partial update of a finished-looking result still renders as running.
		expect(shown({ ...r, status: "ok" }, { isPartial: true })).toContain("+2 more tool uses");
	});

	it("shows a failed child's error", () => {
		expect(shown(result({ status: "failed", errorMessage: "rate limited" }))).toBe("  ⎿  rate limited");
		expect(shown(result({ status: "failed" }))).toBe("  ⎿  Agent failed");
	});

	it("ends a finished child with Done, after its partial and kept-worktree notes", () => {
		const out = shown(
			result({
				partial: true,
				turnCap: 5,
				worktreePath: "/repo/.pi/worktrees/agent-a1",
				toolUses: 2,
				durationMs: 4000,
			}),
		);
		expect(out.split("\n")).toEqual([
			"  ⎿  Stopped at its 5-turn limit (partial result)",
			"  ⎿  Kept worktree /repo/.pi/worktrees/agent-a1",
			"  ⎿  Done (2 tool uses · 0 tokens · 4s)",
		]);
	});

	it("expands to the prompt, every tool call and the report", () => {
		const out = shown(
			result({
				toolUses: 1,
				messages: [
					{ role: "assistant", content: [toolCall("read", { path: "/a.ts" })] } as never,
					{ role: "assistant", content: [{ type: "text", text: "Found it." }] } as never,
				],
			}),
			{ expanded: true },
		);
		expect(out).toContain("Prompt:");
		expect(out).toContain("look around");
		expect(out).toContain("read /a.ts");
		expect(out).toContain("Found it.");
		expect(out).toContain("Done (1 tool use");
	});
});
