import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backgroundBashJobs } from "../ext/_shared/background-bash.ts";
import * as forkSettings from "../ext/_shared/settings.ts";
import { setActivePermissionMode } from "../ext/permissions/active-mode.ts";
import type { AgentDef } from "../ext/subagents/defs.ts";
import {
	AUTHORITY_NOTE,
	agentMemoryPath,
	agentMemorySection,
	childLoaderOptions,
	childSessionDir,
	childSystemPrompt,
	childToolPool,
	contextReminder,
	effortToThinkingLevel,
	environmentSection,
	forgetResumableForTests,
	gitStatusSnapshot,
	newAgentId,
	resolveChildMode,
	resolveModel,
	resumableChild,
	runSubagent,
	SUBAGENT_NOTES,
	subagentLimits,
} from "../ext/subagents/engine.ts";

const def = (over: Partial<AgentDef> = {}): AgentDef => ({
	name: "scout",
	description: "d",
	systemPrompt: "You are scout.",
	source: "user",
	filePath: "/x/scout.md",
	...over,
});

const model = (provider: string, id: string) => ({ provider, id, name: id }) as any;

const registry = (...models: Array<{ provider: string; id: string }>) => ({
	find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
	getAll: () => models,
});

const ENV_KEYS = [
	"HOME",
	"CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS",
	"CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
	"CLAUDE_CODE_SUBAGENT_MODEL",
];

/** A temp HOME (so the agent dir is private) and a temp cwd, restored after each test. */
function tempHome(prefix: string) {
	const dirs = { home: "", cwd: "" };
	let saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		dirs.home = mkdtempSync(join(tmpdir(), `bluclawd-${prefix}-home-`));
		dirs.cwd = mkdtempSync(join(tmpdir(), `bluclawd-${prefix}-cwd-`));
		saved = {};
		// getAgentDir() prefers <APP>_CODING_AGENT_DIR over $HOME; clear it by shape.
		const agentDirKeys = Object.keys(process.env).filter((key) => key.endsWith("_CODING_AGENT_DIR"));
		for (const key of [...ENV_KEYS, ...agentDirKeys]) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		process.env.HOME = dirs.home;
	});
	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		forgetResumableForTests();
		setActivePermissionMode("ask");
		rmSync(dirs.home, { recursive: true, force: true });
		rmSync(dirs.cwd, { recursive: true, force: true });
	});
	return dirs;
}

const writeSettings = (dir: string, value: object) => {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), JSON.stringify(value));
};

/**
 * A scripted child session: N assistant turns per prompt, abortable, all calls recorded.
 * Like pi, it notifies listeners of message_end before the stats count that message.
 * With a session manager attached, it also persists what it says, so the child can be
 * continued.
 */
function fakeSession(turns: number) {
	const messages: any[] = [];
	const listeners: Array<(e: any) => void> = [];
	const calls: string[] = [];
	let aborted = false;
	let ending: any;
	const counted = () => messages.filter((m) => m !== ending);
	const session: any = {
		state: { messages },
		sessionFile: undefined,
		sessionManager: undefined as SessionManager | undefined,
		subscribe(l: (e: any) => void) {
			listeners.push(l);
			return () => listeners.splice(listeners.indexOf(l), 1);
		},
		async abort() {
			aborted = true;
			calls.push("abort");
		},
		async steer(text: string) {
			calls.push(`steer:${text}`);
		},
		dispose() {
			calls.push("dispose");
		},
		getSessionStats() {
			const assistant = counted().filter((m) => m.role === "assistant");
			return {
				tokens: {
					input: 10 + assistant.reduce((sum, m) => sum + (m.usage?.input ?? 0), 0),
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
				},
				cost: 0.01,
				assistantMessages: assistant.length,
			};
		},
		async prompt(text: string) {
			calls.push(`prompt:${text}`);
			const user = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
			session.state.messages.push(user);
			session.sessionManager?.appendMessage(user);
			for (let i = 0; i < turns && !aborted; i++) {
				const message = {
					role: "assistant",
					content: [{ type: "text", text: `turn ${i + 1}` }],
					stopReason: "end",
					usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
					timestamp: Date.now(),
				};
				session.state.messages.push(message);
				session.sessionManager?.appendMessage(message);
				ending = message;
				for (const l of listeners) l({ type: "message_end", message });
				ending = undefined;
			}
		},
	};
	return { session, calls };
}

/** A child whose prompt runs until it is aborted. */
function hangingSession() {
	const fake = fakeSession(0);
	let wake: (() => void) | undefined;
	fake.session.prompt = async (text: string) => {
		fake.calls.push(`prompt:${text}`);
		fake.session.state.messages.push({
			role: "assistant",
			content: [{ type: "text", text: "halfway" }],
			stopReason: "end",
			timestamp: Date.now(),
		});
		await new Promise<void>((resolve) => {
			wake = resolve;
		});
	};
	fake.session.abort = async () => {
		fake.calls.push("abort");
		wake?.();
	};
	return fake;
}

/** createSession that records what it was given; `persist` keeps the transcript on disk. */
function creating(fake: { session: any }, o: { persist?: boolean } = {}) {
	const seen: any[] = [];
	const create = async (options: any) => {
		seen.push(options);
		if (o.persist) fake.session.sessionManager = options.sessionManager;
		return { session: fake.session };
	};
	return { seen, create };
}

