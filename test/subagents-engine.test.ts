import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as forkSettings from "../ext/_shared/settings.ts";
import { setActivePermissionMode } from "../ext/permissions/active-mode.ts";
import type { AgentDef } from "../ext/subagents/defs.ts";
import {
	agentMemoryPath,
	agentMemorySection,
	childLoaderOptions,
	childToolLists,
	effortToThinkingLevel,
	forgetResumableForTests,
	resolveChildMode,
	resolveModel,
	resumableAgentName,
	runSubagent,
} from "../ext/subagents/engine.ts";
import { findRecord, missionsSection } from "../ext/subagents/records.ts";

const def = (over: Partial<AgentDef> = {}): AgentDef => ({
	name: "scout",
	description: "d",
	systemPrompt: "You are scout.",
	source: "user",
	filePath: "/x/scout.md",
	...over,
});

const model = (provider: string, id: string) => ({ provider, id }) as any;

const registry = (...models: Array<{ provider: string; id: string }>) => ({
	find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
	getAll: () => models,
});

describe("resolveModel", () => {
	const parent = model("opencode-go", "kimi-k2");
	const ctx = { model: parent, modelRegistry: registry(parent, model("anthropic", "claude-sonnet-5")) } as any;

	it("inherits the parent model when the def names none or says inherit", () => {
		expect(resolveModel(def(), ctx, {})).toBe(parent);
		expect(resolveModel(def({ model: "inherit" }), ctx, {})).toBe(parent);
	});

	it("resolves provider/id against the registry", () => {
		expect(resolveModel(def({ model: "anthropic/claude-sonnet-5" }), ctx, {})?.id).toBe("claude-sonnet-5");
	});

	it("resolves a short name through the user's alias map, never a built-in vendor table", () => {
		expect(resolveModel(def({ model: "sonnet" }), ctx, {})).toBe(parent);
		expect(resolveModel(def({ model: "sonnet" }), ctx, { sonnet: "anthropic/claude-sonnet-5" })?.id).toBe(
			"claude-sonnet-5",
		);
	});

	it("accepts a bare model id that exactly one configured provider offers", () => {
		expect(resolveModel(def({ model: "claude-sonnet-5" }), ctx, {})?.provider).toBe("anthropic");
	});

	it("falls back to the parent on anything unknown", () => {
		expect(resolveModel(def({ model: "nope/nothing" }), ctx, {})).toBe(parent);
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
	it("keeps a permissive parent mode regardless of what the def declares", () => {
		expect(resolveChildMode("auto", "ask")).toBe("auto");
		expect(resolveChildMode("edits", "ask")).toBe("edits");
	});

	it("uses the def's declared mode when the parent is in ask, and ask when it declares none", () => {
		expect(resolveChildMode("ask", "edits")).toBe("edits");
		expect(resolveChildMode("ask", "auto")).toBe("auto");
		expect(resolveChildMode("ask", undefined)).toBe("ask");
	});
});

describe("childToolLists", () => {
	it("strips task from an allowlist and always excludes it", () => {
		expect(childToolLists(def({ tools: ["read", "task", "bash"] }))).toEqual({
			tools: ["read", "bash"],
			excludeTools: ["task"],
		});
	});

	it("keeps task for a child allowed to nest, unless its allowlist leaves it out", () => {
		expect(childToolLists(def(), true)).toEqual({ tools: undefined, excludeTools: [] });
		expect(childToolLists(def({ tools: ["read", "task"] }), true).tools).toEqual(["read", "task"]);
	});

	it("adds disallowedTools to the exclusions and leaves an absent allowlist absent", () => {
		expect(childToolLists(def({ disallowedTools: ["write", "edit"] }))).toEqual({
			tools: undefined,
			excludeTools: ["task", "write", "edit"],
		});
	});
});

describe("agent memory", () => {
	let home: string;
	let cwd: string;
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-engine-home-"));
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-engine-cwd-"));
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

	it("lives under the agent dir for user scope and under the project config dir otherwise", () => {
		expect(agentMemoryPath("user", "scout", cwd)).toBe(join(getAgentDir(), "agent-memory", "scout", "MEMORY.md"));
		expect(agentMemoryPath("project", "scout", cwd)).toBe(
			join(cwd, CONFIG_DIR_NAME, "agent-memory", "scout", "MEMORY.md"),
		);
		expect(agentMemoryPath("local", "scout", cwd)).toBe(
			join(cwd, CONFIG_DIR_NAME, "agent-memory-local", "scout", "MEMORY.md"),
		);
	});

	it("tells the child where its memory is even before the file exists", () => {
		const section = agentMemorySection("project", "scout", cwd);
		expect(section).toContain("<agent_memory");
		expect(section).toContain(agentMemoryPath("project", "scout", cwd));
		expect(section).toMatch(/not instructions/);
	});

	it("injects the file's content, fenced as data", () => {
		const path = agentMemoryPath("user", "scout", cwd);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "- the build is slow\n");
		expect(agentMemorySection("user", "scout", cwd)).toContain("- the build is slow");
	});

	it("builds the child loader with CLAUDE.md only for a trusted project, and never for the read-only bundled seeds", () => {
		const ctx = (trusted: boolean) => ({ cwd, isProjectTrusted: () => trusted }) as any;
		expect(childLoaderOptions(ctx(true), def(), { mode: "auto" }).noContextFiles).toBe(false);
		expect(childLoaderOptions(ctx(false), def(), { mode: "auto" }).noContextFiles).toBe(true);
		const bundledExplore = def({ name: "explore", filePath: join(cwd, "agents", "explore.md") });
		expect(
			childLoaderOptions(ctx(true), bundledExplore, { mode: "auto", bundledDir: join(cwd, "agents") })
				.noContextFiles,
		).toBe(true);
	});

	it("appends the def body, then memory, then preloaded skills to the child's system prompt", () => {
		const skillsDir = join(cwd, CONFIG_DIR_NAME, "skills", "tdd");
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(
			join(skillsDir, "SKILL.md"),
			"---\nname: tdd\ndescription: red green\n---\nWrite the test first.\n",
		);
		const ctx = { cwd, isProjectTrusted: () => true } as any;
		const opts = childLoaderOptions(ctx, def({ memory: "project", skills: ["tdd"] }), { mode: "auto" });
		const appended = opts.appendSystemPrompt ?? [];
		expect(appended[0]).toBe("You are scout.");
		expect(appended[1]).toContain("<agent_memory");
		expect(appended[2]).toContain("<preloaded_skill");
		expect(appended[2]).toContain("Write the test first.");
	});
});

/** A scripted child session: N assistant turns per prompt, abortable, all calls recorded. */
function fakeSession(turns: number) {
	const messages: any[] = [];
	const listeners: Array<(e: any) => void> = [];
	const calls: string[] = [];
	let aborted = false;
	const session = {
		state: { messages },
		sessionId: "child-1",
		sessionFile: undefined,
		subscribe(l: (e: any) => void) {
			listeners.push(l);
			return () => listeners.splice(listeners.indexOf(l), 1);
		},
		async abort() {
			aborted = true;
			calls.push("abort");
		},
		dispose() {
			calls.push("dispose");
		},
		getSessionStats() {
			return {
				tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
				cost: 0.01,
				assistantMessages: messages.filter((m) => m.role === "assistant").length,
			};
		},
		async prompt(text: string) {
			calls.push(`prompt:${text}`);
			messages.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
			for (let i = 0; i < turns && !aborted; i++) {
				messages.push({
					role: "assistant",
					content: [{ type: "text", text: `turn ${i + 1}` }],
					stopReason: "end",
					timestamp: Date.now(),
				});
				for (const l of listeners) l({ type: "message_end" });
			}
		},
	};
	return { session, calls };
}

describe("runSubagent", () => {
	let cwd: string;
	let home: string;
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-run-home-"));
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-run-cwd-"));
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
	const ctx = () =>
		({ cwd, isProjectTrusted: () => true, model: model("p", "m"), modelRegistry: registry(model("p", "m")) }) as any;

	it("prompts the child with the task, reports its messages and usage, and disposes it", async () => {
		const fake = fakeSession(2);
		let received: any;
		const result = await runSubagent({
			def: def({ tools: ["read", "task"], disallowedTools: ["write"], effort: "high" }),
			task: "look around",
			ctx: ctx(),
			createSession: async (o) => {
				received = o;
				return { session: fake.session as any };
			},
		});
		expect(result.status).toBe("ok");
		expect(result.usage.turns).toBe(2);
		expect(result.agentId).toBe("child-1");
		expect(fake.calls).toEqual(["prompt:Task: look around", "dispose"]);
		expect(received.tools).toEqual(["read"]);
		expect(received.excludeTools).toEqual(["task", "write"]);
		expect(received.thinkingLevel).toBe("high");
		expect(received.cwd).toBe(cwd);
	});

	it("stops a child at maxTurns and marks the result partial", async () => {
		const fake = fakeSession(5);
		const result = await runSubagent({
			def: def({ maxTurns: 2 }),
			task: "t",
			ctx: ctx(),
			createSession: async () => ({ session: fake.session as any }),
		});
		expect(result.status).toBe("ok");
		expect(result.partial).toBe(true);
		expect(result.stopReason).toBe("max-turns");
		expect(result.usage.turns).toBe(2);
		expect(fake.calls).toContain("abort");
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
				return { session: fakeSession(1).session as any };
			},
		});
		expect(result.status).toBe("failed");
		expect(result.stopReason).toBe("aborted");
		expect(built).toBe(false);
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
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toBe("no model");
	});
});

