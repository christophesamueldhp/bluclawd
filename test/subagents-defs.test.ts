import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AgentDef,
	discoverDefs,
	findDef,
	isOneShot,
	parseDef,
	resolveChildTools,
	toolsLabel,
	zeroToolsError,
} from "../ext/subagents/defs.ts";
import { childToolPool } from "../ext/subagents/engine.ts";

/** Names of the defs shipped in ext/subagents/agents, in discovery order. */
const BUILT_IN = ["Explore", "general-purpose", "Plan"];
const byName = (a: string, b: string) => a.localeCompare(b);

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

	const projectAgents = () => {
		const dir = join(cwd, CONFIG_DIR_NAME, "agents");
		mkdirSync(dir, { recursive: true });
		return dir;
	};

	it("offers Claude Code's built-ins, sorted, when the user has none", () => {
		const defs = discoverDefs(cwd, true);
		expect(defs.map((d) => d.name)).toEqual(BUILT_IN);
		expect(defs.every((d) => d.source === "built-in")).toBe(true);
	});

	it("keeps the built-ins when the user saves one of their own", () => {
		writeFileSync(join(userAgents, "mine.md"), def("mine"));
		expect(discoverDefs(cwd, true).map((d) => d.name)).toEqual([...BUILT_IN, "mine"].sort(byName));
	});

	it("lets a user def override a built-in of the same name, in place", () => {
		writeFileSync(join(userAgents, "Explore.md"), def("Explore", "my own explore"));
		const defs = discoverDefs(cwd, true);
		expect(defs.map((d) => d.name)).toEqual(BUILT_IN);
		const explore = defs.find((d) => d.name === "Explore");
		expect(explore?.description).toBe("my own explore");
		expect(explore?.source).toBe("user");
		expect(explore?.filePath).toBe(join(userAgents, "Explore.md"));
	});

	it("lets a trusted project def override a user def of the same name", () => {
		writeFileSync(join(userAgents, "mine.md"), def("mine", "user copy"));
		writeFileSync(join(projectAgents(), "mine.md"), def("mine", "project copy"));
		const mine = discoverDefs(cwd, true).find((d) => d.name === "mine");
		expect(mine?.description).toBe("project copy");
		expect(mine?.source).toBe("project");
	});

	it("never loads an untrusted project's defs, even ones that would override a user or built-in def", () => {
		writeFileSync(join(userAgents, "mine.md"), def("mine", "user copy"));
		const dir = projectAgents();
		writeFileSync(join(dir, "mine.md"), def("mine", "project copy"));
		writeFileSync(join(dir, "Explore.md"), def("Explore", "planted"));
		writeFileSync(join(dir, "repo-bot.md"), def("repo-bot"));
		const defs = discoverDefs(cwd, false);
		expect(defs.map((d) => d.name)).toEqual([...BUILT_IN, "mine"].sort(byName));
		expect(defs.find((d) => d.name === "mine")?.source).toBe("user");
		expect(defs.find((d) => d.name === "Explore")?.source).toBe("built-in");
	});

	it("finds the nearest ancestor's project agents from a subdirectory", () => {
		writeFileSync(join(projectAgents(), "repo-bot.md"), def("repo-bot"));
		const sub = join(cwd, "a", "b");
		mkdirSync(sub, { recursive: true });
		expect(discoverDefs(sub, true).find((d) => d.name === "repo-bot")?.source).toBe("project");
	});

	it("skips a def parseDef rejects, and keeps the rest of the directory", () => {
		// Both halves matter: a file that will not load must not appear, and it must
		// not take its neighbours down with it.
		writeFileSync(join(userAgents, "broken.md"), "---\nname: broken\n---\nno description\n");
		writeFileSync(join(userAgents, "colon.md"), def("plugin:thing"));
		writeFileSync(join(userAgents, "fine.md"), def("fine"));
		writeFileSync(join(userAgents, "notes.txt"), def("txt"));
		expect(discoverDefs(cwd, true).map((d) => d.name)).toEqual([...BUILT_IN, "fine"].sort(byName));
	});
});

