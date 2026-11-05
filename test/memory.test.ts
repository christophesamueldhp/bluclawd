import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionUIContext,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryExtension } from "../ext/memory/index.ts";
import { saveMemoryEnabled } from "../ext/memory/prefs.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `bluclawd-memory-${prefix}-`)));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function gitRepo(): string {
	const repo = makeTempDir("repo");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], {
		cwd: repo,
	});
	return repo;
}

/** The system prompt text a model call saw, sections included. */
function systemText(context: { messages: Array<{ role: string }> }): string {
	return JSON.stringify(context.messages.filter((message) => message.role === "system"));
}

const textOf = (content: unknown) =>
	(content as Array<{ type: string; text?: string }>).map((part) => part.text ?? "").join("\n");

/** A pi session on a faux model with the memory extension; each prompt records the system prompt the model saw. */
async function startSession(cwd: string, agentDir: string) {
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	const faux = fauxProvider({ provider: "faux-memory", models: [{ id: "faux-main" }] });
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [createMemoryExtension({ agentDir })],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model: faux.getModel("faux-main"),
		thinkingLevel: "low",
		noTools: "builtin",
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
	});
	/** The user's picks for each select, in order: each gets the options and returns one, or undefined to cancel. */
	const picks: Array<(options: string[]) => string | undefined> = [];
	const selects: Array<{ title: string; options: string[] }> = [];
	const notices: string[] = [];
	const ui = {
		select: async (title: string, options: string[]) => {
			selects.push({ title, options });
			return picks.shift()?.(options);
		},
		notify: (message: string) => notices.push(message),
	};
	const uiContext = new Proxy(ui, {
		get: (target, key) => (target as Record<string | symbol, unknown>)[key] ?? (() => {}),
	});
	await session.bindExtensions({ mode: "tui", uiContext: uiContext as unknown as ExtensionUIContext });

	const seen: string[] = [];
	const toolResults: string[] = [];
	/** Runs one prompt; `steps` are the model's replies, each after recording the system prompt it saw. */
	const prompt = async (steps: FauxResponseStep[]) => {
		faux.setResponses(
			steps.map((step) => (context, options, state, model) => {
				seen.push(systemText(context));
				for (const message of context.messages as Array<{ role: string; content?: unknown }>) {
					if (message.role === "toolResult") toolResults.push(textOf(message.content));
				}
				return typeof step === "function" ? step(context, options, state, model) : step;
			}),
		);
		await session.prompt("go", { expandPromptTemplates: false });
	};
	/** Runs `/memory`, answering its selects with `answers`. */
	const command = async (...answers: Array<(options: string[]) => string | undefined>) => {
		picks.push(...answers);
		await session.prompt("/memory");
	};
	return { session, prompt, seen, toolResults, command, selects, notices };
}

const save = (memory: { name: string; description: string; type: string; body: string }) =>
	fauxAssistantMessage([fauxToolCall("memory", { action: "save", ...memory })], { stopReason: "toolUse" });