describe("persistence, resume and worktrees", () => {
	let cwd: string;
	let home: string;
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-persist-home-"));
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-persist-cwd-"));
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
	const ctx = () =>
		({
			cwd,
			isProjectTrusted: () => true,
			model: model("p", "m"),
			modelRegistry: registry(model("p", "m")),
			sessionManager: { getSessionId: () => "parent-1" },
		}) as any;

	it("persists each child under the agent dir, keyed by the parent session, so transcripts outlive the call", async () => {
		let received: any;
		await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			createSession: async (o) => {
				received = o;
				return { session: fakeSession(1).session as any };
			},
		});
		expect(received.sessionManager.getSessionDir()).toBe(join(getAgentDir(), "subagents", "parent-1"));
	});

	it("fails a resume of an id it never ran", async () => {
		const result = await runSubagent({
			def: def(),
			task: "more",
			ctx: ctx(),
			resume: "ghost",
			createSession: async () => {
				throw new Error("must not build");
			},
		});
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toMatch(/ghost/);
	});

	it("reopens a finished child's session and def when resumed", async () => {
		const dir = join(getAgentDir(), "subagents", "parent-1");
		const first = SessionManager.create(cwd, dir);
		first.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as any);
		first.appendMessage({ role: "assistant", content: [{ type: "text", text: "yo" }], timestamp: Date.now() } as any);
		const file = first.getSessionFile();
		if (!file) throw new Error("session did not persist");
		const fake = fakeSession(1);
		fake.session.sessionId = first.getSessionId();
		(fake.session as any).sessionFile = file;
		await runSubagent({
			def: def({ name: "keeper", tools: ["read"] }),
			task: "t",
			ctx: ctx(),
			createSession: async () => ({ session: fake.session as any }),
		});

		let received: any;
		const result = await runSubagent({
			def: def({ name: "wrong-def" }),
			task: "more",
			ctx: ctx(),
			resume: first.getSessionId(),
			createSession: async (o) => {
				received = o;
				return { session: fakeSession(1).session as any };
			},
		});
		expect(result.status).toBe("ok");
		expect(result.agent).toBe("keeper");
		expect(received.tools).toEqual(["read"]);
		expect(received.sessionManager.getSessionFile()).toBe(file);
	});

	describe("worktree isolation", () => {
		const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString();
		beforeEach(() => {
			git("init", "-q");
			git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
		});

		it("runs the child in a detached worktree under the config dir and removes it when it made no changes", async () => {
			let seen: string | undefined;
			const result = await runSubagent({
				def: def({ isolation: "worktree" }),
				task: "t",
				ctx: ctx(),
				createSession: async (o) => {
					seen = o.cwd;
					expect(existsSync(join(o.cwd as string, ".git"))).toBe(true);
					return { session: fakeSession(1).session as any };
				},
			});
			expect(seen?.startsWith(join(realpathSync(cwd), CONFIG_DIR_NAME, "worktrees"))).toBe(true);
			expect(existsSync(seen as string)).toBe(false);
			expect(result.worktree).toBeUndefined();
			expect(readFileSync(join(cwd, ".git", "info", "exclude"), "utf-8")).toContain(`${CONFIG_DIR_NAME}/worktrees`);
			expect(result.agentId).toBeUndefined();
		});

		it("keeps a worktree the child changed and reports where it is", async () => {
			const result = await runSubagent({
				def: def({ isolation: "worktree" }),
				task: "t",
				ctx: ctx(),
				createSession: async (o) => {
					writeFileSync(join(o.cwd as string, "new.txt"), "x");
					return { session: fakeSession(1).session as any };
				},
			});
			expect(result.worktree).toBeDefined();
			expect(existsSync(join(result.worktree as string, "new.txt"))).toBe(true);
		});
	});
});

