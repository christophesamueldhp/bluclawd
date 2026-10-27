import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ALLOWED_SUBAGENT_TOOLS,
	discoverAgentDefinitions,
	formatAgentRoutingDescriptions,
	MAX_CUSTOM_DEFINITIONS,
	MAX_DEFINITION_BYTES,
	MAX_DESCRIPTION_CHARS,
	MAX_SUBAGENT_TURNS,
	resolveAgentDefinition,
	workspaceModeForTools,
} from "../ext/subagents/definitions.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-defs-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("Task 1 (M1) — Agent definitions and bundled roles", () => {
	it("loads bundled explorer and reviewer definitions with required evidence, scope, assumption, and blocker instructions", () => {
		const cwd = makeTempDir("cwd");
		const agentDir = makeTempDir("agent");

		const catalog = discoverAgentDefinitions({ cwd, agentDir, projectTrusted: true });
		expect(catalog.diagnostics).toEqual([]);
		expect(catalog.definitions.map((d) => d.name)).toEqual(["explorer", "reviewer"]);

		const explorer = resolveAgentDefinition(catalog, "explorer");
		expect(explorer.ok).toBe(true);
		if (explorer.ok) {
			expect(explorer.definition.source).toBe("bundled");
			expect(explorer.definition.tools).toEqual(ALLOWED_SUBAGENT_TOOLS);
			expect(explorer.definition.model).toBe("inherit");
			expect(explorer.definition.maxTurns).toBe(MAX_SUBAGENT_TURNS);
			expect(explorer.definition.instructions).toContain("path:line");
			expect(explorer.definition.instructions).toContain("Scope");
			expect(explorer.definition.instructions).toContain("Blockers");
			expect(explorer.definition.instructions).toMatch(/assumption/i);
		}

		const reviewer = resolveAgentDefinition(catalog, "reviewer");
		expect(reviewer.ok).toBe(true);
		if (reviewer.ok) {
			expect(reviewer.definition.source).toBe("bundled");
			expect(reviewer.definition.tools).toEqual(ALLOWED_SUBAGENT_TOOLS);
			expect(reviewer.definition.workspaceMode).toBe("shared");
			expect(reviewer.definition.instructions).toContain("path:line");
			expect(reviewer.definition.instructions).toContain("Scope");
			expect(reviewer.definition.instructions).toContain("Blockers");
			expect(reviewer.definition.instructions).toContain("not_run");
		}
	});

	it("enforces scope precedence (trusted project > user > bundled) and ignores untrusted project definitions", () => {
		const cwd = makeTempDir("prec-cwd");
		const agentDir = makeTempDir("prec-agent");
		const projectAgentsDir = join(cwd, ".pi", "agents");
		const userAgentsDir = join(agentDir, "agents");
		mkdirSync(projectAgentsDir, { recursive: true });
		mkdirSync(userAgentsDir, { recursive: true });

		writeFileSync(
			join(userAgentsDir, "explorer.md"),
			[
				"---",
				"name: explorer",
				"description: User customized explorer.",
				"tools: [read, grep]",
				"model: openai/gpt-5",
				"maxTurns: 6",
				"---",
				"User explorer body.",
			].join("\n"),
			"utf8",
		);

		writeFileSync(
			join(projectAgentsDir, "explorer.md"),
			[
				"---",
				"name: explorer",
				"description: Project customized explorer.",
				"tools: [read]",
				"maxTurns: 4",
				"---",
				"Project explorer body.",
			].join("\n"),
			"utf8",
		);

		// When project is trusted, project overrides user and bundled
		const trustedCatalog = discoverAgentDefinitions({ cwd, agentDir, projectTrusted: true });
		const trustedExplorer = resolveAgentDefinition(trustedCatalog, "explorer");
		expect(trustedExplorer.ok).toBe(true);
		if (trustedExplorer.ok) {
			expect(trustedExplorer.definition.source).toBe("project");
			expect(trustedExplorer.definition.description).toBe("Project customized explorer.");
			expect(trustedExplorer.definition.tools).toEqual(["read"]);
			expect(trustedExplorer.definition.maxTurns).toBe(4);
		}

		// When project is untrusted, project definitions are ignored and user overrides bundled
		const untrustedCatalog = discoverAgentDefinitions({ cwd, agentDir, projectTrusted: false });
		const untrustedExplorer = resolveAgentDefinition(untrustedCatalog, "explorer");
		expect(untrustedExplorer.ok).toBe(true);
		if (untrustedExplorer.ok) {
			expect(untrustedExplorer.definition.source).toBe("user");
			expect(untrustedExplorer.definition.description).toBe("User customized explorer.");
			expect(untrustedExplorer.definition.tools).toEqual(["read", "grep"]);
			expect(untrustedExplorer.definition.model).toBe("openai/gpt-5");
			expect(untrustedExplorer.definition.maxTurns).toBe(6);
		}
		expect(untrustedCatalog.diagnostics.some((d) => d.includes("untrusted project"))).toBe(true);
	});

	it("rejects invalid YAML, unknown capability fields, forbidden tools, unverified model aliases, oversized files, and duplicate names without silent fallback", () => {
		const cwd = makeTempDir("invalid-cwd");
		const agentDir = makeTempDir("invalid-agent");
		const userAgentsDir = join(agentDir, "agents");
		mkdirSync(userAgentsDir, { recursive: true });

		// 1. Invalid override of bundled `explorer` (unsupported field `permissionMode`) must fail closed and NOT fall back to bundled
		writeFileSync(
			join(userAgentsDir, "explorer.md"),
			[
				"---",
				"name: explorer",
				"description: Broken override with unsupported capability field.",
				"permissionMode: bypassPermissions",
				"---",
				"Body",
			].join("\n"),
			"utf8",
		);

		// 2. Unsupported external tool
		writeFileSync(
			join(userAgentsDir, "shell-worker.md"),
			[
				"---",
				"name: shell-worker",
				"description: Attempts to enable bash.",
				"tools: [read, mcp__external__write]",
				"---",
				"Body",
			].join("\n"),
			"utf8",
		);

		// 3. Unverified model alias (`sonnet`) and excessive maxTurns (`50`)
		writeFileSync(
			join(userAgentsDir, "bad-model.md"),
			[
				"---",
				"name: bad-model",
				"description: Uses alias instead of provider/model.",
				"model: sonnet",
				"maxTurns: 50",
				"---",
				"Body",
			].join("\n"),
			"utf8",
		);

		// 4. Duplicate name in same scope
		writeFileSync(
			join(userAgentsDir, "dup-a.md"),
			["---", "name: duplicate-role", "description: First dup.", "---", "Body A"].join("\n"),
			"utf8",
		);
		writeFileSync(
			join(userAgentsDir, "dup-b.md"),
			["---", "name: duplicate-role", "description: Second dup.", "---", "Body B"].join("\n"),
			"utf8",
		);

		// 5. Oversized file (> 32 KiB)
		writeFileSync(
			join(userAgentsDir, "huge.md"),
			["---", "name: huge", "description: Huge file.", "---", "x".repeat(MAX_DEFINITION_BYTES + 100)].join("\n"),
			"utf8",
		);

		// 6. Unsafe name (reserved prefix `sub_`) and oversized description
		writeFileSync(
			join(userAgentsDir, "sub_reserved.md"),
			["---", "name: sub_reserved", `description: ${"d".repeat(MAX_DESCRIPTION_CHARS + 10)}`, "---", "Body"].join(
				"\n",
			),
			"utf8",
		);

		// 7. Malformed YAML
		writeFileSync(join(userAgentsDir, "malformed.md"), ["---", "name: [unclosed", "---", "Body"].join("\n"), "utf8");

		const catalog = discoverAgentDefinitions({ cwd, agentDir, projectTrusted: true });

		// Valid bundled `reviewer` remains usable
		const reviewer = resolveAgentDefinition(catalog, "reviewer");
		expect(reviewer.ok).toBe(true);

		// Invalid `explorer` override fails closed (does not fall back to bundled `explorer`)
		const explorer = resolveAgentDefinition(catalog, "explorer");
		expect(explorer.ok).toBe(false);
		if (!explorer.ok) {
			expect(explorer.error).toContain("permissionMode");
		}

		// Forbidden tool rejected
		const shellWorker = resolveAgentDefinition(catalog, "shell-worker");
		expect(shellWorker.ok).toBe(false);
		if (!shellWorker.ok) {
			expect(shellWorker.error).toContain("mcp__external__write");
		}

		// Duplicate name in same scope fails closed
		const dup = resolveAgentDefinition(catalog, "duplicate-role");
		expect(dup.ok).toBe(false);
		if (!dup.ok) {
			expect(dup.error).toMatch(/duplicate/i);
		}

		// Oversized file rejected
		const huge = resolveAgentDefinition(catalog, "huge");
		expect(huge.ok).toBe(false);

		// Routing description list only exposes valid definitions (`reviewer`)
		const routing = formatAgentRoutingDescriptions(catalog);
		expect(routing).toContain("reviewer");
		expect(routing).not.toContain("shell-worker");
		expect(routing).not.toContain("duplicate-role");
	});

	it("falls back to bundled defaults with a diagnostic on aggregate custom definition overflow and rejects external symlinks", () => {
		const cwd = makeTempDir("overflow-cwd");
		const agentDir = makeTempDir("overflow-agent");
		const outsideDir = makeTempDir("outside");
		const userAgentsDir = join(agentDir, "agents");
		mkdirSync(userAgentsDir, { recursive: true });

		const outsideFile = join(outsideDir, "escaped.md");
		writeFileSync(
			outsideFile,
			["---", "name: escaped", "description: Outside symlink.", "---", "Body"].join("\n"),
			"utf8",
		);
		symlinkSync(outsideFile, join(userAgentsDir, "escaped.md"));

		const symlinkCatalog = discoverAgentDefinitions({ cwd, agentDir, projectTrusted: true });
		expect(resolveAgentDefinition(symlinkCatalog, "escaped").ok).toBe(false);

		// Now exceed MAX_CUSTOM_DEFINITIONS (32)
		for (let i = 0; i < MAX_CUSTOM_DEFINITIONS + 2; i++) {
			writeFileSync(
				join(userAgentsDir, `agent-${i}.md`),
				["---", `name: agent-${i}`, `description: Agent ${i}.`, "---", "Body"].join("\n"),
				"utf8",
			);
		}

		const overflowCatalog = discoverAgentDefinitions({ cwd, agentDir, projectTrusted: true });
		expect(overflowCatalog.definitions.map((d) => d.name)).toEqual(["explorer", "reviewer"]);
		expect(overflowCatalog.diagnostics.some((d) => d.includes("maximum of 32"))).toBe(true);
	});

	it.each([
		["api-auditor", ["read", "bash"]],
		["explorer", ["write"]],
		["reviewer", ["edit", "grep"]],
		["builder", ["read", "grep", "find", "ls", "edit", "write", "bash"]],
	])("derives isolation for arbitrary and overridden %s tools", (name, tools) => {
		const cwd = makeTempDir("capabilities");
		const agentDir = makeTempDir("capabilities-agent");
		const agents = join(agentDir, "agents");
		mkdirSync(agents);
		writeFileSync(
			join(agents, `${name}.md`),
			[
				"---",
				`name: ${name}`,
				"description: Explicit capabilities.",
				`tools: [${tools.join(", ")}]`,
				"---",
				"Stay within the supplied task.",
			].join("\n"),
		);
		const result = resolveAgentDefinition(discoverAgentDefinitions({ cwd, agentDir }), name);
		expect(result.ok).toBe(true);
		expect(result.definition?.tools).toEqual(tools);
		expect(result.definition?.workspaceMode).toBe("isolated");
	});

	it("does not grant legacy custom agents shell or write tools", () => {
		const cwd = makeTempDir("legacy");
		const agentDir = makeTempDir("legacy-agent");
		mkdirSync(join(agentDir, "agents"));
		writeFileSync(
			join(agentDir, "agents", "general-purpose.md"),
			"---\nname: general-purpose\ndescription: Legacy agent.\n---\nInspect only.",
		);
		const role = resolveAgentDefinition(discoverAgentDefinitions({ cwd, agentDir }), "general-purpose").definition!;
		expect(role.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(role.workspaceMode).toBe("shared");
	});

	it.each([
		{ tools: ["read", "bash"], want: "isolated" },
		{ tools: ["write"], want: "isolated" },
		{ tools: ["edit"], want: "isolated" },
		{ tools: ["read", "grep"], want: "shared" },
	])("classifies capabilities without consulting an agent name: $tools", ({ tools, want }) => {
		expect(workspaceModeForTools(tools as never)).toBe(want);
	});

	it.each([[], ["read", "unknown"], ["Read"], [null], "bash", undefined].map((tools) => ({ tools })))(
		"rejects malformed capability selection $tools",
		({ tools }) => {
			expect(() => workspaceModeForTools(tools as never)).toThrow(/invalid subagent tools/i);
		},
	);

	it("freezes discovered definitions so mid-run file edits do not mutate active definitions until reload", () => {
		const cwd = makeTempDir("freeze-cwd");
		const agentDir = makeTempDir("freeze-agent");
		const userAgentsDir = join(agentDir, "agents");
		mkdirSync(userAgentsDir, { recursive: true });

		const filePath = join(userAgentsDir, "auditor.md");
		writeFileSync(
			filePath,
			["---", "name: auditor", "description: Version 1.", "---", "Instructions v1."].join("\n"),
			"utf8",
		);

		const catalogV1 = discoverAgentDefinitions({ cwd, agentDir, projectTrusted: true });
		expect(Object.isFrozen(catalogV1)).toBe(true);
		expect(Object.isFrozen(catalogV1.definitions)).toBe(true);

		// Edit file on disk without re-running discovery
		writeFileSync(
			filePath,
			["---", "name: auditor", "description: Version 2.", "---", "Instructions v2."].join("\n"),
			"utf8",
		);

		const resolvedBeforeReload = resolveAgentDefinition(catalogV1, "auditor");
		expect(resolvedBeforeReload.ok).toBe(true);
		if (resolvedBeforeReload.ok) {
			expect(resolvedBeforeReload.definition.description).toBe("Version 1.");
			expect(resolvedBeforeReload.definition.instructions).toBe("Instructions v1.");
		}

		// After reload (new discovery), Version 2 is active
		const catalogV2 = discoverAgentDefinitions({ cwd, agentDir, projectTrusted: true });
		const resolvedAfterReload = resolveAgentDefinition(catalogV2, "auditor");
		expect(resolvedAfterReload.ok).toBe(true);
		if (resolvedAfterReload.ok) {
			expect(resolvedAfterReload.definition.description).toBe("Version 2.");
			expect(resolvedAfterReload.definition.instructions).toBe("Instructions v2.");
		}
	});
});
