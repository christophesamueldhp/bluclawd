import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskAgents } from "../ext/permissions/rules.ts";
import { discoverWorkflows, expandWorkflow, parseWorkflow } from "../ext/subagents/workflows.ts";

const wf = (name: string, chain: string) => `---\nname: ${name}\ndescription: d\nchain:\n${chain}\n---\n`;

describe("workflows", () => {
	let home: string;
	let cwd: string;
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-wf-home-"));
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-wf-cwd-"));
		saved = { HOME: process.env.HOME };
		for (const key of Object.keys(process.env)) {
			if (key.endsWith("_CODING_AGENT_DIR")) {
				saved[key] = process.env[key];
				delete process.env[key];
			}
		}
		process.env.HOME = home;
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("parses single and parallel steps, and says why a bad file will not load", () => {
		const ok = parseWorkflow(wf("w", "  - agent: a\n    task: x\n  - parallel:\n      - agent: b\n        task: y"));
		expect(ok).toMatchObject({
			name: "w",
			chain: [{ agent: "a", task: "x" }, { parallel: [{ agent: "b", task: "y" }] }],
		});
		expect(parseWorkflow(wf("w", "  - parallel: []"))).toHaveProperty("problem");
		expect(parseWorkflow(wf("w", "  - agent: a"))).toHaveProperty("problem");
	});

	it("ships bundled workflows, lets user files override them, and reads a project's only when trusted", () => {
		const names = (trusted: boolean) => discoverWorkflows(cwd, trusted).map((w) => `${w.name}:${w.origin}`);
		expect(names(false)).toEqual(expect.arrayContaining(["parallel-review:bundled", "scout-and-plan:bundled"]));
		mkdirSync(join(getAgentDir(), "workflows"), { recursive: true });
		writeFileSync(
			join(getAgentDir(), "workflows", "scout-and-plan.md"),
			wf("scout-and-plan", "  - agent: a\n    task: x"),
		);
		mkdirSync(join(cwd, CONFIG_DIR_NAME, "workflows"), { recursive: true });
		writeFileSync(join(cwd, CONFIG_DIR_NAME, "workflows", "repo.md"), wf("repo", "  - agent: a\n    task: x"));
		expect(names(false)).toContain("scout-and-plan:user");
		expect(names(false)).not.toContain("repo:project");
		expect(names(true)).toContain("repo:project");
	});

	it("fills {input} and leaves {previous} for the chain", () => {
		const [w] = discoverWorkflows(cwd, false).filter((x) => x.name === "scout-and-plan");
		const steps = expandWorkflow(w, "add login");
		expect(steps[0].task).toContain("add login");
		expect(steps[1].task).toContain("{previous}");
	});

	it("puts every agent of a parallel chain step under the permission check", () => {
		expect(
			taskAgents({
				chain: [
					{
						parallel: [
							{ agent: "a", task: "x" },
							{ agent: "b", task: "y" },
						],
					},
				],
			}),
		).toEqual(["a", "b"]);
	});
});