describe("worktree children keep the parent's settings and trust", () => {
	let cwd: string;
	let home: string;
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-wt-home-"));
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-wt-cwd-"));
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

	it("reads project settings from the parent's working tree, not the worktree's HEAD checkout", () => {
		// The parent's uncommitted project settings are the ones in force; a fresh
		// worktree has whatever HEAD had, which may be nothing at all.
		mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ subagents: { maxTurns: 3 } }));
		const worktree = mkdtempSync(join(tmpdir(), "bluclawd-wt-tree-"));
		const ctx = { cwd, isProjectTrusted: () => true } as any;
		const opts = childLoaderOptions(ctx, def(), { mode: "auto", cwd: worktree });
		expect(opts.cwd).toBe(worktree);
		expect(forkSettings.subagents(opts.settingsManager)?.maxTurns).toBe(3);
		rmSync(worktree, { recursive: true, force: true });
	});

	it("does not read project-scoped agent memory from an untrusted repo", () => {
		const path = agentMemoryPath("project", "scout", cwd);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "- planted\n");
		const untrusted = { cwd, isProjectTrusted: () => false } as any;
		const appended =
			childLoaderOptions(untrusted, def({ memory: "project" }), { mode: "auto" }).appendSystemPrompt ?? [];
		expect(appended.join("\n")).not.toContain("planted");
		expect(appended.join("\n")).not.toContain("<agent_memory");
		const trusted = { cwd, isProjectTrusted: () => true } as any;
		const ok = childLoaderOptions(trusted, def({ memory: "project" }), { mode: "auto" }).appendSystemPrompt ?? [];
		expect(ok.join("\n")).toContain("planted");
	});

	it("takes the child's id from its session manager after the run — pi 0.85 assigns it on first persist", async () => {
		const fake = fakeSession(1);
		const s = fake.session as any;
		delete s.sessionId;
		delete s.sessionFile;
		// pi 0.85 assigns the id on first persist, i.e. only once the prompt has run.
		s.sessionManager = {
			getSessionId: () => (s.state.messages.length > 0 ? "via-manager" : undefined),
			getSessionFile: () => "/tmp/via-manager.jsonl",
		};
		const result = await runSubagent({
			def: def(),
			task: "t",
			ctx: {
				cwd,
				isProjectTrusted: () => true,
				model: model("p", "m"),
				modelRegistry: registry(model("p", "m")),
			} as any,
			createSession: async () => ({ session: s }),
		});
		expect(result.agentId).toBe("via-manager");
	});
});

