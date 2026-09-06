import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverDefs, parseDef } from "../ext/subagents/defs.ts";

/** Names of the defs shipped in ext/subagents/agents. */
const BUNDLED = ["code-reviewer", "explore", "planner"];

const def = (name: string, description = "does a thing") =>
	`---\nname: ${name}\ndescription: ${description}\n---\nYou are ${name}.\n`;

describe("discoverDefs", () => {
	let home: string;
	let cwd: string;
	let userAgents: string;
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-agents-home-"));
		// A temp cwd too: from the repo, findNearestProjectAgentsDir would walk up
		// into whatever real project config sits above it.
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-agents-cwd-"));

		// getAgentDir() prefers <APP>_CODING_AGENT_DIR over $HOME, and the app name is
		// the host package's, so clear the variable by shape rather than by guessing it.
		saved = { HOME: process.env.HOME };
		for (const key of Object.keys(process.env)) {
			if (key.endsWith("_CODING_AGENT_DIR")) {
				saved[key] = process.env[key];
				delete process.env[key];
			}
		}
		process.env.HOME = home;

		// If the redirect did not take, the writes below would land in the real agent
		// directory — fail instead.
		expect(getAgentDir().startsWith(home)).toBe(true);
		userAgents = join(getAgentDir(), "agents");
		mkdirSync(userAgents, { recursive: true });
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("offers the bundled seeds when the user has none", () => {
		const names = discoverDefs(cwd, "both").defs.map((d) => d.name);
		expect(names.sort()).toEqual(BUNDLED);
	});

	it("KEEPS the other bundled agents when the user saves one of their own", () => {
		// The regression this guards: the seeds used to be an all-or-nothing fallback,
		// so the first user def deleted every bundled agent from /agents and the task tool.
		writeFileSync(join(userAgents, "mine.md"), def("mine"));

		const names = discoverDefs(cwd, "both").defs.map((d) => d.name);
		expect(names.sort()).toEqual([...BUNDLED, "mine"].sort());
	});

	it("lets a user def override a bundled one of the same name, in place", () => {
		writeFileSync(join(userAgents, "explore.md"), def("explore", "my own explore"));

		const defs = discoverDefs(cwd, "both").defs;
		expect(defs.map((d) => d.name).sort()).toEqual(BUNDLED);
		const explore = defs.find((d) => d.name === "explore");
		expect(explore?.description).toBe("my own explore");
		expect(explore?.filePath).toBe(join(userAgents, "explore.md"));
	});

	it("lets a project def override a user def of the same name", () => {
		const projectAgents = join(cwd, CONFIG_DIR_NAME, "agents");
		mkdirSync(projectAgents, { recursive: true });
		writeFileSync(join(userAgents, "mine.md"), def("mine", "user copy"));
		writeFileSync(join(projectAgents, "mine.md"), def("mine", "project copy"));

		const mine = discoverDefs(cwd, "both").defs.find((d) => d.name === "mine");
		expect(mine?.description).toBe("project copy");
		expect(mine?.source).toBe("project");
	});

	it("ignores every user def in project scope", () => {
		writeFileSync(join(userAgents, "mine.md"), def("mine"));
		expect(discoverDefs(cwd, "both").defs.some((d) => d.name === "mine")).toBe(true);
		expect(discoverDefs(cwd, "project").defs).toEqual([]);
	});

	it("skips a def parseDef rejects, and keeps the rest of the directory", () => {
		// Both halves matter: a file that will not load must not appear, and it must
		// not take its neighbours down with it.
		writeFileSync(join(userAgents, "broken.md"), "---\nname: broken\n---\nno description\n");
		writeFileSync(join(userAgents, "fine.md"), def("fine"));

		const names = discoverDefs(cwd, "both").defs.map((d) => d.name);
		expect(names).not.toContain("broken");
		expect(names.sort()).toEqual([...BUNDLED, "fine"].sort());
	});
});

describe("parseDef", () => {
	it("reads name, description and body", () => {
		const parsed = parseDef(def("scout", "looks around"));
		expect(parsed).toMatchObject({ name: "scout", description: "looks around", systemPrompt: "You are scout." });
	});

	it("names the reason a def would not load", () => {
		expect(parseDef("---\ndescription: no name\n---\nbody\n")).toEqual({
			problem: "the frontmatter declares no name:",
		});
		// The name comes back with the problem: a save can then still file the def under
		// the name its author gave it, rather than under whatever it was opened as.
		expect(parseDef("---\nname: x\n---\nbody\n")).toEqual({
			name: "x",
			problem: "the frontmatter declares no description:",
		});
		expect(parseDef("---\nname: x\ndescription: '\n---\nbody\n")).toMatchObject({
			problem: expect.stringContaining("not valid YAML"),
		});
	});

	it("trims the name, which becomes a file name and a lookup key", () => {
		const parsed = parseDef("---\nname: '  scout  '\ndescription: d\n---\nbody\n");
		expect(parsed).toMatchObject({ name: "scout" });
	});

	it("lowercases tools in both spellings Claude Code writes", () => {
		expect(parseDef("---\nname: x\ndescription: d\ntools: Read, Grep\n---\n")).toMatchObject({
			tools: ["read", "grep"],
		});
		expect(parseDef("---\nname: x\ndescription: d\ntools: [Read, Grep]\n---\n")).toMatchObject({
			tools: ["read", "grep"],
		});
	});
});
