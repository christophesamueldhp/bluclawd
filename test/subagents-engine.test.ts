import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as forkSettings from "../ext/_shared/settings.ts";
import type { AgentDef } from "../ext/subagents/defs.ts";
import {
	agentMemoryPath,
	agentMemorySection,
	childLoaderOptions,
	childToolLists,
	effortToThinkingLevel,
	resolveChildMode,
	resolveModel,
	runSubagent,
} from "../ext/subagents/engine.ts";

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

	it("uses the def's declared mode when the parent is in ask, and auto when it declares none", () => {
		expect(resolveChildMode("ask", "edits")).toBe("edits");
		expect(resolveChildMode("ask", "ask")).toBe("ask");
		expect(resolveChildMode("ask", undefined)).toBe("auto");
	});
});

describe("childToolLists", () => {
	it("strips task from an allowlist and always excludes it", () => {
		expect(childToolLists(def({ tools: ["read", "task", "bash"] }))).toEqual({
			tools: ["read", "bash"],
			excludeTools: ["task"],
		});
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
			messages.push({ role: "user", content: [{ type: "text", text }] });
			for (let i = 0; i < turns && !aborted; i++) {
				messages.push({ role: "assistant", content: [{ type: "text", text: `turn ${i + 1}` }], stopReason: "end" });
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