describe("resolveModel", () => {
	const parent = model("anthropic", "claude-opus-5");
	const ctx = {
		model: parent,
		modelRegistry: registry(
			parent,
			model("anthropic", "claude-sonnet-4"),
			model("anthropic", "claude-sonnet-5"),
			model("other", "sonnet-9"),
			model("other", "kimi-k2"),
			model("more", "kimi-k2"),
			model("more", "glm-5"),
		),
	} as any;

	it("inherits the parent model when nothing is named or it says inherit", () => {
		expect(resolveModel(undefined, ctx, {})).toBe(parent);
		expect(resolveModel("  ", ctx, {})).toBe(parent);
		expect(resolveModel("Inherit", ctx, {})).toBe(parent);
	});

	it("resolves provider/id against the registry, falling back to the parent", () => {
		expect(resolveModel("other/sonnet-9", ctx, {})?.provider).toBe("other");
		expect(resolveModel("nope/nothing", ctx, {})).toBe(parent);
	});

	it("resolves a family alias to the parent when it is of that family, else the parent provider's newest", () => {
		expect(resolveModel("opus", ctx, {})).toBe(parent);
		expect(resolveModel("sonnet", ctx, {})?.id).toBe("claude-sonnet-5");
		expect(resolveModel("haiku", ctx, {})).toBe(parent);
		// Provider-neutral: another provider's model of the family is never picked.
		const kimi = { ...ctx, model: model("other", "kimi-k2") };
		expect(resolveModel("sonnet", kimi, {})?.id).toBe("sonnet-9");
		expect(resolveModel("opus", kimi, {})).toBe(kimi.model);
	});

	it("lets the user's subagents.models map any short name, over the family rule", () => {
		expect(resolveModel("sonnet", ctx, { sonnet: "other/kimi-k2" })?.provider).toBe("other");
		expect(resolveModel("fast", ctx, { fast: "more/glm-5" })?.id).toBe("glm-5");
	});

	it("accepts a bare model id only when exactly one provider offers it", () => {
		expect(resolveModel("glm-5", ctx, {})?.provider).toBe("more");
		expect(resolveModel("kimi-k2", ctx, {})).toBe(parent);
		expect(resolveModel("nothing", ctx, {})).toBe(parent);
	});
});

describe("effortToThinkingLevel", () => {
	it("maps Claude Code effort names onto pi thinking levels one to one", () => {
		expect(effortToThinkingLevel("low")).toBe("low");
		expect(effortToThinkingLevel("max")).toBe("max");
		expect(effortToThinkingLevel(undefined)).toBeUndefined();
	});
});

describe("resolveChildMode", () => {
	it("keeps a permissive parent's mode whatever the def declares", () => {
		for (const declared of [undefined, "default", "plan", "dontAsk", "acceptEdits"] as const) {
			expect(resolveChildMode("auto", declared)).toEqual({ mode: "auto", canPrompt: true });
			expect(resolveChildMode("edits", declared)).toEqual({ mode: "edits", canPrompt: true });
		}
	});

	it("uses the def's own mode under an ask parent", () => {
		expect(resolveChildMode("ask", undefined)).toEqual({ mode: "ask", canPrompt: true });
		expect(resolveChildMode("ask", "default")).toEqual({ mode: "ask", canPrompt: true });
		expect(resolveChildMode("ask", "acceptEdits")).toEqual({ mode: "edits", canPrompt: true });
		expect(resolveChildMode("ask", "auto")).toEqual({ mode: "auto", canPrompt: true });
	});

	it("never lets a def grant itself bypassPermissions", () => {
		expect(resolveChildMode("ask", "bypassPermissions")).toEqual({ mode: "ask", canPrompt: true });
	});

	it("makes dontAsk and plan children refuse whatever would prompt", () => {
		expect(resolveChildMode("ask", "dontAsk")).toEqual({ mode: "ask", canPrompt: false });
		expect(resolveChildMode("ask", "plan")).toEqual({ mode: "ask", canPrompt: false });
	});
});

describe("subagentLimits", () => {
	const saved: Record<string, string | undefined> = {};
	const keys = ENV_KEYS.filter((k) => k.startsWith("CLAUDE_CODE_"));
	beforeEach(() => {
		for (const key of keys) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});
	afterEach(() => {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	it("defaults to Claude Code's 20 at once and depth 3", () => {
		expect(subagentLimits(undefined)).toEqual({ maxConcurrent: 20, maxDepth: 3, model: undefined, aliases: {} });
	});

	it("reads settings, ignoring values that are not positive integers", () => {
		expect(subagentLimits({ maxConcurrent: 4, maxDepth: 1, model: "haiku", models: { a: "p/m" } })).toEqual({
			maxConcurrent: 4,
			maxDepth: 1,
			model: "haiku",
			aliases: { a: "p/m" },
		});
		expect(subagentLimits({ maxConcurrent: 0, maxDepth: -2 })).toMatchObject({ maxConcurrent: 20, maxDepth: 3 });
	});

	it("lets Claude Code's environment variables override settings", () => {
		process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = "2";
		process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = "5";
		process.env.CLAUDE_CODE_SUBAGENT_MODEL = "sonnet";
		expect(subagentLimits({ maxConcurrent: 4, maxDepth: 1, model: "haiku" })).toMatchObject({
			maxConcurrent: 2,
			maxDepth: 5,
			model: "sonnet",
		});
		process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = "lots";
		process.env.CLAUDE_CODE_SUBAGENT_MODEL = "inherit";
		expect(subagentLimits({ maxConcurrent: 4, model: "haiku" })).toMatchObject({ maxConcurrent: 4, model: "haiku" });
	});
});

describe("childToolPool", () => {
	it("holds pi's tools, web, task_stop and MCP, and the agent tools only below the depth cap", () => {
		const pool = childToolPool({ canSpawn: false, mcpTools: ["mcp__s__one"] });
		expect(pool).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "grep", "find", "ls", "monitor"]));
		expect(pool).toEqual(expect.arrayContaining(["webfetch", "websearch", "task_stop", "mcp__s__one"]));
		expect(pool).not.toContain("agent");
		expect(pool).not.toContain("send_message");
		expect(childToolPool({ canSpawn: true, mcpTools: [] })).toEqual(
			expect.arrayContaining(["agent", "send_message"]),
		);
	});
});

