import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
	type ExtensionContext,
	ModelRegistry,
	ModelRuntime,
	ProjectTrustStore,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareRunContainment } from "../ext/sandbox/run-containment.ts";
import {
	type AdmissionContext,
	type AdmissionResult,
	type ChainPlacement,
	createRunAdmission,
	MAX_TASK_INPUT_BYTES,
	type RunAdmissionDeps,
	type RunExecutionContext,
} from "../ext/subagents/admission.ts";
import { createRunDirectory } from "../ext/subagents/directory.ts";
import { type LaunchParams, subagentInvocation } from "../ext/subagents/invocation.ts";
import { SubagentMessageBus } from "../ext/subagents/messages.ts";
import { createParentScope } from "../ext/subagents/parent-scope.ts";
import { prepareRpcHost, type RpcHostSpec } from "../ext/subagents/rpc-host.ts";
import { type AdmittedSubagentHandle, type SubagentRunRecord, SubagentRunScheduler } from "../ext/subagents/runs.ts";
import { ensureRunStorageDir } from "../ext/subagents/storage.ts";
import { leaderlessGroup } from "./helpers/leaderless-group.ts";

// Run storage works as usual unless a test makes it fail.
vi.mock("../ext/subagents/storage.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../ext/subagents/storage.ts")>();
	return { ...actual, ensureRunStorageDir: vi.fn(actual.ensureRunStorageDir) };
});

// A run's shell can be contained as usual unless a test says it cannot.
vi.mock("../ext/sandbox/run-containment.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../ext/sandbox/run-containment.ts")>();
	return { ...actual, prepareRunContainment: vi.fn(actual.prepareRunContainment) };
});

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
	vi.mocked(ensureRunStorageDir).mockClear();
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

