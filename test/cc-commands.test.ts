import { describe, expect, it } from "vitest";
import { formatContext, formatStatus, toolDefinitionChars } from "../ext/help/diagnostics.ts";

const plain = { bold: (s: string) => s, fg: (_c: string, s: string) => s };

describe("/status report", () => {
	it("shows additional background usage separately when the ledger has child runs", () => {
		const lines = formatStatus(
			{
				piVersion: "1.0.4",
				subscription: false,
				defaultProjectTrust: "ask",
				projectTrusted: true,
				cwd: "/x",
				subagents: "2 runs, 400 tokens, cost unknown — excluded from /session totals",
			},
			plain,
		);
		expect(lines).toContain("Subagents");
		expect(lines).toContain("2 runs, 400 tokens, cost unknown — excluded from /session totals");
	});

	it("lists model and project facts and points at /session and /context", () => {
		const lines = formatStatus(
			{
				piVersion: "0.84.4",
				model: "opencode-go/kimi-k2.6",
				modelName: "Kimi K2.6",
				thinkingLevel: "high",
				authSource: "stored",
				subscription: false,
				defaultProjectTrust: "always",
				projectTrusted: true,
				cwd: "/x",
			},
			plain,
		);
		expect(lines).toContain("Model: opencode-go/kimi-k2.6 (Kimi K2.6)");
		expect(lines).toContain("Effort: high (/thinking)");
		expect(lines).toContain("Auth: stored · per token");
		expect(lines).toContain("Working directory: /x");
		expect(lines).toContain("Project trust: trusted (/trust)");
		expect(lines).toContain("Trust default: always (alt+m)");
		expect(lines.at(-1)).toContain("/session");
		expect(lines.at(-1)).toContain("/context");
	});

	it("leaves session and context facts to /session and /context", () => {
		const text = formatStatus(
			{
				piVersion: "0.84.4",
				model: "opencode-go/kimi-k2.6",
				subscription: false,
				defaultProjectTrust: "always",
				projectTrusted: true,
				cwd: "/x",
			},
			plain,
		).join("\n");
		expect(text).not.toMatch(/^(Name|File|Context window):/m);
	});

	it("degrades when there is no model", () => {
		const lines = formatStatus(
			{
				piVersion: "0.84.4",
				subscription: false,
				defaultProjectTrust: "ask",
				projectTrusted: false,
				cwd: "/x",
			},
			plain,
		);
		expect(lines).toContain("Model: none selected");
		expect(lines).toContain("Effort: off (/thinking)");
		expect(lines).toContain("Auth: not configured");
	});
});

describe("/context report", () => {
	const usage = { model: "anthropic/claude", contextWindow: 200_000, tokens: 20_000, percent: 10 };

	it("shows tool definitions on their own line, outside messages and tool results", () => {
		const lines = formatContext({ ...usage, systemPromptChars: 4_000, toolDefinitionChars: 24_000 }, plain);
		expect(lines).toContain("  System prompt incl. project context & skills (est.): ~1.0k");
		expect(lines).toContain("  Tool definitions (est.): ~6.0k");
		expect(lines).toContain("  Messages & tool results (est.): ~13.0k");
	});

	it("omits the tool definitions line for entries recorded before they were measured", () => {
		const lines = formatContext({ ...usage, systemPromptChars: 4_000 }, plain);
		expect(lines.join("\n")).not.toContain("Tool definitions");
		expect(lines).toContain("  Messages & tool results (est.): ~19.0k");
	});

	it("never shows negative messages when the estimates exceed the total", () => {
		const lines = formatContext({ ...usage, systemPromptChars: 40_000, toolDefinitionChars: 60_000 }, plain);
		expect(lines).toContain("  Messages & tool results (est.): ~0");
	});
});

describe("tool definition size", () => {
	it("counts each tool's name, description and schema, not its prompt guidelines", () => {
		const tools = [
			{ name: "ab", description: "cde", parameters: { type: "object" }, promptGuidelines: ["in the system prompt"] },
			{ name: "f", description: "gh", parameters: {} },
		];
		// "ab" + "cde" + '{"type":"object"}', then "f" + "gh" + "{}"
		expect(toolDefinitionChars(tools)).toBe(27);
	});
});