describe("the child's prompt, in Claude Code's shape", () => {
	it("puts the def body and memory before the authority note, the notes and the environment", () => {
		const prompt = childSystemPrompt({
			body: "BODY",
			memory: "MEMORY",
			cwd: "/w",
			isGit: true,
			model: model("p", "m"),
		});
		expect(prompt.split("\n\n").slice(0, 3)).toEqual(["BODY", "MEMORY", AUTHORITY_NOTE]);
		expect(prompt).toContain(SUBAGENT_NOTES);
		expect(prompt.endsWith("You are powered by the model named m. The exact model ID is m.")).toBe(true);
		expect(
			childSystemPrompt({ body: "", cwd: "/w", isGit: false, model: undefined }).startsWith(AUTHORITY_NOTE),
		).toBe(true);
	});

	it("describes the environment", () => {
		const env = environmentSection("/w", false, undefined);
		expect(env).toContain(" - Primary working directory: /w");
		expect(env).toContain(" - Is a git repository: false");
		expect(env).toContain(` - Platform: ${process.platform}`);
		expect(env).not.toContain("powered by");
	});

	it("sends the context files and git status as one system-reminder, or nothing", () => {
		expect(contextReminder([])).toBeUndefined();
		const text = contextReminder([{ path: "/w/AGENTS.md", content: "Use tabs.\n" }], "Current branch: main");
		expect(text?.startsWith("<system-reminder>\nAs you answer the user's questions")).toBe(true);
		expect(text).toContain("# claudeMd");
		expect(text).toContain("Contents of /w/AGENTS.md:\n\nUse tabs.");
		expect(text).toContain("# gitStatus\nCurrent branch: main");
		expect(text?.endsWith("</system-reminder>")).toBe(true);
		expect(contextReminder([], "x")).not.toContain("# claudeMd");
	});
});

describe("gitStatusSnapshot", () => {
	const dirs = tempHome("gitstatus");

	it("is undefined outside a repository", async () => {
		expect(await gitStatusSnapshot(dirs.cwd)).toBeUndefined();
	});

	it("reports branch, status and recent commits", async () => {
		const git = (...args: string[]) => execFileSync("git", ["-C", dirs.cwd, ...args], { stdio: "pipe" });
		git("init", "-q", "-b", "trunk");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "first commit");
		const clean = await gitStatusSnapshot(dirs.cwd);
		expect(clean).toContain("Current branch: trunk");
		expect(clean).toContain("Main branch (you will usually use this for PRs): main");
		expect(clean).toContain("Status:\n(clean)");
		expect(clean).toMatch(/Recent commits:\n[0-9a-f]+ first commit/);
		writeFileSync(join(dirs.cwd, "new.txt"), "x");
		expect(await gitStatusSnapshot(dirs.cwd)).toContain("?? new.txt");
	});
});

describe("agent memory", () => {
	const dirs = tempHome("memory");

	it("lives under the agent dir for user scope and under the project config dir otherwise", () => {
		expect(agentMemoryPath("user", "scout", dirs.cwd)).toBe(
			join(getAgentDir(), "agent-memory", "scout", "MEMORY.md"),
		);
		expect(agentMemoryPath("project", "scout", dirs.cwd)).toBe(
			join(dirs.cwd, CONFIG_DIR_NAME, "agent-memory", "scout", "MEMORY.md"),
		);
		expect(agentMemoryPath("local", "scout", dirs.cwd)).toBe(
			join(dirs.cwd, CONFIG_DIR_NAME, "agent-memory-local", "scout", "MEMORY.md"),
		);
	});

	it("tells the child where its memory is even before the file exists", () => {
		const section = agentMemorySection("project", "scout", dirs.cwd);
		expect(section.startsWith("# Persistent Agent Memory")).toBe(true);
		expect(section).toContain(join(dirs.cwd, CONFIG_DIR_NAME, "agent-memory", "scout"));
		expect(section).toContain("shared with your team via version control");
		expect(section.endsWith("Your MEMORY.md is currently empty.")).toBe(true);
	});

	it("injects the file's content, capped at 200 lines", () => {
		const path = agentMemoryPath("user", "scout", dirs.cwd);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, Array.from({ length: 300 }, (_, i) => `- note ${i}`).join("\n"));
		const section = agentMemorySection("user", "scout", dirs.cwd);
		expect(section).toContain("- note 199");
		expect(section).not.toContain("- note 200");
	});
});