async function setup(
	options: {
		mode?: AdmissionContext["mode"];
		settings?: unknown;
		firstGenerationCompletes?: boolean;
		// The tools the orchestrator can give its runs; none by default.
		tools?: string[];
		// The orchestrator's tmux session, where runs start as pis of their own; null for a pi outside tmux.
		pane?: string | null;
		// Another orchestrator instance of the same session: its directories and session.
		sameSession?: { cwd: string; agentDir: string; sessionManager: SessionManager };
		// The daemon that queues runs on pi's RPC cannot be started.
		queueDown?: boolean;
	} = {},
) {
	// The faux provider is this session's own; no run's pi starts to need it.
	vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", "faux");
	const cwd = options.sameSession?.cwd ?? makeTempDir("cwd");
	const agentDir = options.sameSession?.agentDir ?? makeTempDir("agent");
	if (options.settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));
	// The session a first generation that completes leaves, which a resume reopens.
	if (options.firstGenerationCompletes) writeFileSync(join(agentDir, "transcript.jsonl"), "");
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
	const sessionManager = options.sameSession?.sessionManager ?? SessionManager.inMemory(cwd);
	// Admitted runs stay live until stopped, so later launches see their names.
	const scheduler = new SubagentRunScheduler<RunExecutionContext>({
		executeRun: ({ record, signal }) =>
			options.firstGenerationCompletes && !record.generation
				? Promise.resolve({
						status: "closed",
						summaryText: "v1 done.",
						transcriptPath: join(agentDir, "transcript.jsonl"),
					})
				: new Promise((resolve) =>
						signal.addEventListener("abort", () => resolve({ status: "closed", summaryText: "" })),
					),
	});
	const scope = createParentScope({
		bus: new SubagentMessageBus(),
		cancelRuns: () => {},
		send: () => {},
		onChange: () => {},
		batchWindowMs: 0,
	});
	scope.enter({ sessionManager } as unknown as ExtensionContext, "replaced");
	const directory = createRunDirectory({ scheduler, agentDir: () => agentDir });
	const deps: RunAdmissionDeps = {
		scheduler,
		directory,
		agentDir: () => agentDir,
		parentThinkingLevel: () => "low",
		scope,
		pane: () => (options.pane === null ? undefined : (options.pane ?? "pi-orchestrator")),
		runPane: () => undefined,
		tools: () => options.tools ?? [],
		registeredTools: () => [],
		ensureQueue: async () => !options.queueDown,
	};
	const ctx: AdmissionContext = {
		cwd,
		mode: options.mode ?? "tui",
		model: faux.getModel("faux-main"),
		modelRegistry: registry,
		isProjectTrusted: () => false,
		sessionManager,
	};
	const admission = createRunAdmission(deps);
	let calls = 0;
	const launch = (
		params: LaunchParams,
		overrides: Partial<AdmissionContext> = {},
		signal?: AbortSignal,
		chain?: ChainPlacement,
	) =>
		admission.launch(
			{ toolCallId: `call_${++calls}`, parentTurnId: "turn_0", params, signal, chain },
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
		admission,
		ctx,
		agentDir,
		cwd,
		resume,
		runtime,
		faux,
		scheduler,
		launch,
		storageDir,
		directory,
		scope,
		sessionManager,
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
		// Admission prepares each admitted run's directory, and no other.
		expect(readdirSync(storageDir).sort()).toEqual([handleOf(first).runId, handleOf(second).runId].sort());
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

	it("refuses invalid inline roles before model resolution or storage", async () => {
		const { launch, storageDir } = await setup();
		const role = { name: "checker", description: "Checks.", instructions: "Check." };
		const cases = [
			{ agent: { ...role, name: "Bad Name" }, error: /Invalid agent name "Bad Name" in inline role/ },
			{ agent: { ...role, name: "sub_checker" }, error: /reserved task prefixes/ },
			{ agent: { ...role, description: "Bad\u0007desc" }, error: /control characters/ },
			{ agent: { ...role, instructions: "   " }, error: /non-empty instructions/ },
			{ agent: { ...role, tools: ["rm -rf"] }, error: /invalid tool name "rm -rf"/ },
		];
		for (const c of cases) {
			expect(errorOf(await launch({ agent: c.agent, task: "Check." })), c.agent.name).toMatch(c.error);
		}
		expect(existsSync(storageDir)).toBe(false);
	});

	it("admits a launch outside tmux: a run on pi's RPC needs no pane", async () => {
		const { launch } = await setup({ pane: null });
		expect(handleOf(await launch({ agent: "explorer", task: "x" })).record).toMatchObject({ backend: "rpc" });
	});

	it("gives a tool a role names with a trailing ? only where it can be given, and refuses one named without", async () => {
		const { launch, storageDir } = await setup({ tools: ["read"] });
		const role = (tools: string[]) => ({ name: "looker", description: "Looks.", instructions: "Look.", tools });
		const admitted = handleOf(await launch({ agent: role(["read", "grep?"]), task: "x" })).record;
		const definition = JSON.parse(readFileSync(join(storageDir, admitted.runId, "definition.json"), "utf8"));
		expect(definition.tools).toEqual(["read"]);
		expect(errorOf(await launch({ agent: role(["read", "grep"]), task: "x" }))).toBe(
			'Subagent role "looker" names tools the orchestrator cannot give a child: grep. Available: read.',
		);
	});

	it("refuses a provider an extension registers, which a run's pi would not have", async () => {
		const { launch, storageDir } = await setup();
		vi.stubEnv("BLUCLAWD_RPC_PROVIDER_EXTENSIONS", "");
		expect(errorOf(await launch({ agent: "explorer", task: "x" }))).toMatch(
			/^Cannot launch subagent: provider "faux-adm" is registered by an extension of this pi/,
		);
		expect(existsSync(storageDir)).toBe(false);
	});

	it("refuses an inherited thinking level the role's model does not support, saying it was inherited", async () => {
		const { agentDir, launch } = await setup();
		writeRole(agentDir, "plain", ["model: faux-adm/faux-alt"]);
		expect(errorOf(await launch({ agent: "plain", task: "x" }))).toMatch(
			/^Thinking level "low" is not supported .* That level is yours, inherited as neither the call nor the role sets one/,
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

	it("refuses a launch whose run storage cannot be created, so the run is never listed", async () => {
		const { launch, directory, scope } = await setup();
		vi.mocked(ensureRunStorageDir).mockReturnValueOnce({ ok: false, error: "disk full" });
		const error = errorOf(await launch({ agent: "explorer", task: "x" }));
		expect(error).toBe("Cannot launch subagent: storage is unavailable (disk full).");
		expect(directory.list(scope.current()!)).toEqual([]);
	});

	it("refuses to resume a run in tmux from before runs ran on pi's RPC, pointing at its Report and transcript", async () => {
		const { launch, resume } = await setup();
		const open = handleOf(await launch({ agent: "explorer", task: "x" })).record;
		const legacy: SubagentRunRecord = {
			...open,
			runId: "sub_legacy",
			name: "legacy",
			backend: undefined,
			pane: "pi-legacy",
			status: "closed",
			reportPath: "/runs/legacy/report.md",
			transcriptPath: "/runs/legacy/session.jsonl",
		};
		let built = false;
		const resumed = await resume(legacy, () => {
			built = true;
			return "Go on.";
		}).result;
		expect(resumed).toMatchObject({ ok: false, refusal: "unavailable" });
		expect(errorOf(resumed)).toBe(
			'"legacy" (sub_legacy) ran in tmux, before runs ran on pi\'s RPC, and is not resumed. To continue its work, launch a new subagent and point it at its Report (/runs/legacy/report.md) and transcript (/runs/legacy/session.jsonl).',
		);
		expect(built).toBe(false);
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
			expect(scheduler.getRun(completed.runId)?.status).toBe("closed");
		}
	});

	it("refuses to resume a run that is running, or whose session was replaced", async () => {
		const live = await setup();
		const running = handleOf(await live.launch({ agent: "explorer", task: "x" })).record;
		const notDone = await live.resume(running, () => "x").result;
		expect(notDone).toMatchObject({ ok: false, refusal: "unavailable" });
		expect(errorOf(notDone)).toMatch(/only a finished or stopped subagent can be resumed/);

		const { launch, resume, invalidateSession } = await setup({ firstGenerationCompletes: true });

		const completed = await handleOf(await launch({ agent: "explorer", task: "x" })).completion;
		invalidateSession();
		const stale = await resume(completed, () => "x").result;
		expect(stale).toMatchObject({ ok: false, refusal: "invalidated" });
		expect(errorOf(stale)).toMatch(/was replaced; spawn a new subagent/);
	});
});

describe("Run admission of a run's own directory, and of its Resume", () => {
	it("refuses a cwd it cannot use, or that the orchestrator's Read rules deny, before storage", async () => {
		const secret = makeTempDir("secret");
		const { launch, storageDir, cwd } = await setup({
			settings: { permissions: { deny: [`Read(${secret}/**)`] } },
		});
		writeFileSync(join(cwd, "file.txt"), "");
		expect(errorOf(await launch({ agent: "explorer", cwd: "missing", task: "x" }))).toMatch(
			/cwd ".*missing" cannot be used/,
		);
		expect(errorOf(await launch({ agent: "explorer", cwd: "file.txt", task: "x" }))).toMatch(/is not a directory/);
		expect(errorOf(await launch({ agent: "explorer", cwd: secret, task: "x" }))).toMatch(
			/Blocked by permission rule/,
		);
		expect(existsSync(storageDir)).toBe(false);
	});

	it("refuses a launch, before storing it, when the daemon that queues runs cannot be started", async () => {
		const { launch, storageDir } = await setup({ queueDown: true });
		expect(errorOf(await launch({ agent: "explorer", task: "x" }))).toBe(
			"Cannot launch subagent: the daemon that queues runs is not running and could not be started.",
		);
		expect(existsSync(storageDir)).toBe(false);
	});

	it("refuses a run whose orchestrator's or workspace's deny rules cannot be read, rather than holding it to none", async () => {
		const { launch, cwd, agentDir, storageDir } = await setup({ settings: { permissions: { deny: 42 } } });
		expect(errorOf(await launch({ agent: "explorer", task: "x" }))).toMatch(/deny rules.*cannot be read/);
		writeFileSync(join(agentDir, "settings.json"), "{}");
		const pkg = join(cwd, "pkg");
		mkdirSync(join(pkg, ".pi"), { recursive: true });
		writeFileSync(join(pkg, ".pi", "settings.json"), "{ not json");
		new ProjectTrustStore(agentDir).set(realpathSync(pkg), true);
		expect(errorOf(await launch({ agent: "explorer", cwd: "pkg", task: "x" }))).toMatch(/deny rules.*cannot be read/);
		expect(existsSync(storageDir) ? readdirSync(storageDir) : []).toEqual([]);
	});

	it("gives a directory reached through a symlink no trust of the orchestrator's own", async () => {
		const { launch, cwd } = await setup();
		const other = makeTempDir("other");
		mkdirSync(join(other, ".pi", "agents"), { recursive: true });
		writeFileSync(join(other, ".pi", "agents", "sneaky.md"), "---\nname: sneaky\ndescription: Sneaky.\n---\nSneak.");
		symlinkSync(other, join(cwd, "link"));
		const trusted = { isProjectTrusted: () => true };
		expect(errorOf(await launch({ agent: "sneaky", cwd: "link", task: "x" }, trusted))).toMatch(
			/Unknown subagent "sneaky".*untrusted project/s,
		);
		const run = handleOf(await launch({ agent: "explorer", cwd: "link", task: "x" }, trusted)).record;
		expect(run.cwd).toBe(realpathSync(other));
	});

	it("refuses a chain step whose directory leads out of its chain's worktree through a link a step before made", async () => {
		const { launch, cwd } = await setup();
		const source = realpathSync(cwd);
		mkdirSync(join(source, "sub"));
		// The worktree, where an earlier step that edits replaced the directory with a link to elsewhere.
		const root = realpathSync(makeTempDir("worktree"));
		const outside = realpathSync(makeTempDir("outside"));
		symlinkSync(outside, join(root, "sub"));
		const baseline = { source, gitDir: join(source, ".git"), head: "", index: "", tree: "", commit: "", ref: "" };
		const step = (dir: string) =>
			launch({ agent: "explorer", cwd: dir, task: "Look." }, {}, undefined, {
				id: "chain_x",
				workspace: { root, baseline },
			});
		expect(errorOf(await step("sub"))).toMatch(/is not in the worktree of its chain/);
		// A directory of the worktree itself is the step's.
		mkdirSync(join(source, "real"));
		mkdirSync(join(root, "real"));
		expect(handleOf(await step("real")).record.cwd).toBe(join(root, "real"));
	});

	it("trusts a directory under the orchestrator's only by the user's own saved decision, not by the session's", async () => {
		const { launch, cwd, agentDir, storageDir } = await setup();
		const vendor = join(cwd, "vendor");
		mkdirSync(join(vendor, ".pi", "agents"), { recursive: true });
		writeFileSync(join(vendor, ".pi", "agents", "sneaky.md"), "---\nname: sneaky\ndescription: Sneaky.\n---\nSneak.");
		const trusted = { isProjectTrusted: () => true };
		const check = async () => {
			expect(errorOf(await launch({ agent: "sneaky", cwd: "vendor", task: "x" }, trusted))).toMatch(
				/Unknown subagent "sneaky".*untrusted project/s,
			);
			const run = handleOf(await launch({ agent: "explorer", cwd: "vendor", task: "x" }, trusted));
			const snapshot = JSON.parse(readFileSync(join(storageDir, run.runId, "definition.json"), "utf8"));
			expect(snapshot.projectTrusted).toBe(false);
		};
		await check();
		new ProjectTrustStore(agentDir).set(realpathSync(vendor), false);
		await check();
	});

	/** The saved session a completed first generation leaves: one message, which a Resume goes on from. */
	const saveConversation = (agentDir: string, cwd: string) => {
		const at = new Date().toISOString();
		writeFileSync(
			join(agentDir, "transcript.jsonl"),
			[
				{ type: "session", version: 3, id: "child", timestamp: at, cwd },
				{ type: "message", id: "m1", parentId: null, timestamp: at, message: { role: "user", content: "x" } },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);
	};

	it("refuses to resume a run whose originating entry left the branch, or whose session was replaced", async () => {
		const { agentDir, cwd, launch, resume, sessionManager, invalidateSession } = await setup({
			firstGenerationCompletes: true,
		});
		sessionManager.appendMessage({ role: "user", content: "delegate", timestamp: Date.now() });
		const completed = await handleOf(await launch({ agent: "explorer", task: "x" })).completion;
		saveConversation(agentDir, cwd);
		expect(completed.originEntryId).toBeDefined();

		sessionManager.resetLeaf();
		const offBranch = await resume(completed, () => "Go on.").result;
		expect(offBranch).toMatchObject({ ok: false, refusal: "invalidated" });
		sessionManager.branch(completed.originEntryId!);
		invalidateSession();
		expect(await resume(completed, () => "Go on.").result).toMatchObject({ ok: false, refusal: "invalidated" });
	});

	it("refuses a Resume with an empty or oversized instruction before it claims the run's next generation", async () => {
		const { agentDir, cwd, launch, resume, storageDir } = await setup({ firstGenerationCompletes: true });
		const completed = await handleOf(await launch({ agent: "explorer", task: "x" })).completion;
		saveConversation(agentDir, cwd);

		expect(errorOf(await resume(completed, () => "  ").result)).toMatch(/Missing required parameter: task/);
		expect(errorOf(await resume(completed, () => "x".repeat(MAX_TASK_INPUT_BYTES + 1)).result)).toMatch(
			/exceeds the 32768-byte limit/,
		);
		expect(existsSync(join(storageDir, completed.runId, "generations"))).toBe(false);
		expect(handleOf(await resume(completed, () => "Go on.").result).record.generation).toBe(1);
	});

	it("refuses a Resume while processes of its earlier Generation still run, its host ended", async () => {
		const { agentDir, cwd, launch, resume, storageDir } = await setup({ firstGenerationCompletes: true });
		const completed = await handleOf(await launch({ agent: "explorer", task: "x" })).completion;
		saveConversation(agentDir, cwd);
		const hostPid = await leaderlessGroup();
		writeFileSync(
			join(storageDir, completed.runId, "rpc-host.json"),
			JSON.stringify({ hostPid, exit: { code: 0, signal: null } }),
		);

		expect(errorOf(await resume(completed, () => "Go on.").result)).toMatch(
			/^Cannot resume .*: its pi from before is still running\.$/,
		);
		expect(existsSync(join(storageDir, completed.runId, "generations"))).toBe(false);
	});

	it("lets one of two instances of the orchestrator's session resume a run, never both", async () => {
		const first = await setup({ firstGenerationCompletes: true });
		const completed = await handleOf(await first.launch({ agent: "explorer", task: "x" })).completion;
		const second = await setup({ firstGenerationCompletes: true, sameSession: first });
		saveConversation(first.agentDir, first.cwd);

		const results = await Promise.all([
			first.resume(completed, () => "Go on.").result,
			second.resume(completed, () => "Go on too.").result,
		]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok).map(errorOf)).toEqual([
			expect.stringMatching(/another Resume of it already started its generation 1/),
		]);
	});

	it("refuses a Resume whose deny rules cannot be read before asking whether its shell can be contained, as a launch does", async () => {
		const { agentDir, cwd, launch, resume, storageDir } = await setup({
			firstGenerationCompletes: true,
			tools: ["read", "bash"],
		});
		const role = { name: "looker", description: "Looks.", instructions: "Look.", tools: ["read"] };
		const completed = await handleOf(await launch({ agent: role, task: "x" })).completion;
		saveConversation(agentDir, cwd);
		// As if admitted with a shell, which cannot be contained now, and with deny rules that can no longer be read.
		const path = join(storageDir, completed.runId, "definition.json");
		writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), tools: ["read", "bash"] }));
		vi.mocked(prepareRunContainment).mockResolvedValueOnce({ ok: false, reason: "no sandbox here" });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ permissions: { deny: 42 } }));
		expect(errorOf(await resume(completed, () => "Go on.").result)).toMatch(/deny rules.*cannot be read/);
	});
});

