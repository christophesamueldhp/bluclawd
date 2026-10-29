import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, Type } from "@earendil-works/pi-ai";
import {
	type ExtensionContext,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	type ToolLoadout,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AdmissionContext,
	type AdmissionResult,
	createRunAdmission,
	type LaunchParams,
	MAX_TASK_INPUT_BYTES,
	type RunAdmissionDeps,
	type RunExecutionContext,
} from "../ext/subagents/admission.ts";
import { SubagentMessageBus } from "../ext/subagents/messages.ts";
import { createParentScope } from "../ext/subagents/parent-scope.ts";
import { type AdmittedSubagentHandle, type SubagentRunRecord, SubagentRunScheduler } from "../ext/subagents/runs.ts";

function handleOf(result: AdmissionResult): AdmittedSubagentHandle {
	if (!result.ok) throw new Error(`Expected an admitted run, got: ${result.error}`);
	return result.handle;
}

function errorOf(result: AdmissionResult): string {
	if (result.ok) throw new Error(`Expected a refusal, got run ${result.handle.runId}`);
	return result.error;
}

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-admission-${prefix}-`));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

type LoadoutTool = ToolLoadout["callable"][number];

function loadoutOf(names: readonly string[]): ToolLoadout {
	const tools: LoadoutTool[] = names.map((name) => ({
		name,
		label: name,
		description: `The ${name} tool.`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: undefined }),
	}));
	return {
		declared: tools,
		callable: tools,
		registered: tools,
		getExposure: () => "direct",
		getNamespace: () => undefined,
		getPromptGuidelines: () => [],
	};
}

async function setup(
	options: { mode?: AdmissionContext["mode"]; settings?: unknown; firstGenerationCompletes?: boolean } = {},
) {
	const cwd = makeTempDir("cwd");
	const agentDir = makeTempDir("agent");
	if (options.settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	const faux = fauxProvider({
		provider: "faux-adm",
		models: [
			{ id: "faux-main", reasoning: true },
			{ id: "faux-alt", reasoning: false },
		],
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	const registry = new ModelRegistry(runtime);
	const sessionManager = SessionManager.inMemory(cwd);
	// Admitted runs stay live, so later launches see their names.
	const scheduler = new SubagentRunScheduler<RunExecutionContext>({
		executeRun: ({ record }) =>
			options.firstGenerationCompletes && !record.generation
				? Promise.resolve({
						status: "completed",
						complete: true,
						summaryText: "v1 done.",
						transcriptPath: join(agentDir, "transcript.jsonl"),
					})
				: new Promise(() => {}),
	});
	let loadout = loadoutOf(["probe"]);
	const scope = createParentScope({
		bus: new SubagentMessageBus(),
		cancelRuns: () => {},
		send: () => {},
		onChange: () => {},
		batchWindowMs: 0,
	});
	scope.enter({ sessionManager } as unknown as ExtensionContext, "replaced");
	const deps: RunAdmissionDeps = {
		scheduler,
		agentDir: () => agentDir,
		catalog: () => undefined,
		loadout: () => loadout,
		parentThinkingLevel: () => "low",
		scope,
	};
	const ctx: AdmissionContext = {
		cwd,
		mode: options.mode ?? "tui",
		model: faux.getModel("faux-main"),
		modelRegistry: registry,
		isProjectTrusted: () => false,
		sessionManager,
		executeTool: async () => {
			throw new Error("admission never runs tools");
		},
	};
	const admission = createRunAdmission(deps);
	let calls = 0;
	const launch = (params: LaunchParams, overrides: Partial<AdmissionContext> = {}, signal?: AbortSignal) =>
		admission.launch(
			{ toolCallId: `call_${++calls}`, parentTurnId: "turn_0", params, signal },
			{ ...ctx, ...overrides },
		);
	const resume = (
		run: Readonly<SubagentRunRecord>,
		buildPrompt: () => string,
		overrides: Partial<AdmissionContext> = {},
	) => {
		const resumeCtx = { ...ctx, ...overrides };
		return { result: admission.resume(run, buildPrompt, resumeCtx), ctx: resumeCtx };
	};
	const storageDir = join(agentDir, "bluclawd", "subagents", sessionManager.getSessionId());
	return {
		agentDir,
		resume,
		setLoadout: (names: readonly string[]) => {
			loadout = loadoutOf(names);
		},
		runtime,
		faux,
		scheduler,
		launch,
		storageDir,
		invalidateSession: () => scope.invalidate("Parent session switching"),
	};
}

function writeRole(agentDir: string, name: string, extra: string[] = []) {
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	writeFileSync(
		join(agentDir, "agents", `${name}.md`),
		["---", `name: ${name}`, `description: Role ${name}.`, ...extra, "---", "Do the assigned work."].join("\n"),
	);
}

describe("Run admission", () => {
	it("admits a saved role with the inherited model and the parent's thinking level, named after the role", async () => {
		const { launch, storageDir } = await setup();
		const first = await launch({ agent: "explorer", task: "Look." });
		const second = await launch({ agent: "explorer", task: "Look again." });
		expect(handleOf(first).record).toMatchObject({
			name: "explorer-1",
			agentName: "explorer",
			provider: "faux-adm",
			modelId: "faux-main",
			thinkingLevel: "low",
			deliveryMode: "foreground",
			taskSummary: "Look.",
		});
		expect(handleOf(second).record.name).toBe("explorer-2");
		// Admission checks the session's storage without leaving a directory of its own behind.
		expect(readdirSync(storageDir)).toEqual([]);
	});

	it("refuses missing input, oversized tasks, denied roles, unknown roles and background runs in one-shot modes", async () => {
		const { launch, storageDir } = await setup({ settings: { permissions: { deny: ["Subagent(explorer)"] } } });
		expect(errorOf(await launch({ agent: " ", task: "x" }))).toBe("Missing required parameter: agent");
		expect(errorOf(await launch({ agent: "reviewer", task: "  " }))).toBe("Missing required parameter: task");
		expect(errorOf(await launch({ agent: "reviewer", task: "x".repeat(MAX_TASK_INPUT_BYTES + 100) }))).toMatch(
			/Delegated task exceeds the 32768-byte limit \(32868 bytes\)/,
		);
		expect((await launch({ agent: "explorer", task: "x" })).ok).toBe(false);
		expect(errorOf(await launch({ agent: "nonexistent-role", task: "x" }))).toMatch(/nonexistent-role/);
		expect(existsSync(storageDir)).toBe(false);

		for (const mode of ["print", "json"] as const) {
			const oneShot = await setup({ mode });
			expect(errorOf(await oneShot.launch({ agent: "reviewer", task: "x", background: true }))).toContain(
				`not supported in one-shot "${mode}" mode`,
			);
		}
	});

	it("refuses a saved role that still declares the obsolete maxTurns field", async () => {
		const { agentDir, launch } = await setup();
		writeRole(agentDir, "explorer", ["maxTurns: 6"]);
		const error = errorOf(await launch({ agent: "explorer", task: "Inspect." }));
		expect(error).toMatch(/maxTurns/);
		expect(error).toMatch(/remove/i);
	});

	it("refuses roles naming tools the orchestrator lacks, and invalid inline roles, before model resolution or storage", async () => {
		const { agentDir, launch, storageDir } = await setup();
		writeRole(agentDir, "api-auditor", ["tools: [read, bash]", "model: missing/model"]);
		expect(errorOf(await launch({ agent: "api-auditor", task: "Verify." }))).toContain(
			'Subagent role "api-auditor" names tools the orchestrator cannot give a child: read, bash. Available: probe.',
		);

		const role = { name: "checker", description: "Checks.", instructions: "Check." };
		const cases = [
			{ agent: { ...role, name: "Bad Name" }, error: /Invalid agent name "Bad Name" in inline role/ },
			{ agent: { ...role, name: "sub_checker" }, error: /reserved task prefixes/ },
			{ agent: { ...role, description: "Bad\u0007desc" }, error: /control characters/ },
			{ agent: { ...role, instructions: "   " }, error: /non-empty instructions/ },
			{ agent: { ...role, tools: ["read", "bash"] }, error: /cannot give a child: read, bash/ },
			{ agent: { ...role, tools: ["rm -rf"] }, error: /invalid tool name "rm -rf"/ },
		];
		for (const c of cases) {
			expect(errorOf(await launch({ agent: c.agent, task: "Check." })), c.agent.name).toMatch(c.error);
		}
		expect(existsSync(storageDir)).toBe(false);
	});

	it("refuses a launch without the orchestrator's live tool context", async () => {
		const { launch } = await setup();
		expect(errorOf(await launch({ agent: "explorer", task: "x" }, { executeTool: undefined }))).toBe(
			"Subagent dispatch needs the orchestrator's live tool context.",
		);
	});

	it("resolves spawn over role over parent for model and thinking", async () => {
		const { agentDir, launch } = await setup();
		writeRole(agentDir, "tuned", ["model: faux-adm/faux-main", "thinkingLevel: high"]);
		const role = await launch({ agent: "tuned", task: "x" });
		expect(handleOf(role).record).toMatchObject({ modelId: "faux-main", thinkingLevel: "high" });
		const spawn = await launch({ agent: "tuned", task: "x", model: "faux-adm/faux-alt", thinkingLevel: "off" });
		expect(handleOf(spawn).record).toMatchObject({ modelId: "faux-alt", thinkingLevel: "off" });
		const inherited = await launch({ agent: "tuned", task: "x", thinkingLevel: "inherit" });
		expect(handleOf(inherited).record).toMatchObject({ modelId: "faux-main", thinkingLevel: "low" });
	});

	it("fails unknown models, missing auth, unsupported thinking and virtual routers with named errors before storage", async () => {
		const savedOpenAiKey = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		try {
			const { runtime, faux, launch, storageDir } = await setup();
			runtime.registerVirtualModel({
				provider: "virtual-router",
				id: "auto",
				name: "Virtual Auto Router",
				thinkingLevels: ["low", "high"],
				route: () => ({ model: faux.getModel("faux-main")!, thinkingLevel: "low" }),
			});
			await runtime.refresh({ allowNetwork: false });
			const cases: { args: Partial<LaunchParams>; error: RegExp }[] = [
				{ args: { model: "faux-adm/missing" }, error: /"faux-adm\/missing" is not available/ },
				{
					args: { model: "openai/gpt-4.1", thinkingLevel: "off" },
					error: /No authentication configured.*"openai"/,
				},
				{
					args: { model: "faux-adm/faux-alt", thinkingLevel: "high" },
					error: /Thinking level "high" is not supported.*faux-alt.*supported: off/,
				},
				{
					args: { model: "faux-adm/faux-alt", thinkingLevel: "inherit" },
					error: /Thinking level "low" is not supported/,
				},
				{
					args: { model: "virtual-router/auto" },
					error: /Virtual model "virtual-router\/auto" cannot be used by a subagent: virtual model routers are not inspectable/,
				},
				{ args: { thinkingLevel: "ultra" }, error: /Invalid subagent "thinkingLevel" value "ultra"/ },
				{ args: { model: "sonnet" }, error: /Invalid subagent "model" value "sonnet"/ },
			];
			for (const c of cases) {
				expect(
					errorOf(await launch({ agent: "explorer", task: "Report.", ...c.args })),
					JSON.stringify(c.args),
				).toMatch(c.error);
			}
			expect(existsSync(storageDir)).toBe(false);
		} finally {
			if (savedOpenAiKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAiKey;
		}
	});

	it("refuses reserved, malformed and live duplicate names", async () => {
		const { launch } = await setup();
		expect(errorOf(await launch({ agent: "explorer", task: "x", name: "parent" }))).toMatch(
			/Invalid subagent name "parent"/,
		);
		expect(errorOf(await launch({ agent: "explorer", task: "x", name: "Bad Name" }))).toMatch(
			/Invalid subagent name "Bad Name"/,
		);
		expect(errorOf(await launch({ agent: "explorer", task: "x", name: "sub_x" }))).toMatch(
			/Invalid subagent name "sub_x"/,
		);
		const held = await launch({ agent: "explorer", task: "x", name: "backend" });
		expect(errorOf(await launch({ agent: "reviewer", task: "x", name: "backend" }))).toBe(
			`Subagent name "backend" is already used by running agent ${handleOf(held).runId}; choose another name.`,
		);
	});

	it("refuses a launch whose session was replaced while model authentication was awaited", async () => {
		const { runtime, launch, invalidateSession, storageDir, scheduler } = await setup();
		let releaseAuth!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseAuth = resolve;
		});
		let authReached!: () => void;
		const reached = new Promise<void>((resolve) => {
			authReached = resolve;
		});
		let suspend = false;
		const provider = runtime.getRegisteredNativeProvider("faux-adm")!;
		runtime.registerNativeProvider({
			...provider,
			auth: {
				...provider.auth,
				apiKey: {
					...provider.auth.apiKey!,
					resolve: async (...args) => {
						if (suspend) {
							authReached();
							await gate;
						}
						return provider.auth.apiKey!.resolve(...args);
					},
				},
			},
		});
		await runtime.refresh({ allowNetwork: false });

		suspend = true;
		const pending = launch({ agent: "explorer", task: "Inspect a missing target" });
		await reached;
		invalidateSession();
		releaseAuth();
		expect(errorOf(await pending)).toBe(
			"Parent session or branch changed before subagent admission; request cancelled.",
		);
		expect(scheduler.listRuns()).toHaveLength(0);
		expect(existsSync(storageDir)).toBe(false);
	});

	it("refuses an already aborted request", async () => {
		const { launch, scheduler } = await setup();
		const controller = new AbortController();
		controller.abort();
		expect(errorOf(await launch({ agent: "explorer", task: "x" }, {}, controller.signal))).toBe(
			"Subagent request was aborted before admission.",
		);
		expect(scheduler.listRuns()).toHaveLength(0);
	});

	it("refuses a launch whose session storage cannot be created", async () => {
		const { agentDir, launch, scheduler } = await setup();
		// A file where the storage directory tree should start makes it impossible to create.
		writeFileSync(join(agentDir, "bluclawd"), "");
		const error = errorOf(await launch({ agent: "explorer", task: "x" }));
		expect(error).toMatch(/^Cannot launch subagent: storage is unavailable \(Failed to initialize subagent storage/);
		expect(scheduler.listRuns()).toHaveLength(0);
	});

	it("resumes a completed run with the orchestrator's current tools and tool context, keeping its role and model", async () => {
		const { launch, resume, scheduler, setLoadout } = await setup({ firstGenerationCompletes: true });
		const launched = await launch({
			agent: "explorer",
			task: "Build v1.",
			model: "faux-adm/faux-alt",
			name: "backend",
		});
		const completed = await handleOf(launched).completion;
		expect(completed.status).toBe("completed");

		setLoadout(["probe", "fresh"]);
		const prompts: string[] = [];
		const { result, ctx } = resume(completed, () => {
			prompts.push("built");
			return "Now add tests.";
		});
		const resumed = await result;
		expect(handleOf(resumed).record).toMatchObject({ name: "backend", modelId: "faux-alt", generation: 1 });
		expect(prompts).toEqual(["built"]);
		const context = scheduler.getContext(completed.runId)!;
		expect(context.parent).toBe(ctx);
		expect(context.parentTools.map((tool) => tool.name)).toEqual(["probe", "fresh"]);
		expect(context.definition.name).toBe("explorer");
		expect(context.childModel.model.id).toBe("faux-alt");
		expect(context.resume).toEqual({ transcriptPath: completed.transcriptPath, prompt: "Now add tests." });
	});

	it("refuses to resume a run whose role is now denied, before taking a message number", async () => {
		const { agentDir, launch, resume } = await setup({ firstGenerationCompletes: true });
		const completed = await handleOf(await launch({ agent: "explorer", task: "Build v1." })).completion;
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ permissions: { deny: ["Subagent(explorer)"] } }));
		let built = false;
		const resumed = await resume(completed, () => {
			built = true;
			return "Continue.";
		}).result;
		expect(resumed).toMatchObject({ ok: false, refusal: "unavailable" });
		expect(errorOf(resumed)).toMatch(/Subagent\(explorer\)/);
		expect(built).toBe(false);
	});

	it("refuses to resume in one-shot modes, since a resume runs in the background", async () => {
		for (const mode of ["print", "json"] as const) {
			const { launch, resume, scheduler } = await setup({ mode, firstGenerationCompletes: true });
			const completed = await handleOf(await launch({ agent: "explorer", task: "Build v1." })).completion;
			let built = false;
			const resumed = await resume(completed, () => {
				built = true;
				return "Continue.";
			}).result;
			expect(resumed).toMatchObject({ ok: false, refusal: "unavailable" });
			expect(errorOf(resumed)).toContain(`not supported in one-shot "${mode}" mode`);
			expect(built).toBe(false);
			expect(scheduler.getRun(completed.runId)?.status).toBe("completed");
		}
	});

	it("refuses to resume a run that is not completed, or whose session was replaced", async () => {
		const live = await setup();
		const running = handleOf(await live.launch({ agent: "explorer", task: "x" })).record;
		const notDone = await live.resume(running, () => "x").result;
		expect(notDone).toMatchObject({ ok: false, refusal: "unavailable" });
		expect(errorOf(notDone)).toMatch(/only a completed subagent can be resumed/);

		const { launch, resume, invalidateSession } = await setup({ firstGenerationCompletes: true });

		const completed = await handleOf(await launch({ agent: "explorer", task: "x" })).completion;
		invalidateSession();
		const stale = await resume(completed, () => "x").result;
		expect(stale).toMatchObject({ ok: false, refusal: "invalidated" });
		expect(errorOf(stale)).toMatch(/reloaded or replaced; spawn a new subagent/);
	});
});