describe("timeouts, steering hooks and forked context", () => {
	let cwd: string;
	let home: string;
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-fork-home-"));
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-fork-cwd-"));
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
	const ctx = () =>
		({
			cwd,
			isProjectTrusted: () => true,
			model: model("p", "m"),
			modelRegistry: registry(model("p", "m")),
			sessionManager: { getSessionId: () => "parent-1" },
		}) as any;

	/** A child whose prompt runs until it is aborted. */
	function hangingSession() {
		const fake = fakeSession(0);
		let wake: (() => void) | undefined;
		const s = fake.session as any;
		s.prompt = async (text: string) => {
			fake.calls.push(`prompt:${text}`);
			s.state.messages.push({ role: "assistant", content: [{ type: "text", text: "halfway" }], stopReason: "end" });
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		};
		s.abort = async () => {
			fake.calls.push("abort");
			wake?.();
		};
		s.steer = async (text: string) => {
			fake.calls.push(`steer:${text}`);
		};
		return fake;
	}

	it("aborts a child that outlives its timeoutMs and reports the output as partial", async () => {
		const fake = hangingSession();
		const result = await runSubagent({
			def: def({ timeoutMs: 20 }),
			task: "t",
			ctx: ctx(),
			createSession: async () => ({ session: fake.session as any }),
		});
		expect(fake.calls).toContain("abort");
		expect(result.status).toBe("ok");
		expect(result.stopReason).toBe("timeout");
		expect(result.partial).toBe(true);
	});

	it("stops a child whose tool call outlives toolTimeoutMs, reporting partial output", async () => {
		const fake = hangingSession();
		const s = fake.session as any;
		const hang = s.prompt;
		s.prompt = async (text: string) => {
			const running = hang(text);
			for (const l of s.listeners ?? []) l({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash" });
			await running;
		};
		const subscribe = s.subscribe.bind(s);
		s.listeners = [];
		s.subscribe = (l: any) => {
			s.listeners.push(l);
			return subscribe(l);
		};
		const result = await runSubagent({
			def: def({ toolTimeoutMs: 20 }),
			task: "t",
			ctx: ctx(),
			createSession: async () => ({ session: s }),
		});
		expect(fake.calls).toContain("abort");
		expect(result.stopReason).toBe("tool-timeout");
		expect(result.partial).toBe(true);
		expect(result.status).toBe("ok");
	});

	it("stops a child at maxTokens, counted from this run only", async () => {
		const fake = fakeSession(5);
		const s = fake.session as any;
		let used = 1000;
		s.getSessionStats = () => ({
			tokens: { input: used, output: 0, cacheRead: 0, cacheWrite: 0 },
			cost: 0,
			assistantMessages: s.state.messages.filter((m: any) => m.role === "assistant").length,
		});
		const prompt = s.prompt.bind(s);
		const subscribe = s.subscribe.bind(s);
		s.subscribe = (l: any) =>
			subscribe((e: any) => {
				used += 100;
				l(e);
			});
		s.prompt = prompt;
		const result = await runSubagent({
			def: def({ maxTokens: 250 }),
			task: "t",
			ctx: ctx(),
			createSession: async () => ({ session: s }),
		});
		expect(result.stopReason).toBe("max-tokens");
		expect(result.partial).toBe(true);
		expect(result.usage.turns).toBe(3);
	});

	it("loads the tool budget into a child that declares one, and not otherwise", () => {
		const names = (d: AgentDef) =>
			childLoaderOptions(ctx(), d, { mode: "auto" }).extensionFactories?.map((e: any) => e.name);
		expect(names(def())).not.toContain("subagent-tool-budget");
		expect(names(def({ toolBudget: { hard: 3, block: "*" } }))).toContain("subagent-tool-budget");
	});

	it("hands the live session to onSession so a running child can be steered", async () => {
		const fake = hangingSession();
		let steered = false;
		const done = runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			createSession: async () => ({ session: fake.session as any }),
			onSession: (session) => {
				void session.steer("change course").then(() => {
					steered = true;
					void (fake.session as any).abort();
				});
				return undefined;
			},
		});
		await done;
		expect(steered).toBe(true);
		expect(fake.calls).toContain("steer:change course");
	});

	it("branches a forked child from the parent's session file into its own session dir", async () => {
		const parentDir = join(home, "parent-sessions");
		const parent = SessionManager.create(cwd, parentDir);
		parent.appendMessage({ role: "user", content: [{ type: "text", text: "the plan" }], timestamp: 1 } as any);
		parent.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 } as any);
		const sessionFile = parent.getSessionFile() as string;
		const leafId = parent.getLeafId() as string;

		let received: any;
		const result = await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			fork: { sessionFile, leafId, forkedAt: 5 },
			createSession: async (o) => {
				received = o;
				return { session: fakeSession(1).session as any };
			},
		});
		expect(result.status).toBe("ok");
		const child = received.sessionManager as SessionManager;
		expect(child.getSessionDir()).toBe(join(getAgentDir(), "subagents", "parent-1"));
		expect(child.getSessionFile()).not.toBe(sessionFile);
		const texts = child.buildSessionContext().messages.map((m: any) => m.content[0].text);
		expect(texts).toEqual(["the plan", "ok"]);
		expect(received.resourceLoader).toBeDefined();
	});

	it("counts turns and reports messages from this run only, not the history a fork or resume starts with", async () => {
		const fake = fakeSession(5);
		const s = fake.session as any;
		s.state.messages.push(
			{ role: "user", content: [{ type: "text", text: "parent ask" }], timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "parent turn" }], stopReason: "end", timestamp: 2 },
			{ role: "assistant", content: [{ type: "text", text: "parent turn 2" }], stopReason: "end", timestamp: 3 },
		);
		const result = await runSubagent({
			def: def({ maxTurns: 2 }),
			task: "t",
			ctx: ctx(),
			createSession: async () => ({ session: s }),
		});
		expect(result.usage.turns).toBe(2);
		expect(result.messages.map((m: any) => m.content[0].text)).toEqual(["Task: t", "turn 1", "turn 2"]);
	});

	it("compacts a fork whose inherited conversation is above subagents.forkCompactAbove, before the task", async () => {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(join(getAgentDir(), "settings.json"), JSON.stringify({ subagents: { forkCompactAbove: 50 } }));
		const parent = SessionManager.create(cwd, join(home, "parent-sessions"));
		parent.appendMessage({ role: "user", content: [{ type: "text", text: "x".repeat(2000) }], timestamp: 1 } as any);
		parent.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 } as any);
		const fork = {
			sessionFile: parent.getSessionFile() as string,
			leafId: parent.getLeafId() as string,
			forkedAt: 5,
		};
		const run = async (big: boolean) => {
			const fake = fakeSession(1);
			const s = fake.session as any;
			if (big)
				s.state.messages.push({ role: "user", content: [{ type: "text", text: "x".repeat(2000) }], timestamp: 1 });
			s.compact = async () => {
				fake.calls.push("compact");
			};
			await runSubagent({ def: def(), task: "t", ctx: ctx(), fork, createSession: async () => ({ session: s }) });
			return fake.calls;
		};
		expect((await run(true)).slice(0, 2)).toEqual(["compact", expect.stringMatching(/^prompt:/)]);
		expect(await run(false)).not.toContain("compact");
	});

	it("frames a forked child's task so it does not carry on the parent's requests", async () => {
		const parent = SessionManager.create(cwd, join(home, "parent-sessions"));
		parent.appendMessage({ role: "user", content: [{ type: "text", text: "use a subagent" }], timestamp: 1 } as any);
		parent.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 } as any);
		const fake = fakeSession(1);
		await runSubagent({
			def: def(),
			task: "find the bug",
			ctx: ctx(),
			fork: { sessionFile: parent.getSessionFile() as string, leafId: parent.getLeafId() as string, forkedAt: 5 },
			createSession: async () => ({ session: fake.session as any }),
		});
		const prompt = fake.calls[0];
		expect(prompt).toMatch(/parent/i);
		expect(prompt).toMatch(/do not carry out/i);
		expect(prompt.endsWith("find the bug")).toBe(true);
	});

	it("loads a nesting child's own task extension, uses the root's prompt bridge and session dir", async () => {
		let received: any;
		const nestedExt = { name: "subagents", factory: () => {} };
		const prompt = async () => true;
		await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			nested: { depth: 1, extension: nestedExt as any },
			prompt,
			sessionDir: join(home, "root-dir"),
			createSession: async (o) => {
				received = o;
				return { session: fakeSession(1).session as any };
			},
		});
		expect(received.excludeTools).toEqual([]);
		expect(received.sessionManager.getSessionDir()).toBe(join(home, "root-dir"));
		const loader = received.resourceLoader as any;
		expect(loader).toBeDefined();
	});

	it("puts the nested extension beside the gate in the child loader", () => {
		const nestedExt = { name: "subagents", factory: () => {} } as any;
		const opts = childLoaderOptions({ cwd, isProjectTrusted: () => true } as any, def(), {
			mode: "auto",
			nested: nestedExt,
		});
		expect(opts.extensionFactories?.map((e: any) => e.name)).toContain("subagents");
	});

	it("filters a forked child's inherited conversation", () => {
		const opts = childLoaderOptions({ cwd, isProjectTrusted: () => true } as any, def(), {
			mode: "auto",
			forkedAt: 5,
		});
		expect(opts.extensionFactories?.map((e: any) => e.name)).toContain("subagent-fork-context");
		const fresh = childLoaderOptions({ cwd, isProjectTrusted: () => true } as any, def(), { mode: "auto" });
		expect(fresh.extensionFactories?.map((e: any) => e.name)).not.toContain("subagent-fork-context");
	});

	it("fails a fork whose parent session cannot be opened, without building a session", async () => {
		const result = await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			fork: { sessionFile: join(cwd, "missing.jsonl"), leafId: "nope", forkedAt: 5 },
			createSession: async () => {
				throw new Error("must not build");
			},
		});
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toMatch(/fork/i);
	});
});