describe("parseDef", () => {
	it("reads name, description and body", () => {
		expect(parseDef(def("scout", "looks around"))).toMatchObject({
			name: "scout",
			description: "looks around",
			systemPrompt: "You are scout.",
		});
	});

	it("names the reason a def would not load", () => {
		expect(parseDef("---\ndescription: no name\n---\nbody\n")).toEqual({
			problem: "the frontmatter declares no name:",
		});
		expect(parseDef("---\nname: x\n---\nbody\n")).toEqual({
			name: "x",
			problem: "missing required 'description' in frontmatter",
		});
		expect(parseDef("---\nname: x\ndescription: '   '\n---\nbody\n")).toMatchObject({
			problem: "missing required 'description' in frontmatter",
		});
		expect(parseDef("---\nname: x\ndescription: '\n---\nbody\n")).toMatchObject({
			problem: expect.stringContaining("not valid YAML"),
		});
	});

	it("rejects the names Claude Code rejects: a leading '-' or a ':'", () => {
		expect(parseDef(def("-rf"))).toEqual({ name: "-rf", problem: "names must not start with '-'" });
		expect(parseDef(def("plugin:thing"))).toMatchObject({ problem: expect.stringMatching(/must not contain ':'/) });
	});

	it("trims and NFKC-normalises the name, which is a lookup key", () => {
		expect(parseDef("---\nname: '  scout  '\ndescription: d\n---\nbody\n")).toMatchObject({ name: "scout" });
		// Fullwidth letters fold to ASCII, so a look-alike cannot shadow a real agent.
		expect(parseDef("---\nname: ｓｃｏｕｔ\ndescription: d\n---\nbody\n")).toMatchObject({ name: "scout" });
	});

	it("keeps tools as Claude Code writes them, in both spellings, commas inside a specifier kept", () => {
		const withTools = (v: string) => parseDef(`---\nname: x\ndescription: d\ntools: ${v}\n---\n`);
		expect(withTools("Read, Grep")).toMatchObject({ tools: ["Read", "Grep"] });
		expect(withTools("[Read, Grep]")).toMatchObject({ tools: ["Read", "Grep"] });
		expect(withTools('"Agent(a, b), Bash(git *)"')).toMatchObject({ tools: ["Agent(a, b)", "Bash(git *)"] });
		expect(withTools('""')).not.toHaveProperty("tools");
	});

	it("turns an escaped \\n in the description into a line break", () => {
		expect(parseDef("---\nname: x\ndescription: 'one\\ntwo'\n---\n")).toMatchObject({ description: "one\ntwo" });
	});
});

