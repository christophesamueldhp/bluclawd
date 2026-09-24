import { describe, expect, it } from "vitest";
import { formatStatus } from "../ext/diagnostics/index.ts";
import { formatPackageList } from "../ext/plugin/index.ts";

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
				permissionMode: "edits",
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
		expect(lines).toContain("Auth: stored · per token");
		expect(lines).toContain("Permission mode: edits (/mode)");
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
