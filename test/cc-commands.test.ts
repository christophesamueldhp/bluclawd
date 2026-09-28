import { describe, expect, it } from "vitest";
import { formatStatus } from "../ext/diagnostics/index.ts";

const plain = { bold: (s: string) => s, fg: (_c: string, s: string) => s };

describe("/status report", () => {
	it("lists model, safety, and session facts and points at /session", () => {
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
				sessionFile: "/x/s.jsonl",
				sessionName: "wave",
				contextWindow: 262144,
			},
			plain,
		);
		expect(lines).toContain("Model: opencode-go/kimi-k2.6 (Kimi K2.6)");
		expect(lines).toContain("Effort: high (/thinking)");
		expect(lines).toContain("Auth: stored · per token");
		expect(lines).toContain("Project trust: trusted (/trust)");
		expect(lines).toContain("Trust default: always (alt+m)");
		expect(lines).toContain("Name: wave");
		expect(lines.at(-1)).toContain("/session");
	});

	it("degrades when there is no model or session file", () => {
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
		expect(lines).toContain("File: not saved (ephemeral)");
	});
});