describe("run lifecycle hardening", () => {
	let cwd: string;
	let home: string;
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-life-home-"));
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-life-cwd-"));
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
	const ctx = () =>
		({
			cwd,
			isProjectTrusted: () => true,
			model: model("p", "m"),
			modelRegistry: registry(model("p", "m")),
			sessionManager: { getSessionId: () => "parent-1" },
		}) as any;

	/** A finished child on disk, registered as resumable; returns its id. */
	async function finishedChild(): Promise<string> {
		const dir = join(getAgentDir(), "subagents", "parent-1");
		const first = SessionManager.create(cwd, dir);
		first.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as any);
		first.appendMessage({ role: "assistant", content: [{ type: "text", text: "yo" }], timestamp: Date.now() } as any);
		const fake = fakeSession(1);
		fake.session.sessionId = first.getSessionId();
		(fake.session as any).sessionFile = first.getSessionFile();
		await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			createSession: async () => ({ session: fake.session as any }),
		});
		return first.getSessionId();
	}

	it("keeps the child's output when compaction replaces its message list mid-run", async () => {
		const fake = fakeSession(0);
		const s = fake.session as any;
		for (let i = 0; i < 4; i++)
			s.state.messages.push({ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 });
		s.prompt = async () => {
			s.state.messages = [
				{ role: "compactionSummary", summary: "…", timestamp: Date.now() },
				{
					role: "assistant",
					content: [{ type: "text", text: "final answer" }],
					stopReason: "end",
					timestamp: Date.now(),
				},
			];
		};
		const result = await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			createSession: async () => ({ session: s }),
		});
		expect(result.messages.map((m: any) => m.role)).toContain("assistant");
		expect((result.messages.at(-1) as any).content[0].text).toBe("final answer");
	});

	it("names the def a resumable child runs, for permission subjects", async () => {
		const id = await finishedChild();
		expect(resumableAgentName(id)).toBe("scout");
		expect(resumableAgentName("ghost")).toBeUndefined();
	});

	it("refuses a second resume of a child that is still running", async () => {
		const id = await finishedChild();
		let release: (() => void) | undefined;
		const slow = fakeSession(1);
		const s = slow.session as any;
		const original = s.prompt;
		s.prompt = async (text: string) => {
			await new Promise<void>((r) => {
				release = r;
			});
			return original(text);
		};
		const first = runSubagent({
			def: def(),
			task: "a",
			ctx: ctx(),
			resume: id,
			createSession: async () => ({ session: s }),
		});
		await new Promise((r) => setTimeout(r, 10));
		const second = await runSubagent({
			def: def(),
			task: "b",
			ctx: ctx(),
			resume: id,
			createSession: async () => ({ session: fakeSession(1).session as any }),
		});
		expect(second.status).toBe("failed");
		expect(second.errorMessage).toMatch(/already running/);
		release?.();
		expect((await first).status).toBe("ok");
	});

	it("fails a resume whose transcript is gone instead of silently starting fresh", async () => {
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
		expect(result.errorMessage).toMatch(/transcript/);
	});
});