describe("memory", () => {
	it("gives a later session in the same Project the Memory an earlier session saved", async () => {
		const repo = gitRepo();
		const agentDir = makeTempDir("agent");

		const first = await startSession(repo, agentDir);
		await first.prompt([
			save({
				name: "user-role",
				description: "The user is a data scientist new to TypeScript",
				type: "user",
				body: "The user is a data scientist, new to TypeScript.",
			}),
			fauxAssistantMessage("Saved."),
		]);
		first.session.dispose();

		const second = await startSession(repo, agentDir);
		await second.prompt([fauxAssistantMessage("Hi.")]);
		expect(second.seen[0]).toContain("[user-role](user-role.md)");
		expect(second.seen[0]).toContain("The user is a data scientist new to TypeScript");
		second.session.dispose();
	});

	it("shares one Project across a repository's subdirectories and worktrees, and keeps a directory outside git apart", async () => {
		const repo = gitRepo();
		const agentDir = makeTempDir("agent");
		const subdir = join(repo, "src");
		mkdirSync(subdir);
		const worktree = join(makeTempDir("wt"), "feature");
		execFileSync("git", ["worktree", "add", "-q", "-b", "feature", worktree], { cwd: repo });

		const first = await startSession(subdir, agentDir);
		await first.prompt([
			save({
				name: "deploy-freeze",
				description: "Merge freeze until the release ships",
				type: "project",
				body: "Freeze.",
			}),
			fauxAssistantMessage("Saved."),
		]);
		first.session.dispose();

		for (const cwd of [repo, worktree]) {
			const later = await startSession(cwd, agentDir);
			await later.prompt([fauxAssistantMessage("Hi.")]);
			expect(later.seen[0]).toContain("[deploy-freeze](deploy-freeze.md)");
			later.session.dispose();
		}

		const elsewhere = await startSession(makeTempDir("plain"), agentDir);
		await elsewhere.prompt([fauxAssistantMessage("Hi.")]);
		expect(elsewhere.seen[0]).not.toContain("deploy-freeze");
		elsewhere.session.dispose();
	});

	it("tells the agent how to keep Memories even before the Project has any", async () => {
		const s = await startSession(gitRepo(), makeTempDir("agent"));
		await s.prompt([fauxAssistantMessage("Hi.")]);
		const prompt = s.seen[0].toLowerCase();
		for (const rule of ["user", "feedback", "project", "reference", "secret", "absolute date", "agents.md"]) {
			expect(prompt).toContain(rule);
		}
		s.session.dispose();
	});

	it("leaves out the memory tool, its guidance and the Memory index while memory is turned off", async () => {
		const agentDir = makeTempDir("agent");
		saveMemoryEnabled(agentDir, false);
		const s = await startSession(gitRepo(), agentDir);
		await s.prompt([fauxAssistantMessage("Hi.")]);
		expect(s.session.getActiveToolNames()).not.toContain("memory");
		expect(s.seen[0]).not.toContain("Memory index");
		s.session.dispose();

		saveMemoryEnabled(agentDir, true);
		const on = await startSession(gitRepo(), agentDir);
		await on.prompt([fauxAssistantMessage("Hi.")]);
		expect(on.session.getActiveToolNames()).toContain("memory");
		expect(on.seen[0]).toContain("Memory index");
		on.session.dispose();
	});

	it("keeps the session's system prompt unchanged after a save mid-session", async () => {
		const s = await startSession(gitRepo(), makeTempDir("agent"));
		await s.prompt([fauxAssistantMessage("Hi.")]);
		await s.prompt([
			save({ name: "tabs", description: "The user prefers tabs", type: "feedback", body: "Tabs." }),
			fauxAssistantMessage("Saved."),
		]);
		await s.prompt([fauxAssistantMessage("Hi again.")]);
		expect(new Set(s.seen).size).toBe(1);
		expect(s.seen[0]).not.toContain("tabs.md");
		s.session.dispose();
	});

	it.each([
		{ cap: "200 lines", count: 201, description: (i: number) => `Fact number ${i}` },
		{ cap: "25KB", count: 30, description: (i: number) => `Fact number ${i} ${"x".repeat(1000)}` },
	])(
		"caps the Memory index at $cap: the save past it warns, and a later session gets it truncated with a note",
		async ({ count, description }) => {
			const repo = gitRepo();
			const agentDir = makeTempDir("agent");
			const names = Array.from({ length: count }, (_, i) => `m-${String(i).padStart(3, "0")}`);
			const first = await startSession(repo, agentDir);
			await first.prompt([
				fauxAssistantMessage(
					names.map((name, i) =>
						fauxToolCall(
							"memory",
							{ action: "save", name, description: description(i), type: "project", body: "x" },
							{ id: `call_${i}` },
						),
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Saved."),
			]);
			expect(first.toolResults.at(0)).not.toMatch(/too long/i);
			expect(first.toolResults.at(-1)).toMatch(/too long/i);
			first.session.dispose();

			const later = await startSession(repo, agentDir);
			await later.prompt([fauxAssistantMessage("Hi.")]);
			expect(later.seen[0]).toContain("[m-000](m-000.md)");
			expect(later.seen[0]).not.toContain(`[${names.at(-1)}]`);
			expect(later.seen[0]).toMatch(/truncated/i);
			later.session.dispose();
		},
	);

	it("reads, replaces and deletes a Memory by name", async () => {
		const repo = gitRepo();
		const agentDir = makeTempDir("agent");
		const s = await startSession(repo, agentDir);
		const call = (args: Record<string, string>) =>
			fauxAssistantMessage([fauxToolCall("memory", args)], { stopReason: "toolUse" });
		await s.prompt([
			save({ name: "editor", description: "Uses vim", type: "user", body: "The user edits in vim." }),
			save({ name: "editor", description: "Uses helix", type: "user", body: "The user edits in helix." }),
			call({ action: "read", name: "editor" }),
			fauxAssistantMessage("Done."),
		]);
		expect(s.toolResults.at(-1)).toContain("The user edits in helix.");
		expect(s.toolResults.at(-1)).not.toContain("vim");

		await s.prompt([
			call({ action: "delete", name: "editor" }),
			call({ action: "read", name: "editor" }),
			fauxAssistantMessage("Done."),
		]);
		expect(s.toolResults.at(-1)).toContain('No Memory "editor"');
		s.session.dispose();

		const later = await startSession(repo, agentDir);
		await later.prompt([fauxAssistantMessage("Hi.")]);
		expect(later.seen[0]).not.toContain("editor");
		later.session.dispose();
	});
	it("keeps a description exactly as written, YAML-special characters included", async () => {
		const repo = gitRepo();
		const agentDir = makeTempDir("agent");
		const descriptions = [
			"Note: user prefers tabs",
			"[WIP] deploy freeze",
			"Uses tabs # not spaces",
			"123",
			"- dash first",
		];
		const first = await startSession(repo, agentDir);
		await first.prompt([
			...descriptions.map((description, i) => save({ name: `m-${i}`, description, type: "user", body: "x" })),
			fauxAssistantMessage("Saved."),
		]);
		expect(first.toolResults.every((result) => result.startsWith("Saved Memory"))).toBe(true);
		first.session.dispose();

		const later = await startSession(repo, agentDir);
		await later.prompt([fauxAssistantMessage("Hi.")]);
		for (const [i, description] of descriptions.entries()) {
			expect(later.seen[0]).toContain(`[m-${i}](m-${i}.md) — ${description}\\n`);
		}
		later.session.dispose();
	});

	it("goes on working past a hand-edited Memory with broken frontmatter, and ignores files not named as Memories", async () => {
		const repo = gitRepo();
		const agentDir = makeTempDir("agent");
		const dir = join(agentDir, "bluclawd", "memory", repo.replaceAll("/", "-"));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "broken.md"), "---\ndescription: Note: [unclosed\n---\n\nBody.\n");
		writeFileSync(join(dir, "Foo Bar.md"), "Not a Memory.\n");

		const first = await startSession(repo, agentDir);
		await first.prompt([
			save({ name: "tabs", description: "The user prefers tabs", type: "feedback", body: "Tabs." }),
			fauxAssistantMessage("Saved."),
		]);
		expect(first.toolResults.at(-1)).toContain('Saved Memory "tabs"');
		first.session.dispose();

		const later = await startSession(repo, agentDir);
		await later.prompt([fauxAssistantMessage("Hi.")]);
		expect(later.seen[0]).toContain("[tabs](tabs.md)");
		expect(later.seen[0]).toContain("[broken](broken.md)");
		expect(later.seen[0]).not.toContain("Foo Bar");
		later.session.dispose();
	});

	it("shares one Project across the worktrees of a bare repository", async () => {
		const bare = join(makeTempDir("bare"), "b.git");
		execFileSync("git", ["clone", "-q", "--bare", gitRepo(), bare]);
		const parent = makeTempDir("wts");
		const [one, two] = [join(parent, "one"), join(parent, "two")];
		execFileSync("git", ["worktree", "add", "-q", "-b", "one", one], { cwd: bare });
		execFileSync("git", ["worktree", "add", "-q", "-b", "two", two], { cwd: bare });
		mkdirSync(join(two, "src"));
		const agentDir = makeTempDir("agent");

		const first = await startSession(one, agentDir);
		await first.prompt([
			save({ name: "deploy-freeze", description: "Merge freeze", type: "project", body: "Freeze." }),
			fauxAssistantMessage("Saved."),
		]);
		first.session.dispose();

		const later = await startSession(join(two, "src"), agentDir);
		await later.prompt([fauxAssistantMessage("Hi.")]);
		expect(later.seen[0]).toContain("[deploy-freeze](deploy-freeze.md)");
		later.session.dispose();
	});
});

