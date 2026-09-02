import { describe, expect, it } from "vitest";
import { formatStatus } from "../ext/diagnostics/index.ts";
import { formatPackageList } from "../ext/plugin/index.ts";
import { formatUsageReport } from "../ext/statusline/index.ts";

const plain = { bold: (s: string) => s, fg: (_c: string, s: string) => s };

describe("/usage report", () => {
	const totals = { input: 1200, output: 340, cacheRead: 5000, cacheWrite: 0, cost: 0.0123, latestCacheHitRate: 80.6 };

	it("prints cost, tokens, and both plan-usage sections when present", () => {
		const lines = formatUsageReport(
			{
				model: "opencode-go/kimi-k2.6",
				subscription: true,
				totals,
				claude: { sessionUsage: 20, weeklyUsage: 55, sessionResetAt: undefined, weeklyResetAt: undefined },
				go: { rolling: { usagePercent: 3, resetAt: "2026-09-03T00:00:00Z" } },
			},
			plain,
		);
		expect(lines[0]).toBe("Session usage");
		expect(lines.find((l) => l.startsWith("Cost:"))).toContain("$0.0123");
		expect(lines.find((l) => l.startsWith("Cost:"))).toContain("subscription");
		expect(lines.find((l) => l.startsWith("Tokens:"))).toBe(
			"Tokens: ↑1.2k in · ↓340 out · cache read 5.0k · cache write 0",
		);
		expect(lines).toContain("Plan usage (Claude)");
		expect(lines).toContain("Session (5h): 20%");
		expect(lines).toContain("Plan usage (OpenCode Go)");
		expect(lines.some((l) => l.startsWith("Session (5h): 3%"))).toBe(true);
	});

	it("explains how to get plan usage when neither source is configured", () => {
		const lines = formatUsageReport({ subscription: false, totals, claude: null, go: null }, plain);
		expect(lines.some((l) => l.includes("/login"))).toBe(true);
		expect(lines.some((l) => l.includes("OPENCODE_GO_WORKSPACE_ID"))).toBe(true);
	});
});

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
				permissionMode: "acceptEdits",
				sandbox: true,
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
		expect(lines).toContain("Permission mode: acceptEdits (/mode)");
		expect(lines).toContain("Sandbox: on (/sandbox)");
		expect(lines).toContain("Name: wave");
		expect(lines.at(-1)).toContain("/session");
	});

	it("degrades when there is no model or session file", () => {
		const lines = formatStatus(
			{
				piVersion: "0.84.4",
				subscription: false,
				permissionMode: "default",
				sandbox: false,
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

describe("/plugin list", () => {
	it("shows install path, scope, and filter state per package", () => {
		const lines = formatPackageList([
			{ source: "git:github.com/a/b", scope: "user", filtered: false, installedPath: "/home/me/.pi/agent/git/b" },
			{ source: "npm:pi-thing", scope: "project", filtered: true },
		]);
		expect(lines[1]).toBe("  git:github.com/a/b  (user)");
		expect(lines[2]).toContain("/home/me/.pi/agent/git/b");
		expect(lines[3]).toBe("  npm:pi-thing  (project, filtered by pi config)");
		expect(lines[4]).toContain("not installed");
	});

	it("tells an empty list how to add one", () => {
		expect(formatPackageList([])[1]).toContain("/plugin install");
	});
});