describe("acceptance gates", () => {
	let cwd: string;
	let home: string;
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-gate2-home-"));
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-gate2-cwd-"));
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
	const ctx = () =>
		({
			cwd,
			isProjectTrusted: () => true,
			model: model("p", "m"),
			modelRegistry: registry(model("p", "m")),
			sessionManager: { getSessionId: () => "parent-1" },
		}) as any;

	/** Sessions backed by a real transcript file, so a failed gate can send the child back. */
	function sessions() {
		const prompts: string[] = [];
		const create = async (o: any) => {
			const fake = fakeSession(1);
			const s = fake.session as any;
			const sm = o.sessionManager as SessionManager;
			const original = s.prompt;
			s.prompt = async (text: string) => {
				prompts.push(text);
				sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as any);
				sm.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					timestamp: Date.now(),
				} as any);
				return original(text);
			};
			s.sessionManager = sm;
			return { session: s };
		};
		return { prompts, create };
	}
	const checks = (...outcomes: Array<"passed" | "failed" | "blocked">) => {
		const seen: Array<{ command: string; cwd: string }> = [];
		const run = async (command: string, o: { cwd: string }) => {
			seen.push({ command, cwd: o.cwd });
			return { outcome: outcomes[seen.length - 1] ?? "passed", output: `check #${seen.length} output` } as const;
		};
		return { seen, run };
	};

	it("runs the gate after a successful child and records that it passed", async () => {
		const { create } = sessions();
		const c = checks("passed");
		const result = await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			gate: "npm test",
			runCommand: c.run,
			createSession: create,
		});
		expect(c.seen).toEqual([{ command: "npm test", cwd }]);
		expect(result.status).toBe("ok");
		expect(result.gate).toEqual({ command: "npm test", passed: true, attempts: 1 });
	});

	it("sends the child back with the failure once, and passes when the fix holds", async () => {
		const { prompts, create } = sessions();
		const c = checks("failed", "passed");
		const result = await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			gate: "npm test",
			runCommand: c.run,
			createSession: create,
		});
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("check #1 output");
		expect(result.status).toBe("ok");
		expect(result.gate).toEqual({ command: "npm test", passed: true, attempts: 2 });
	});

	it("fails the child when the gate still fails, or is blocked", async () => {
		const failing = await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			gate: "npm test",
			runCommand: checks("failed", "failed").run,
			createSession: sessions().create,
		});
		expect(failing.status).toBe("failed");
		expect(failing.stopReason).toBe("gate");
		expect(failing.errorMessage).toContain("check #2 output");
		const c = checks("blocked");
		const blocked = await runSubagent({
			def: def(),
			task: "t",
			ctx: ctx(),
			gate: "rm -rf x",
			runCommand: c.run,
			createSession: sessions().create,
		});
		expect(blocked.status).toBe("failed");
		expect(c.seen).toHaveLength(1);
	});

	it("uses the def's gate when the call names none, and skips a gate after a failed child", async () => {
		const c = checks("passed");
		await runSubagent({
			def: def({ gate: "make check" }),
			task: "t",
			ctx: ctx(),
			runCommand: c.run,
			createSession: sessions().create,
		});
		expect(c.seen[0]?.command).toBe("make check");
		const none = checks();
		await runSubagent({
			def: def({ gate: "make check" }),
			task: "t",
			ctx: ctx(),
			runCommand: none.run,
			createSession: async () => {
				throw new Error("no model");
			},
		});
		expect(none.seen).toHaveLength(0);
	});
});