describe("parseDef: Claude Code frontmatter fields", () => {
	const withFm = (fm: string) => parseDef(`---\nname: x\ndescription: d\n${fm}\n---\nbody\n`);

	it("reads disallowedTools in both spellings", () => {
		expect(withFm("disallowedTools: Write, Edit")).toMatchObject({ disallowedTools: ["Write", "Edit"] });
		expect(withFm("disallowedTools: [Write]")).toMatchObject({ disallowedTools: ["Write"] });
	});

	it("reads model, spelling inherit one way", () => {
		expect(withFm("model: sonnet")).toMatchObject({ model: "sonnet" });
		expect(withFm("model: Inherit")).toMatchObject({ model: "inherit" });
		expect(withFm("model: ''")).not.toHaveProperty("model");
	});

	it("reads maxTurns only as a positive integer", () => {
		expect(withFm("maxTurns: 5")).toMatchObject({ maxTurns: 5 });
		expect(withFm("maxTurns: 0")).not.toHaveProperty("maxTurns");
		expect(withFm("maxTurns: 2.5")).not.toHaveProperty("maxTurns");
		expect(withFm("maxTurns: lots")).not.toHaveProperty("maxTurns");
	});

	it("reads skills and mcpServers as a list or a comma-separated string", () => {
		expect(withFm("skills:\n  - api-conventions\n  - tdd")).toMatchObject({ skills: ["api-conventions", "tdd"] });
		expect(withFm("skills: a, b")).toMatchObject({ skills: ["a", "b"] });
		expect(withFm("mcpServers: github, Docs")).toMatchObject({ mcpServers: ["github", "Docs"] });
	});

	it("maps permissionMode to Claude Code's names, accepting this layer's own, and drops unknown ones", () => {
		for (const [written, mode] of [
			["default", "default"],
			["ask", "default"],
			["manual", "default"],
			["acceptEdits", "acceptEdits"],
			["edits", "acceptEdits"],
			["auto", "auto"],
			["dontAsk", "dontAsk"],
			["bypassPermissions", "bypassPermissions"],
			["plan", "plan"],
		])
			expect(withFm(`permissionMode: ${written}`), written).toMatchObject({ permissionMode: mode });
		expect(withFm("permissionMode: yolo")).not.toHaveProperty("permissionMode");
	});

	it("reads memory, background, isolation, effort, color and omitClaudeMd, rejecting values outside their sets", () => {
		expect(
			withFm(
				"memory: project\nbackground: true\nisolation: worktree\neffort: xhigh\ncolor: cyan\nomitClaudeMd: true",
			),
		).toMatchObject({
			memory: "project",
			background: true,
			isolation: "worktree",
			effort: "xhigh",
			color: "cyan",
			omitClaudeMd: true,
		});
		const bad = withFm(
			"memory: shared\nbackground: yes\nisolation: docker\neffort: turbo\ncolor: mauve\nomitClaudeMd: no",
		);
		for (const key of ["memory", "background", "isolation", "effort", "color", "omitClaudeMd"])
			expect(bad).not.toHaveProperty(key);
	});
});

describe("isOneShot", () => {
	it("is true for Claude Code's Explore and Plan only", () => {
		expect(isOneShot({ name: "Explore" })).toBe(true);
		expect(isOneShot({ name: "Plan" })).toBe(true);
		expect(isOneShot({ name: "general-purpose" })).toBe(false);
		expect(isOneShot({ name: "explore" })).toBe(false);
	});
});

describe("findDef", () => {
	const d = (name: string): AgentDef => ({ name, description: "d", systemPrompt: "", source: "user", filePath: "" });
	const defs = [d("Explore"), d("code-reviewer"), d("general-purpose")];

	it("finds an exact name first", () => {
		expect(findDef(defs, "Explore")).toBe(defs[0]);
	});

	it("falls back to a case- and separator-insensitive match", () => {
		expect(findDef(defs, "explore")).toBe(defs[0]);
		expect(findDef(defs, "Code Reviewer")).toBe(defs[1]);
		expect(findDef(defs, " code_reviewer ")).toBe(defs[1]);
	});

	it("refuses an ambiguous name, naming the candidates, unless it matches one exactly", () => {
		const twins = [d("code-reviewer"), d("Code_Reviewer")];
		expect(findDef(twins, "code reviewer")).toEqual({
			error: "Agent type 'code reviewer' is ambiguous — matches code-reviewer, Code_Reviewer. Use the exact name: code-reviewer",
		});
		expect(findDef(twins, "Code_Reviewer")).toBe(twins[1]);
	});

	it("names the available agents for an unknown one", () => {
		expect(findDef(defs, "nope")).toEqual({
			error: "Agent type 'nope' not found. Available agents: Explore, code-reviewer, general-purpose",
		});
		expect(findDef([], "nope")).toEqual({ error: "Agent type 'nope' not found. Available agents: none" });
	});
});

describe("toolsLabel", () => {
	it("reads as Claude Code's listing does", () => {
		expect(toolsLabel({})).toBe("All tools");
		expect(toolsLabel({ tools: ["*"] })).toBe("*");
		expect(toolsLabel({ tools: ["Read", "Grep"] })).toBe("Read, Grep");
		expect(toolsLabel({ disallowedTools: ["Edit", "Write"] })).toBe("All tools except Edit, Write");
		expect(toolsLabel({ tools: ["Read", "Write"], disallowedTools: ["Write"] })).toBe("Read");
		expect(toolsLabel({ tools: ["Write"], disallowedTools: ["Write"] })).toBe("None");
	});
});