describe("Run admission of a run an earlier instance of its orchestrator's session left behind", () => {
	it("takes over a run on pi's RPC as its definition and spec are stored, in the pane its orchestrator runs in now", async () => {
		const first = await setup();
		const run = handleOf(await first.launch({ agent: "explorer", task: "x" })).record;
		const runDir = join(first.storageDir, run.runId);
		const definition = JSON.parse(readFileSync(join(runDir, "definition.json"), "utf8"));
		const spec: RpcHostSpec = {
			args: ["--mode", "rpc"],
			cwd: definition.cwd,
			agentDir: first.agentDir,
			prompt: "x",
			model: { provider: "faux-adm", id: "faux-main", thinkingLevel: "low" },
			generation: 0,
			sessionFile: join(runDir, "session.jsonl"),
			pane: { session: "pi-run", parent: "pi-before" },
		};
		prepareRpcHost(runDir, spec);

		const second = await setup({ sameSession: first });
		expect(second.admission.recover(run, second.ctx)).toBe(true);
		expect(second.scheduler.getRun(run.runId)?.sessionEpoch).toBe(second.scope.current()?.sessionEpoch);
		const context = second.scheduler.getContext(run.runId);
		expect(context).toEqual({
			rpc: {
				name: run.name,
				definition,
				provider: "faux-adm",
				modelId: "faux-main",
				thinkingLevel: "low",
				tools: definition.tools,
				task: "",
				cwd: definition.cwd,
				runDir,
				agentDir: first.agentDir,
				projectTrusted: definition.projectTrusted,
				sessionFile: spec.sessionFile,
				parentPane: "pi-orchestrator",
				recovered: { ...spec, pane: { session: "pi-run", parent: "pi-orchestrator" } },
				recheck: expect.any(Function),
			},
		});
		// Not yet started, it may still start in the session as it is now.
		expect(context && "rpc" in context ? context.rpc.recheck() : "no run").toBeUndefined();
	});

	it("leaves a run on pi's RPC whose stored definition or spec does not hold its generation", async () => {
		const first = await setup();
		const run = handleOf(await first.launch({ agent: "explorer", task: "x" })).record;
		const runDir = join(first.storageDir, run.runId);
		const second = await setup({ sameSession: first });
		const spec = (generation: number): RpcHostSpec => ({
			args: [],
			cwd: first.cwd,
			agentDir: first.agentDir,
			prompt: "x",
			model: { provider: "faux-adm", id: "faux-main", thinkingLevel: "low" },
			generation,
		});

		expect(second.admission.recover(run, second.ctx)).toBe(false);
		prepareRpcHost(runDir, spec(1));
		expect(second.admission.recover(run, second.ctx)).toBe(false);
		prepareRpcHost(runDir, spec(0));
		rmSync(join(runDir, "definition.json"));
		expect(second.admission.recover(run, second.ctx)).toBe(false);
		expect(second.scheduler.getRun(run.runId)).toBeUndefined();
	});

	it("takes over an open run in tmux from before in its pane, only while its orchestrator runs in tmux", async () => {
		const first = await setup();
		const open = handleOf(await first.launch({ agent: "explorer", task: "x" })).record;
		const legacy: SubagentRunRecord = {
			...open,
			runId: "sub_legacy",
			name: "legacy",
			backend: undefined,
			pane: "pi-legacy",
			transcriptPath: "/runs/legacy/session.jsonl",
		};

		const outsideTmux = await setup({ sameSession: first, pane: null });
		outsideTmux.admission.adopt(legacy);
		expect(outsideTmux.scheduler.getRun(legacy.runId)).toBeUndefined();

		const second = await setup({ sameSession: first });
		second.admission.adopt({ ...legacy, pane: undefined });
		expect(second.scheduler.getRun(legacy.runId)).toBeUndefined();
		second.admission.adopt(legacy);
		expect(second.scheduler.getRun(legacy.runId)?.sessionEpoch).toBe(second.scope.current()?.sessionEpoch);
		expect(second.scheduler.getContext(legacy.runId)).toEqual({
			launch: {
				runDir: join(first.storageDir, legacy.runId),
				sessionFile: "/runs/legacy/session.jsonl",
				parent: "pi-orchestrator",
				pane: "pi-legacy",
			},
		});
	});
});