describe("external CLI runners", () => {
	let cwd: string;
	let home: string;
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-ext-home-"));
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-ext-cwd-"));
		saved = { HOME: process.env.HOME };
		for (const key of Object.keys(process.env)) {
			if (key.endsWith("_CODING_AGENT_DIR")) {
				saved[key] = process.env[key];
				delete process.env[key];
			}
		}
		process.env.HOME = home;
		setActivePermissionMode("auto");
	});
	afterEach(() => {
		setActivePermissionMode("ask");
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});
	const ctx = () =>
		({ cwd, isProjectTrusted: () => true, model: undefined, sessionManager: { getSessionId: () => "p" } }) as any;
	const noSession = async () => {
		throw new Error("an external runner builds no pi session");
	};

	it("pipes the def's prompt and the task to the command, and returns what it prints", async () => {
		const result = await runSubagent({
			def: def({ systemPrompt: "You are a CLI.", runner: { command: "cat", args: [] } }),
			task: "say hi",
			ctx: ctx(),
			createSession: noSession,
		});
		expect(result.status).toBe("ok");
		expect(result.model).toBe("external: cat");
		const out = (result.messages[0] as any).content[0].text;
		expect(out).toContain("You are a CLI.");
		expect(out).toContain("say hi");
		expect(result.agentId).toBeUndefined();
	});

	it("fails with the output when the command fails, and quotes its arguments", async () => {
		const seen: string[] = [];
		const result = await runSubagent({
			def: def({ runner: { command: "tool", args: ["-p", "it's"] } }),
			task: "t",
			ctx: ctx(),
			createSession: noSession,
			runCommand: async (command) => {
				seen.push(command);
				return { outcome: "failed", output: "boom" };
			},
		});
		expect(seen[0]).toMatch(/^tool -p 'it'\\''s' < .+$/);
		expect(result.status).toBe("failed");
		expect(result.errorMessage).toContain("boom");
	});

	it("refuses fork and resume, which need a pi session", async () => {
		const forked = await runSubagent({
			def: def({ runner: { command: "cat", args: [] } }),
			task: "t",
			ctx: ctx(),
			fork: { sessionFile: "/nope", leafId: "x", forkedAt: 1 },
			createSession: noSession,
		});
		expect(forked.status).toBe("failed");
		expect(forked.errorMessage).toMatch(/external/);
	});
});