describe("resolveChildTools", () => {
	const mcpTools = ["mcp__s__one", "mcp__s__two", "mcp__t__x"];
	const pool = childToolPool({ canSpawn: true, mcpTools });
	const tools = (d: Pick<AgentDef, "tools" | "disallowedTools">, p: readonly string[] = pool) =>
		resolveChildTools(d, p);

	it("gives every tool in the pool when the def names none, or `*`", () => {
		expect(tools({}).tools).toEqual(pool);
		expect(tools({ tools: ["*"] }).tools).toEqual(pool);
	});

	it("maps Claude Code's tool names onto this layer's", () => {
		expect(tools({ tools: ["Read", "Glob", "Grep", "LS", "MultiEdit"] }).tools).toEqual([
			"read",
			"find",
			"grep",
			"ls",
			"edit",
		]);
		expect(tools({ tools: ["WebSearch"] }).tools).toEqual(["websearch", "get_search_content", "source_check"]);
		expect(tools({ tools: ["Task"] }).tools).toEqual(["agent", "send_message"]);
		expect(tools({ tools: ["TaskStop", "Monitor", "WebFetch"] }).tools).toEqual(["task_stop", "monitor", "webfetch"]);
	});

	it("takes a specifier as naming its whole tool", () => {
		expect(tools({ tools: ["Bash(git *)", "Agent(Explore, Plan)"] }).tools).toEqual([
			"bash",
			"agent",
			"send_message",
		]);
	});

	it("resolves MCP entries by exact tool, by server, and by wildcard", () => {
		expect(tools({ tools: ["mcp__s__one"] }).tools).toEqual(["mcp__s__one"]);
		expect(tools({ tools: ["mcp__s"] }).tools).toEqual(["mcp__s__one", "mcp__s__two"]);
		expect(tools({ tools: ["mcp__s__*"] }).tools).toEqual(["mcp__s__one", "mcp__s__two"]);
		expect(tools({ tools: ["mcp__*"] }).tools).toEqual(mcpTools);
		expect(tools({ tools: ["mcp__gone"] })).toEqual({ tools: [], invalid: [], unavailable: ["mcp__gone"] });
	});

	it("applies disallowedTools first, then the allowlist over what is left", () => {
		expect(tools({ tools: ["Read", "Write"], disallowedTools: ["Write"] }).tools).toEqual(["read"]);
		expect(tools({ disallowedTools: ["Agent", "Edit", "Write"] }).tools).not.toEqual(
			expect.arrayContaining(["agent", "send_message", "edit", "write"]),
		);
		expect(tools({ tools: ["*"], disallowedTools: ["mcp__s"] }).tools).toEqual(
			pool.filter((t) => !t.startsWith("mcp__s__")),
		);
	});

	it("tells an entry that names nothing from one that names a tool this child cannot have", () => {
		expect(tools({ tools: ["Read", "NotebookEdit", "Frobnicate"] })).toEqual({
			tools: ["read"],
			invalid: ["Frobnicate"],
			unavailable: ["NotebookEdit"],
		});
		// Past the depth cap the pool has no agent tools: the entry is recognised but unavailable.
		const capped = childToolPool({ canSpawn: false, mcpTools: [] });
		expect(tools({ tools: ["Agent"] }, capped)).toEqual({ tools: [], invalid: [], unavailable: ["Agent"] });
	});

	it("refuses a def whose tools resolve to nothing, saying why", () => {
		expect(zeroToolsError("x", { tools: [], invalid: ["Frob"], unavailable: ["NotebookEdit"] })).toBe(
			"Agent 'x' would be spawned with zero tools — refusing. Its tools list resolved to nothing: unrecognized [Frob]; not available to subagents [NotebookEdit]. Fix the agent's tools frontmatter or pass a different subagent_type.",
		);
		expect(zeroToolsError("x", { tools: [], invalid: [], unavailable: [] })).toMatch(
			/recognized but matched no tools in this session/,
		);
	});
});
