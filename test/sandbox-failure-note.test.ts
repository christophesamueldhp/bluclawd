import { describe, expect, it } from "vitest";
import { resolveSandboxConfig } from "../ext/sandbox/config.ts";
import { buildSandboxFailureNote, looksLikeSandboxDenial } from "../ext/sandbox/failure-note.ts";

describe("looksLikeSandboxDenial", () => {
	it.each([
		"cp: .pi/hooks.json: Operation not permitted",
		"bash: /Users/me/.ssh/id_rsa: Permission denied",
		"Error: EPERM: operation not permitted, open '/x'",
		"Error: EACCES: permission denied, mkdir '/etc/x'",
		"curl: (6) Could not resolve host: example.com",
		"connect ECONNREFUSED 127.0.0.1:443",
		"Network is unreachable",
	])("recognises %s", (line) => {
		expect(looksLikeSandboxDenial(line)).toBe(true);
	});

	it.each(["", "no matches found", "FAIL src/app.test.ts > adds", "diff --git a/x b/x\n-1\n+2"])(
		"ignores ordinary failures: %j",
		(output) => {
			expect(looksLikeSandboxDenial(output)).toBe(false);
		},
	);
});

describe("buildSandboxFailureNote", () => {
	it("says nothing when no restriction is configured", () => {
		const config = resolveSandboxConfig({
			filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
			network: { allowedDomains: [] },
		});
		// Deny lists are unioned with the defaults, so only a config that really
		// has nothing left can be silent.
		config.filesystem = { allowWrite: [], denyWrite: [], denyRead: [] };
		expect(buildSandboxFailureNote(config)).toBeUndefined();
	});

	it("lists writes and network by name but denyRead only by count", () => {
		const note = buildSandboxFailureNote(resolveSandboxConfig({ filesystem: { denyRead: ["~/.ssh", "~/.aws"] } }));
		expect(note).toContain("<sandbox_note>");
		expect(note).toContain("writes allowed: ., and $TMPDIR for temporary files");
		expect(note).toMatch(/reads denied: \d+ paths/);
		expect(note).not.toContain("~/.ssh");
	});
});