describe("childLoaderOptions", () => {
	const dirs = tempHome("loader");
	const ctx = (trusted = true) => ({ cwd: dirs.cwd, isProjectTrusted: () => trusted }) as any;
	const names = (opts: ReturnType<typeof childLoaderOptions>) =>
		(opts.extensionFactories ?? []).map((e: any) => e.name as string);

	it("loads the project's context files only for a trusted project, and never when told to omit them", () => {
		expect(childLoaderOptions(ctx(true), def(), { mode: "auto", systemPrompt: "S" }).noContextFiles).toBe(false);
		expect(childLoaderOptions(ctx(false), def(), { mode: "auto", systemPrompt: "S" }).noContextFiles).toBe(true);
		expect(
			childLoaderOptions(ctx(true), def(), { mode: "auto", systemPrompt: "S", omitContext: true }).noContextFiles,
		).toBe(true);
	});

	it("loads nothing the child did not ask for, and uses its own system prompt instead of pi's", () => {
		const received: unknown[] = [];
		const opts = childLoaderOptions(ctx(), def(), {
			mode: "auto",
			systemPrompt: "CHILD PROMPT",
			onContextFiles: (files) => received.push(files),
		});
		expect(opts).toMatchObject({ noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
		expect(opts.systemPromptOverride?.("pi default")).toBe("CHILD PROMPT");
		const files = [{ path: "/w/AGENTS.md", content: "x" }];
		expect(opts.agentsFilesOverride?.({ agentsFiles: files })).toEqual({ agentsFiles: [] });
		expect(received).toEqual([files]);
	});

	it("puts the permission gate in every child, whatever else it loads", () => {
		const nested = { name: "subagents", factory: () => {} } as any;
		const mcp = [{ name: "s", status: "connected", toolNames: [], lend: () => {} }];
		for (const extras of [
			{},
			{ forkedAt: 5 },
			{ nested },
			{ mcp },
			{ background: true },
			{ forkedAt: 5, nested, mcp },
		]) {
			const opts = childLoaderOptions(ctx(false), def(), { mode: "ask", systemPrompt: "S", ...extras });
			expect(names(opts)[0], JSON.stringify(Object.keys(extras))).toBe("subagent-permission-gate");
			expect(names(opts)).toEqual(expect.arrayContaining(["subagent-sandboxed-bash", "subagent-web"]));
		}
	});

	it("adds the fork context hook, the nested subagents extension and lent MCP servers only when given", () => {
		const plain = names(childLoaderOptions(ctx(), def(), { mode: "auto", systemPrompt: "S" }));
		expect(plain).not.toContain("subagent-fork-context");
		expect(plain).not.toContain("subagents");
		expect(plain).not.toContain("subagent-mcp");
		const nested = { name: "subagents", factory: () => {} } as any;
		const all = names(
			childLoaderOptions(ctx(), def(), {
				mode: "auto",
				systemPrompt: "S",
				forkedAt: 5,
				nested,
				mcp: [{ name: "s", status: "connected", toolNames: [], lend: () => {} }],
			}),
		);
		expect(all).toEqual(expect.arrayContaining(["subagent-fork-context", "subagents", "subagent-mcp"]));
	});

	it("reads project settings from the parent's working tree, not a worktree child's checkout", () => {
		// The parent's uncommitted project settings are the ones in force; a fresh
		// worktree has whatever HEAD had, which may be nothing at all.
		writeSettings(join(dirs.cwd, CONFIG_DIR_NAME), { subagents: { maxDepth: 2 } });
		const worktree = mkdtempSync(join(tmpdir(), "bluclawd-wt-tree-"));
		try {
			const opts = childLoaderOptions(ctx(), def(), { mode: "auto", systemPrompt: "S", cwd: worktree });
			expect(opts.cwd).toBe(worktree);
			expect(forkSettings.subagents(opts.settingsManager)?.maxDepth).toBe(2);
			// And an untrusted project's settings are not read at all.
			const untrusted = childLoaderOptions(ctx(false), def(), { mode: "auto", systemPrompt: "S", cwd: worktree });
			expect(forkSettings.subagents(untrusted.settingsManager)?.maxDepth).toBeUndefined();
		} finally {
			rmSync(worktree, { recursive: true, force: true });
		}
	});
});

describe("ids and transcript dirs", () => {
	tempHome("ids");

	it("gives Claude Code's agent id shape", () => {
		const [a, b] = [newAgentId(), newAgentId()];
		expect(a).toMatch(/^a[0-9a-f]{16}$/);
		expect(a).not.toBe(b);
	});

	it("keeps children's transcripts under the agent dir, keyed by the parent session", () => {
		expect(childSessionDir({ sessionManager: { getSessionId: () => "p1" } } as any)).toBe(
			join(getAgentDir(), "subagents", "p1"),
		);
		expect(childSessionDir({} as any)).toBe(join(getAgentDir(), "subagents", "detached"));
	});
});

describe("runSubagent", () => {
	const dirs = tempHome("run");
	const ctx = (over: object = {}) =>
		({
			cwd: dirs.cwd,
			isProjectTrusted: () => true,
			model: model("p", "m"),
			modelRegistry: registry(model("p", "m"), model("p", "claude-sonnet-5"), model("p", "claude-haiku-4")),
			sessionManager: { getSessionId: () => "parent-1" },
			...over,
		}) as any;

	it("prompts the child with the task, reports its messages and usage, and disposes it", async () => {
		const fake = fakeSession(2);
		const { seen, create } = creating(fake);
		const result = await runSubagent({
			def: def({ tools: ["Read", "Agent"], disallowedTools: ["Write"], effort: "high" }),
			task: "look around",
			ctx: ctx(),
			createSession: create,
		});
		expect(result).toMatchObject({ status: "ok", agent: "scout", agentSource: "user", model: "p/m", toolUses: 0 });
		expect(result.usage.turns).toBe(2);
		expect(result.usage.input).toBe(200);
		expect(result.agentId).toMatch(/^a[0-9a-f]{16}$/);
		expect(result.messages.map((m: any) => m.content[0].text)).toEqual(["look around", "turn 1", "turn 2"]);
		expect(fake.calls).toEqual(["prompt:look around", "dispose"]);
		// No nested extension: Agent names a tool this child cannot have.
		expect(seen[0].tools).toEqual(["read"]);
		expect(seen[0].thinkingLevel).toBe("high");
		expect(seen[0].cwd).toBe(dirs.cwd);
		expect(seen[0].sessionManager.getSessionDir()).toBe(join(getAgentDir(), "subagents", "parent-1"));
	});

	it("gives a child the agent tools when it is handed its own subagents extension", async () => {
		const { seen, create } = creating(fakeSession(1));
		await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			nested: { name: "subagents", factory: () => {} } as any,
			sessionDir: join(dirs.home, "root-dir"),
			createSession: create,
		});
		expect(seen[0].tools).toEqual(expect.arrayContaining(["agent", "send_message", "task_stop"]));
		expect(seen[0].sessionManager.getSessionDir()).toBe(join(dirs.home, "root-dir"));
	});

	it("builds the child's system prompt from its definition, never pi's default prompt", async () => {
		const { seen, create } = creating(fakeSession(1));
		await runSubagent({ def: def(), task: "t", ctx: ctx(), createSession: create });
		const prompt = seen[0].resourceLoader.getSystemPrompt() as string;
		expect(prompt.startsWith("You are scout.\n\n")).toBe(true);
		expect(prompt).toContain(AUTHORITY_NOTE);
		expect(prompt).toContain(`Primary working directory: ${dirs.cwd}`);
		expect(prompt).toContain("The exact model ID is m.");
	});

	it("loads the gate into the child it builds", async () => {
		const { seen, create } = creating(fakeSession(1));
		await runSubagent({ def: def(), task: "t", ctx: ctx(), createSession: create });
		const loaded = seen[0].resourceLoader.getExtensions().extensions as Array<{
			path: string;
			handlers: Map<string, unknown>;
		}>;
		const gate = loaded.find((e) => e.path.includes("subagent-permission-gate"));
		expect(gate?.handlers.has("tool_call")).toBe(true);
	});

	it("opens with the project's context files for a trusted project only, and none for omitClaudeMd", async () => {
		writeFileSync(join(dirs.cwd, "AGENTS.md"), "Always use tabs.\n");
		const run = async (trusted: boolean, over: Partial<AgentDef> = {}) => {
			const fake = fakeSession(1);
			await runSubagent({
				def: def(over),
				task: "the task",
				ctx: ctx({ isProjectTrusted: () => trusted }),
				createSession: creating(fake).create,
			});
			return fake.calls[0];
		};
		const trusted = await run(true);
		expect(trusted.startsWith("prompt:<system-reminder>\n")).toBe(true);
		expect(trusted).toContain("Always use tabs.");
		expect(trusted.endsWith("</system-reminder>\n\nthe task")).toBe(true);
		expect(await run(false)).toBe("prompt:the task");
		expect(await run(true, { omitClaudeMd: true })).toBe("prompt:the task");
	});

	it("adds the git status snapshot in a repository", async () => {
		const git = (...args: string[]) => execFileSync("git", ["-C", dirs.cwd, ...args], { stdio: "pipe" });
		git("init", "-q");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
		const fake = fakeSession(1);
		const { seen, create } = creating(fake);
		await runSubagent({ def: def(), task: "t", ctx: ctx(), createSession: create });
		expect(fake.calls[0]).toContain("# gitStatus\nThis is the git status");
		expect(seen[0].resourceLoader.getSystemPrompt()).toContain("Is a git repository: true");
	});

	it("preloads a def's skills, but never an untrusted project's", async () => {
		const skill = join(dirs.cwd, CONFIG_DIR_NAME, "skills", "tdd");
		mkdirSync(skill, { recursive: true });
		writeFileSync(join(skill, "SKILL.md"), "---\nname: tdd\ndescription: red green\n---\nWrite the test first.\n");
		const run = async (trusted: boolean) => {
			const fake = fakeSession(1);
			await runSubagent({
				def: def({ skills: ["tdd"] }),
				task: "t",
				ctx: ctx({ isProjectTrusted: () => trusted }),
				createSession: creating(fake).create,
			});
			return fake.calls[0];
		};
		const trusted = await run(true);
		expect(trusted).toContain('The "tdd" skill is loaded.');
		expect(trusted).toContain("Write the test first.");
		expect(await run(false)).toBe("prompt:t");
	});

	it("appends agent memory, but never reads an untrusted repo's project memory", async () => {
		const path = agentMemoryPath("project", "scout", dirs.cwd);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "- planted\n");
		const prompt = async (trusted: boolean, memory: AgentDef["memory"]) => {
			const { seen, create } = creating(fakeSession(1));
			await runSubagent({
				def: def({ memory, tools: ["Grep"] }),
				task: "t",
				ctx: ctx({ isProjectTrusted: () => trusted }),
				createSession: create,
			});
			return { prompt: seen[0].resourceLoader.getSystemPrompt() as string, tools: seen[0].tools };
		};
		const trusted = await prompt(true, "project");
		expect(trusted.prompt).toContain("# Persistent Agent Memory");
		expect(trusted.prompt).toContain("- planted");
		// Memory needs its file tools, whatever the allowlist says.
		expect(trusted.tools).toEqual(["grep", "read", "write", "edit"]);
		const untrusted = await prompt(false, "project");
		expect(untrusted.prompt).not.toContain("planted");
		expect(untrusted.prompt).not.toContain("# Persistent Agent Memory");
		expect((await prompt(false, "user")).prompt).toContain("# Persistent Agent Memory");
	});

	it("picks the model: the call's, else the def's, else subagents.model, else the parent's", async () => {
		const modelOf = async (over: { call?: string; def?: string }) => {
			const { seen, create } = creating(fakeSession(1));
			const result = await runSubagent({
				def: def({ model: over.def }),
				task: "t",
				model: over.call,
				ctx: ctx(),
				createSession: create,
			});
			return { id: seen[0].model?.id, reported: result.model };
		};
		expect(await modelOf({ call: "sonnet", def: "haiku" })).toEqual({
			id: "claude-sonnet-5",
			reported: "p/claude-sonnet-5",
		});
		expect((await modelOf({ def: "haiku" })).id).toBe("claude-haiku-4");
		expect((await modelOf({})).id).toBe("m");
		writeSettings(getAgentDir(), { subagents: { model: "haiku" } });
		expect((await modelOf({})).id).toBe("claude-haiku-4");
		process.env.CLAUDE_CODE_SUBAGENT_MODEL = "sonnet";
		expect((await modelOf({})).id).toBe("claude-sonnet-5");
	});

	it("refuses a def whose tools resolve to nothing, before building a session", async () => {
		let built = false;
		const result = await runSubagent({
			def: def({ name: "bad", tools: ["NotebookEdit", "Frob"] }),
			task: "t",
			ctx: ctx(),
			createSession: async () => {
				built = true;
				return { session: fakeSession(1).session };
			},
		});
		expect(built).toBe(false);
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toBe(
			"Agent 'bad' would be spawned with zero tools — refusing. Its tools list resolved to nothing: unrecognized [Frob]; not available to subagents [NotebookEdit]. Fix the agent's tools frontmatter or pass a different subagent_type.",
		);
	});

	it("at the depth cap, does not count agent/send_message as tools the child has", async () => {
		let built = false;
		const nested = { name: "subagents", factory: () => {} };
		const result = await runSubagent({
			def: def({ name: "delegator", tools: ["Agent"] }),
			task: "t",
			ctx: ctx(),
			nested,
			canSpawn: false,
			createSession: async () => {
				built = true;
				return { session: fakeSession(1).session };
			},
		});
		expect(built).toBe(false);
		expect(result.errorMessage).toMatch(/^Agent 'delegator' would be spawned with zero tools/);
	});

	it.each([
		[false, true],
		[true, false],
	])("background: %s — ends the child's running shells with its final response: %s", async (background, reaped) => {
		const fake = fakeSession(1);
		let jobId = "";
		const result = await runSubagent({
			def: def({}),
			task: "start a server",
			ctx: ctx(),
			background,
			createSession: async (o: any) => {
				const owner = o.sessionManager.getSessionId();
				const prompt = fake.session.prompt;
				fake.session.prompt = async (text: string) => {
					jobId = backgroundBashJobs.start({
						command: "server",
						cwd: dirs.cwd,
						owner,
						agentId: owner,
						exec: (_c, _w, { signal }) =>
							new Promise((_r, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))),
					}).id;
					await prompt(text);
				};
				return { session: fake.session };
			},
		});
		expect(result.status).toBe("ok");
		expect(backgroundBashJobs.get(jobId)?.killed).toBe(reaped);
		backgroundBashJobs.kill(jobId);
	});

	it("stops a child at maxTurns — not one turn over — and marks the result partial", async () => {
		const fake = fakeSession(5);
		const result = await runSubagent({
			def: def({ maxTurns: 2 }),
			task: "t",
			ctx: ctx(),
			createSession: creating(fake).create,
		});
		expect(result).toMatchObject({ status: "ok", partial: true, stopReason: "max-turns", turnCap: 2 });
		expect(result.usage.turns).toBe(2);
		expect(fake.calls).toContain("abort");
	});

	it("counts turns and reports messages from this run only, not the history the session starts with", async () => {
		const fake = fakeSession(5);
		fake.session.state.messages.push(
			{ role: "user", content: [{ type: "text", text: "parent ask" }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "parent turn" }], stopReason: "end", timestamp: 2 },
			{ role: "assistant", content: [{ type: "text", text: "parent turn 2" }], stopReason: "end", timestamp: 3 },
		);
		const result = await runSubagent({
			def: def({ maxTurns: 2 }),
			task: "t",
			ctx: ctx(),
			createSession: creating(fake).create,
		});
		expect(result.usage.turns).toBe(2);
		expect(result.messages.map((m: any) => m.content[0].text)).toEqual(["t", "turn 1", "turn 2"]);
	});

	it("keeps the child's output when compaction replaces its message list mid-run", async () => {
		const fake = fakeSession(0);
		for (let i = 0; i < 4; i++)
			fake.session.state.messages.push({ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 });
		fake.session.prompt = async () => {
			fake.session.state.messages = [
				{ role: "compactionSummary", summary: "…", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "final answer" }],
					stopReason: "end",
					timestamp: Date.now(),
				},
			];
		};
		const result = await runSubagent({ def: def(), task: "t", ctx: ctx(), createSession: creating(fake).create });
		expect((result.messages.at(-1) as any).content[0].text).toBe("final answer");
	});

	it("fails closed when the parent already aborted, without building a session", async () => {
		let built = false;
		const controller = new AbortController();
		controller.abort();
		const result = await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			signal: controller.signal,
			createSession: async () => {
				built = true;
				return { session: fakeSession(1).session };
			},
		});
		expect(result).toMatchObject({ status: "failed", stopReason: "aborted" });
		expect(built).toBe(false);
	});

	it("honours an abort that lands while the session is being built, and still disposes it", async () => {
		const fake = fakeSession(1);
		const controller = new AbortController();
		const result = await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			signal: controller.signal,
			createSession: async () => {
				controller.abort();
				return { session: fake.session };
			},
		});
		expect(result).toMatchObject({ status: "failed", stopReason: "aborted" });
		expect(fake.calls).toEqual(["dispose"]);
	});

	it("aborts a running child when the parent's signal fires, reporting it failed", async () => {
		const fake = hangingSession();
		const controller = new AbortController();
		const done = runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			signal: controller.signal,
			createSession: creating(fake).create,
		});
		await new Promise((r) => setTimeout(r, 20));
		controller.abort();
		const result = await done;
		expect(result).toMatchObject({ status: "failed", stopReason: "aborted", errorMessage: "Subagent was aborted." });
		expect(fake.calls).toEqual(["prompt:t", "abort", "dispose"]);
		expect(getFinalOutputText(result)).toBe("halfway");
	});

	it("reports a child whose last turn errored, or whose prompt threw, as failed", async () => {
		const errored = fakeSession(0);
		errored.session.prompt = async () => {
			errored.session.state.messages.push({
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "rate limited",
				timestamp: Date.now(),
			});
		};
		expect(
			await runSubagent({ def: def(), task: "t", ctx: ctx(), createSession: creating(errored).create }),
		).toMatchObject({ status: "failed", stopReason: "error", errorMessage: "rate limited" });
		const threw = fakeSession(0);
		threw.session.prompt = async () => {
			throw new Error("socket closed");
		};
		expect(
			await runSubagent({ def: def(), task: "t", ctx: ctx(), createSession: creating(threw).create }),
		).toMatchObject({ status: "failed", stopReason: "error", errorMessage: "socket closed" });
		expect(threw.calls).toContain("dispose");
	});

	it("reports a session that could not be built as a failed result instead of throwing", async () => {
		const result = await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			createSession: async () => {
				throw new Error("no model");
			},
		});
		expect(result).toMatchObject({ status: "failed", errorMessage: "no model" });
	});

	it("hands the live session to onSession, and runs what it returns at the end", async () => {
		const fake = fakeSession(1);
		const events: string[] = [];
		await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			createSession: creating(fake).create,
			onSession: (session) => {
				void session.steer("change course");
				events.push("session");
				return () => events.push("released");
			},
		});
		expect(events).toEqual(["session", "released"]);
		expect(fake.calls).toContain("steer:change course");
	});

	it("refuses to start past subagents.maxConcurrent, and counts the slot free again afterwards", async () => {
		writeSettings(getAgentDir(), { subagents: { maxConcurrent: 1 } });
		const hanging = hangingSession();
		const controller = new AbortController();
		let started: () => void = () => {};
		const building = new Promise<void>((r) => {
			started = r;
		});
		const first = runSubagent({
			def: def(),
			task: "a",
			ctx: ctx(),
			signal: controller.signal,
			createSession: async () => {
				started();
				return { session: hanging.session };
			},
		});
		await building;
		const second = await runSubagent({
			def: def(),
			task: "b",
			ctx: ctx(),
			createSession: creating(fakeSession(1)).create,
		});
		expect(second.status).toBe("failed");
		expect(second.errorMessage).toMatch(/^Concurrent subagent limit reached\. You can run 1 subagents at once\./);
		controller.abort();
		await first;
		const third = await runSubagent({
			def: def(),
			task: "c",
			ctx: ctx(),
			createSession: creating(fakeSession(1)).create,
		});
		expect(third.status).toBe("ok");
	});

	it("gives a new child a fresh id, or the one it was handed", async () => {
		const run = (agentId?: string) =>
			runSubagent({ def: def(), task: "t", agentId, ctx: ctx(), createSession: creating(fakeSession(1)).create });
		const [a, b] = [await run(), await run()];
		expect(a.agentId).not.toBe(b.agentId);
		expect((await run("a0123456789abcdef")).agentId).toBe("a0123456789abcdef");
	});
});