describe("/memory", () => {
	const option = (prefix: string) => (options: string[]) => options.find((o) => o.startsWith(prefix));

	it("lists the Project's Memories with the directory's path, shows one, and deletes it", async () => {
		const repo = gitRepo();
		const agentDir = makeTempDir("agent");
		const s = await startSession(repo, agentDir);
		await s.prompt([
			save({ name: "tabs", description: "The user prefers tabs", type: "feedback", body: "Tabs, never spaces." }),
			save({ name: "role", description: "The user is a designer", type: "user", body: "Designer." }),
			fauxAssistantMessage("Saved."),
		]);

		await s.command(option("tabs"), option("Delete"));
		const [list, shown] = s.selects;
		expect(list.title).toContain(join(agentDir, "bluclawd", "memory", repo.replaceAll("/", "-")));
		expect(list.options).toEqual(
			expect.arrayContaining(["role (user) — The user is a designer", "tabs (feedback) — The user prefers tabs"]),
		);
		expect(shown.title).toContain("Tabs, never spaces.");
		expect(s.notices.at(-1)).toContain('Deleted Memory "tabs"');

		await s.command(() => undefined);
		expect(s.selects.at(-1)?.options.some((o) => o.startsWith("tabs"))).toBe(false);
		s.session.dispose();
	});

	it("turns memory off and on, from the next session", async () => {
		const agentDir = makeTempDir("agent");
		const s = await startSession(gitRepo(), agentDir);
		await s.command(option("Turn memory off"));
		expect(s.notices.at(-1)).toMatch(/next session/i);
		expect(s.session.getActiveToolNames()).toContain("memory");
		s.session.dispose();

		const off = await startSession(gitRepo(), agentDir);
		expect(off.session.getActiveToolNames()).not.toContain("memory");
		await off.command(option("Turn memory on"));
		off.session.dispose();

		const on = await startSession(gitRepo(), agentDir);
		expect(on.session.getActiveToolNames()).toContain("memory");
		on.session.dispose();
	});
});