describe("A chain's resume step", () => {
	const writer = {
		name: "writer",
		description: "Edits files.",
		instructions: "Make the change asked.",
		tools: ["edit"],
	};
	const first = { agent: writer, name: "w", cwd: "pkg", task: "Edit." };

	it("resumes the step it names when it repeats that step's role, name and cwd", () => {
		const plain = subagentInvocation({ chain: [first, { resume: "w", task: "Fix." }] });
		const repeated = subagentInvocation({
			chain: [first, { resume: "w", agent: { ...writer }, name: " w ", cwd: "pkg", task: "Fix." }],
		});
		expect(plain).toMatchObject({ ok: true, chain: [{ run: first }, { resume: 0, task: "Fix." }] });
		expect(repeated).toEqual(plain);
	});

	it("is refused, naming each field that differs from the resumed step's", () => {
		const refusal = (step: Record<string, unknown>) => {
			const result = subagentInvocation({ chain: [first, { resume: "w", task: "Fix.", ...step }] });
			return result.ok ? undefined : result.error;
		};
		expect(refusal({ agent: "explorer" })).toMatch(
			/^chain\[1\]: .*`agent` differs from chain\[0\]'s.*leave out `agent`\.$/,
		);
		expect(refusal({ name: "x" })).toMatch(/`name` differs from chain\[0\]'s.*leave out `name`\.$/);
		expect(refusal({ name: "w", cwd: "other" })).toMatch(/`cwd` differs from chain\[0\]'s.*leave out `cwd`\.$/);
		expect(refusal({ agent: "explorer", cwd: "other" })).toMatch(
			/`agent`, `cwd` differ from chain\[0\]'s.*leave out `agent`, `cwd`\.$/,
		);
	});
});