const getFinalOutputText = (result: { messages: any[] }) =>
	result.messages
		.filter((m) => m.role === "assistant")
		.at(-1)
		?.content.map((c: any) => c.text)
		.join("");

describe("continuing a finished child", () => {
	const dirs = tempHome("resume");
	const ctx = () =>
		({
			cwd: dirs.cwd,
			isProjectTrusted: () => true,
			model: model("p", "m"),
			modelRegistry: registry(model("p", "m"), model("x", "other")),
			sessionManager: { getSessionId: () => "parent-1" },
		}) as any;

	/** A finished child whose transcript is on disk; returns its id. */
	async function finishedChild(over: Partial<AgentDef> = {}, callModel?: string): Promise<string> {
		const result = await runSubagent({
			def: def({ name: "keeper", tools: ["Read"], ...over }),
			task: "t",
			model: callModel,
			ctx: ctx(),
			createSession: creating(fakeSession(1), { persist: true }).create,
		});
		expect(result.status).toBe("ok");
		return result.agentId as string;
	}

	it("remembers a finished child by its id, with its definition", async () => {
		const id = await finishedChild();
		expect(resumableChild(id)).toEqual({ agent: "keeper" });
		expect(resumableChild("ghost")).toBeUndefined();
	});

	it.each(["Explore", "Plan"])("never remembers %s, which Claude Code makes one-shot", async (name) => {
		const id = await finishedChild({ name });
		expect(resumableChild(id)).toBeUndefined();
	});

	it("fails a continuation of an id it never ran", async () => {
		const result = await runSubagent({
			def: def(),
			task: "more",
			ctx: ctx(),
			resume: "ghost",
			createSession: async () => {
				throw new Error("must not build");
			},
		});
		expect(result).toMatchObject({ status: "failed", errorMessage: 'No agent with id "ghost" to continue.' });
	});

	it("reopens the child's own transcript, def and model, and sends the message as it is", async () => {
		const id = await finishedChild({}, "x/other");
		const fake = fakeSession(1);
		const { seen, create } = creating(fake);
		const result = await runSubagent({
			def: def({ name: "wrong-def" }),
			task: "more",
			ctx: ctx(),
			resume: id,
			createSession: create,
		});
		expect(result).toMatchObject({ status: "ok", agentId: id, agent: "keeper", model: "x/other" });
		expect(seen[0].tools).toEqual(["read"]);
		expect(seen[0].model.id).toBe("other");
		expect(fake.calls[0]).toBe("prompt:more");
		const texts = seen[0].sessionManager.buildSessionContext().messages.map((m: any) => m.content[0].text);
		expect(texts).toEqual(["t", "turn 1"]);
	});

	it("refuses a second continuation of a child that is still running", async () => {
		const id = await finishedChild();
		const slow = hangingSession();
		const controller = new AbortController();
		const first = runSubagent({
			def: def(),
			task: "a",
			ctx: ctx(),
			resume: id,
			signal: controller.signal,
			createSession: creating(slow).create,
		});
		await new Promise((r) => setTimeout(r, 20));
		const second = await runSubagent({
			def: def(),
			task: "b",
			ctx: ctx(),
			resume: id,
			createSession: creating(fakeSession(1)).create,
		});
		expect(second.status).toBe("failed");
		expect(second.errorMessage).toMatch(/already running/);
		controller.abort();
		await first;
		// Once it is done, it can be continued again.
		const third = await runSubagent({
			def: def(),
			task: "c",
			ctx: ctx(),
			resume: id,
			createSession: creating(fakeSession(1)).create,
		});
		expect(third.status).toBe("ok");
	});

	it("fails a continuation whose transcript is gone instead of silently starting fresh", async () => {
		const id = await finishedChild();
		rmSync(join(getAgentDir(), "subagents", "parent-1"), { recursive: true, force: true });
		const result = await runSubagent({
			def: def(),
			task: "b",
			ctx: ctx(),
			resume: id,
			createSession: async () => {
				throw new Error("must not build");
			},
		});
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toMatch(/transcript .* is gone/);
	});
});