describe("durable run records", () => {
	let cwd: string;
	let home: string;
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "bluclawd-rec-home-"));
		cwd = mkdtempSync(join(tmpdir(), "bluclawd-rec-cwd-"));
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
	const ctx = () =>
		({
			cwd,
			isProjectTrusted: () => true,
			model: model("p", "m"),
			modelRegistry: registry(model("p", "m")),
			sessionManager: { getSessionId: () => "parent-1" },
		}) as any;

	it("records a finished child with its mission, and resumes it after the in-memory registry is gone", async () => {
		const dir = join(getAgentDir(), "subagents", "parent-1");
		const first = SessionManager.create(cwd, dir);
		first.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as any);
		first.appendMessage({ role: "assistant", content: [{ type: "text", text: "yo" }], timestamp: Date.now() } as any);
		const fake = fakeSession(1);
		fake.session.sessionId = first.getSessionId();
		(fake.session as any).sessionFile = first.getSessionFile();
		await runSubagent({
			def: def({ name: "explore" }),
			task: "look",
			ctx: ctx(),
			mission: "login",
			createSession: async () => ({ session: fake.session as any }),
		});
		expect(findRecord(first.getSessionId())).toMatchObject({ agent: "explore", mission: "login", cwd, status: "ok" });
		expect(missionsSection(cwd).join("\n")).toMatch(/- login: 1 run; latest explore ok, agent id /);

		forgetResumableForTests();
		let received: any;
		const resumed = await runSubagent({
			def: def(),
			task: "more",
			ctx: ctx(),
			resume: first.getSessionId(),
			createSession: async (o) => {
				received = o;
				return { session: fakeSession(1).session as any };
			},
		});
		expect(resumed.status).toBe("ok");
		expect(resumed.agent).toBe("explore");
		expect(received.sessionManager.getSessionFile()).toBe(first.getSessionFile());
		expect(resumableAgentName(first.getSessionId())).toBe("explore");
	});
});

describe("external runner commands meet the user's Bash rules", () => {
	it("leaves plain words unquoted, so a deny rule such as Bash(codex *) matches the command", async () => {
		mkdirSync(getAgentDir(), { recursive: true });
		const { shellQuote } = await import("../ext/subagents/external.ts");
		expect(shellQuote("codex")).toBe("codex");
		expect(shellQuote("--model=gpt-5")).toBe("--model=gpt-5");
		expect(shellQuote("a b")).toBe("'a b'");
		expect(shellQuote("$(rm -rf x)")).toBe("'$(rm -rf x)'");
		expect(shellQuote("")).toBe("''");
		const rules = { deny: ["Bash(codex *)"] };
		const { evaluatePreHook } = await import("../ext/permissions/evaluate.ts");
		const verdict = evaluatePreHook(
			"bash",
			{ command: `${shellQuote("codex")} ${shellQuote("exec")} < ${shellQuote("/tmp/p.md")}` },
			{
				mode: "auto",
				rules,
				cliAllowRules: {},
				cwd: "/p",
				agentDir: "/a",
				configDirName: ".pi",
				hasUI: false,
			},
		);
		expect(verdict?.outcome).toBe("block");
	});
});