describe("worktree isolation", () => {
	const dirs = tempHome("worktree");
	const git = (...args: string[]) => execFileSync("git", ["-C", dirs.cwd, ...args], { stdio: "pipe" }).toString();
	beforeEach(() => {
		git("init", "-q");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
	});
	const ctx = () =>
		({
			cwd: dirs.cwd,
			isProjectTrusted: () => true,
			model: model("p", "m"),
			modelRegistry: registry(model("p", "m")),
			sessionManager: { getSessionId: () => "parent-1" },
		}) as any;
	const ID = "a00000000000000ab";
	const wtPath = () => join(realpathSync(dirs.cwd), CONFIG_DIR_NAME, "worktrees", `agent-${ID}`);

	it("runs the child in Claude Code's agent worktree and removes it, branch too, when it changed nothing", async () => {
		let seen: string | undefined;
		const result = await runSubagent({
			def: def({ isolation: "worktree" }),
			task: "t",
			agentId: ID,
			ctx: ctx(),
			createSession: async (o) => {
				seen = o.cwd;
				expect(existsSync(join(o.cwd as string, ".git"))).toBe(true);
				return { session: fakeSession(1).session };
			},
		});
		expect(seen).toBe(wtPath());
		expect(existsSync(wtPath())).toBe(false);
		expect(git("branch", "--list", `worktree-agent-${ID}`).trim()).toBe("");
		expect(result.worktreePath).toBeUndefined();
		expect(readFileSync(join(dirs.cwd, ".git", "info", "exclude"), "utf-8")).toContain(
			`${CONFIG_DIR_NAME}/worktrees`,
		);
	});

	it("takes isolation from the call as well as the def", async () => {
		let seen: string | undefined;
		await runSubagent({
			def: def(),
			task: "t",
			agentId: ID,
			isolation: "worktree",
			ctx: ctx(),
			createSession: async (o) => {
				seen = o.cwd;
				return { session: fakeSession(1).session };
			},
		});
		expect(seen).toBe(wtPath());
	});

	it("keeps a worktree the child changed, reports it, and continues the child there", async () => {
		const result = await runSubagent({
			def: def({ isolation: "worktree" }),
			task: "t",
			agentId: ID,
			ctx: ctx(),
			createSession: async (o: any) => {
				writeFileSync(join(o.cwd, "new.txt"), "x");
				const fake = fakeSession(1);
				fake.session.sessionManager = o.sessionManager;
				return { session: fake.session };
			},
		});
		expect(result.worktreePath).toBe(wtPath());
		expect(result.worktreeBranch).toBe(`worktree-agent-${ID}`);
		expect(existsSync(join(wtPath(), "new.txt"))).toBe(true);

		const { seen, create } = creating(fakeSession(1));
		await runSubagent({ def: def(), task: "more", ctx: ctx(), resume: ID, createSession: create });
		expect(seen[0].cwd).toBe(wtPath());
	});

	it("keeps a worktree the child committed in, though its status is clean", async () => {
		const result = await runSubagent({
			def: def({ isolation: "worktree" }),
			task: "t",
			agentId: ID,
			ctx: ctx(),
			createSession: async (o) => {
				const wt = (...args: string[]) => execFileSync("git", ["-C", o.cwd as string, ...args], { stdio: "pipe" });
				writeFileSync(join(o.cwd as string, "new.txt"), "x");
				wt("add", "new.txt");
				wt("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "work");
				return { session: fakeSession(1).session };
			},
		});
		expect(result.worktreePath).toBe(wtPath());
		expect(existsSync(join(wtPath(), "new.txt"))).toBe(true);
	});

	it("gives a worktree child the parent's uncommitted project settings", async () => {
		writeSettings(join(dirs.cwd, CONFIG_DIR_NAME), { subagents: { maxDepth: 2 } });
		const { seen, create } = creating(fakeSession(1));
		await runSubagent({
			def: def({ isolation: "worktree" }),
			task: "t",
			agentId: ID,
			ctx: ctx(),
			createSession: create,
		});
		expect(seen[0].cwd).toBe(wtPath());
		expect(existsSync(join(wtPath(), CONFIG_DIR_NAME, "settings.json"))).toBe(false);
		expect(forkSettings.subagents(seen[0].settingsManager)?.maxDepth).toBe(2);
	});

	it("fails before building a session when no worktree can be made", async () => {
		rmSync(join(dirs.cwd, ".git"), { recursive: true, force: true });
		const result = await runSubagent({
			def: def({ isolation: "worktree" }),
			task: "t",
			ctx: ctx(),
			createSession: async () => {
				throw new Error("must not build");
			},
		});
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toMatch(/^Could not create a worktree/);
	});
});

describe("forks", () => {
	const dirs = tempHome("fork");
	const parentModel = model("p", "m");
	const ctx = () =>
		({
			cwd: dirs.cwd,
			isProjectTrusted: () => true,
			model: parentModel,
			modelRegistry: registry(parentModel, model("x", "other")),
			sessionManager: { getSessionId: () => "parent-1" },
			getSystemPrompt: () => "LIVE PROMPT",
		}) as any;

	function parentSession() {
		const parent = SessionManager.create(dirs.cwd, join(dirs.home, "parent-sessions"));
		parent.appendMessage({ role: "user", content: [{ type: "text", text: "the plan" }], timestamp: 1 } as any);
		parent.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 } as any);
		return {
			sessionFile: parent.getSessionFile() as string,
			leafId: parent.getLeafId() as string,
			forkedAt: 5,
			systemPrompt: `PARENT PROMPT\n\nCurrent working directory: ${dirs.cwd}`,
		};
	}

	it("branches the parent's conversation into the child's own session dir", async () => {
		const fork = parentSession();
		const { seen, create } = creating(fakeSession(1));
		const result = await runSubagent({
			def: def({ name: "fork" }),
			task: "t",
			ctx: ctx(),
			fork,
			createSession: create,
		});
		expect(result.status).toBe("ok");
		const child = seen[0].sessionManager as SessionManager;
		expect(child.getSessionDir()).toBe(join(getAgentDir(), "subagents", "parent-1"));
		expect(child.getSessionFile()).not.toBe(fork.sessionFile);
		expect(child.buildSessionContext().messages.map((m: any) => m.content[0].text)).toEqual(["the plan", "ok"]);
	});

	it("inherits the parent's prompt, model and whole tool pool, and gets the directive as its message", async () => {
		const fake = fakeSession(1);
		const { seen, create } = creating(fake);
		await runSubagent({
			def: def({ name: "fork", tools: ["Read"] }),
			task: "find the bug",
			model: "x/other",
			ctx: ctx(),
			fork: parentSession(),
			createSession: create,
		});
		expect(seen[0].model).toBe(parentModel);
		expect(seen[0].tools).toEqual(childToolPool({ canSpawn: false, mcpTools: [] }));
		expect(seen[0].resourceLoader.getSystemPrompt()).toBe("PARENT PROMPT");
		expect(fake.calls[0].startsWith("prompt:<fork-boilerplate>")).toBe(true);
		expect(fake.calls[0].endsWith("Your directive: find the bug")).toBe(true);
	});

	it("caps a fork at Claude Code's 200 turns", async () => {
		const result = await runSubagent({
			def: def({ name: "fork" }),
			task: "t",
			ctx: ctx(),
			fork: parentSession(),
			createSession: creating(fakeSession(205)).create,
		});
		expect(result).toMatchObject({ partial: true, turnCap: 200 });
		expect(result.usage.turns).toBe(200);
	});

	it("fails a fork whose parent session cannot be opened, without building a session", async () => {
		const result = await runSubagent({
			def: def({ name: "fork" }),
			task: "t",
			ctx: ctx(),
			fork: { sessionFile: join(dirs.cwd, "missing.jsonl"), leafId: "nope", forkedAt: 5, systemPrompt: "" },
			createSession: async () => {
				throw new Error("must not build");
			},
		});
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toMatch(/^Could not fork the parent conversation/);
	});
});
