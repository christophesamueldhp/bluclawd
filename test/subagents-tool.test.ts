import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentTools,
	getSystemMessageText,
	Type,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createSubagentsExtension, MAX_TASK_INPUT_BYTES } from "../ext/subagents/index.ts";
import { readPersistedRunRecord } from "../ext/subagents/storage.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-tool-${prefix}-`));
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

async function createParentSessionWithSubagents(options: {
	cwd: string;
	agentDir: string;
	extraTools?: ReturnType<typeof defineTool>[];
}) {
	const modelRuntime = await ModelRuntime.create({
		authPath: join(options.agentDir, "auth.json"),
		modelsPath: join(options.agentDir, "models.json"),
		modelsStorePath: join(options.agentDir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	const faux = fauxProvider({
		provider: "faux-tool",
		models: [
			{
				id: "faux-main",
				reasoning: true,
				cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			},
			{ id: "faux-alt", reasoning: false },
		],
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager,
		extensionFactories: [createSubagentsExtension({ agentDir: options.agentDir })],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		modelRuntime,
		model: faux.getModel("faux-main"),
		thinkingLevel: "low",
		noTools: "builtin",
		customTools: options.extraTools,
		resourceLoader,
		sessionManager: SessionManager.inMemory(options.cwd),
		settingsManager,
	});

	return { session, faux, modelRuntime };
}

function toolResultText(session: { messages: readonly unknown[] }, id: string) {
	const result = session.messages.find(
		(m) => (m as { role?: string }).role === "toolResult" && (m as { toolCallId?: string }).toolCallId === id,
	) as { isError?: boolean; content: Array<{ type: string; text?: string }>; details?: unknown } | undefined;
	const text = result?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
	return { result, text };
}

describe("Task 6 (M1) — Foreground subagent tool integration", () => {
	it("resets delegation admission for new prompts even when Pi reuses turn index zero", async () => {
		const cwd = makeTempDir("new-prompts-cwd");
		const agentDir = makeTempDir("new-prompts-agent");
		const { session, faux } = await createParentSessionWithSubagents({ cwd, agentDir });
		try {
			await session.bindExtensions({ mode: "print" });
			for (let prompt = 0; prompt < 7; prompt++) {
				faux.setResponses([
					fauxAssistantMessage([
						fauxToolCall(
							"subagent",
							{ agent: "explorer", task: "Report missing scope." },
							{ id: `prompt_${prompt}` },
						),
					]),
					fauxAssistantMessage("No target supplied."),
					fauxAssistantMessage("Acknowledged."),
				]);
				await session.prompt("Inspect the supplied target.", { expandPromptTemplates: false });
				const result = session.messages.find((m) => m.role === "toolResult" && m.toolCallId === `prompt_${prompt}`);
				expect(result?.role === "toolResult" && result.isError, `prompt ${prompt}`).toBe(false);
			}
		} finally {
			session.dispose();
		}
	});

	it("registers a single model-only subagent tool without starting work in the factory and executes parallel sibling subagent calls through Pi's real dispatch path", async () => {
		const cwd = makeTempDir("cwd");
		const agentDir = makeTempDir("agent");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "alpha.ts"), "export const alpha = 10;\n", "utf8");
		writeFileSync(join(cwd, "src", "beta.ts"), "export const beta = 20;\n", "utf8");

		const { session, faux } = await createParentSessionWithSubagents({ cwd, agentDir });
		try {
			await session.bindExtensions({});

			// Verify model-only exposure (declared to model, not callable via ctx.executeTool)
			const allTools = session.getAllTools();
			const subagentInfo = allTools.find((t) => t.name === "subagent");
			expect(subagentInfo).toBeDefined();
			expect(subagentInfo?.exposure).toBe("model-only");
			expect(session.getActiveToolNames()).toContain("subagent");
			expect(session.getCallableToolNames()).not.toContain("subagent");

			// Queue responses:
			// 1. Parent issues two parallel sibling `subagent` tool calls (`explorer` and `reviewer`)
			// 2. Child 1 (`explorer`) response
			// 3. Child 2 (`reviewer`) response
			// 4. Parent synthesizes final answer
			faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall(
						"subagent",
						{
							agent: "explorer",
							task: "Inspect src/alpha.ts and report its export.",
						},
						{ id: "call_sub_1" },
					),
					fauxToolCall(
						"subagent",
						{
							agent: "reviewer",
							task: "Review src/beta.ts for defects.",
						},
						{ id: "call_sub_2" },
					),
				]),
				fauxAssistantMessage(
					[
						"### Scope",
						"- Inspected: `src/alpha.ts`",
						"### Summary",
						"`alpha` is exported as `10`.",
						"### Evidence",
						"- `src/alpha.ts:1` — `export const alpha = 10;`",
						"### Blockers",
						"- none",
					].join("\n"),
				),
				fauxAssistantMessage(
					[
						"### Scope",
						"- Inspected: `src/beta.ts`",
						"### Summary",
						"No actionable issue found in `src/beta.ts`.",
						"### Evidence",
						"- `src/beta.ts:1` — constant export",
						"### Blockers",
						"- none",
					].join("\n"),
				),
				fauxAssistantMessage("Both parallel subagents completed successfully."),
			]);

			await session.prompt("Run parallel explorer and reviewer.", { expandPromptTemplates: false });
			expect(session.getLastAssistantText()).toBe("Both parallel subagents completed successfully.");

			const toolResults = session.messages.filter((m) => m.role === "toolResult");
			expect(toolResults).toHaveLength(2);
			for (const tr of toolResults) {
				if (tr.role === "toolResult") {
					expect(tr.isError).toBe(false);
					expect(tr.usage?.totalTokens).toBeGreaterThan(0);
					const text = tr.content.map((c) => (c.type === "text" ? c.text : "")).join("");
					expect(text).toContain("Execution: completed");
					expect(text).toContain("Verification: not_run");
					const runId = (tr.details as { runId: string }).runId;
					const record = readPersistedRunRecord(agentDir, session.sessionId, runId)!;
					expect(record.transcriptPath).toBeTypeOf("string");
					expect(existsSync(record.transcriptPath!)).toBe(true);
					expect(dirname(record.transcriptPath!)).toBe(
						join(agentDir, "bluclawd", "subagents", session.sessionId, runId),
					);
					if (process.platform !== "win32") expect(statSync(record.transcriptPath!).mode & 0o777).toBe(0o600);
				}
			}

			// Verify parent session stats include child usage
			const stats = session.getSessionStats();
			expect(stats.toolResults).toBe(2);
			expect(stats.tokens.total).toBeGreaterThan(0);
		} finally {
			session.dispose();
		}
	});

	it("refuses isolated definitions before model resolution or run storage while release is blocked", async () => {
		const cwd = makeTempDir("isolated-cwd");
		const agentDir = makeTempDir("isolated-agent");
		mkdirSync(join(agentDir, "agents"));
		writeFileSync(
			join(agentDir, "agents", "api-auditor.md"),
			[
				"---",
				"name: api-auditor",
				"description: Verification.",
				"tools: [read, bash]",
				"model: missing/model",
				"---",
				"Run verification.",
			].join("\n"),
		);
		const { session, faux } = await createParentSessionWithSubagents({ cwd, agentDir });
		try {
			await session.bindExtensions({ mode: "print" });
			const before = faux.state.callCount;
			faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall(
						"subagent",
						{
							agent: "api-auditor",
							task: "Run verification.",
						},
						{ id: "isolated_blocked" },
					),
				]),
				fauxAssistantMessage("Execution unavailable."),
			]);
			await session.prompt("Delegate verification.", { expandPromptTemplates: false });
			const result = session.messages.find((m) => m.role === "toolResult" && m.toolCallId === "isolated_blocked");
			expect(result?.role === "toolResult" && result.isError).toBe(true);
			if (result?.role === "toolResult") {
				expect(result.content).toEqual([
					expect.objectContaining({ text: expect.stringMatching(/isolated.*not (released|enabled)/i) }),
				]);
			}
			expect(faux.state.callCount - before).toBe(2);
			expect(existsSync(join(agentDir, "bluclawd", "subagents", session.sessionId))).toBe(false);
		} finally {
			session.dispose();
		}
	});

	it("enforces Subagent deny rules, task input size bounds, and unknown role errors before child model activity", async () => {
		const cwd = makeTempDir("deny-cwd");
		const agentDir = makeTempDir("deny-agent");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				permissions: {
					deny: ["Subagent(explorer)"],
				},
			}),
			"utf8",
		);

		const { session, faux } = await createParentSessionWithSubagents({ cwd, agentDir });
		try {
			await session.bindExtensions({});

			const callsBefore = faux.state.callCount;
			faux.setResponses([
				fauxAssistantMessage([
					// 1. Denied by Subagent(explorer)
					fauxToolCall("subagent", { agent: "explorer", task: "Blocked exploration" }, { id: "c_denied" }),
					// 2. Oversized task (> 32 KiB)
					fauxToolCall(
						"subagent",
						{ agent: "reviewer", task: "x".repeat(MAX_TASK_INPUT_BYTES + 100) },
						{ id: "c_oversized" },
					),
					// 3. Unknown agent role
					fauxToolCall("subagent", { agent: "nonexistent-role", task: "Inspect files" }, { id: "c_unknown" }),
				]),
				fauxAssistantMessage("Handled pre-admission rejections."),
			]);

			await session.prompt("Test pre-admission rejections.", { expandPromptTemplates: false });

			// Only 2 parent model calls occurred (turn 1 + turn 2); 0 child model calls occurred!
			expect(faux.state.callCount - callsBefore).toBe(2);

			const toolResults = session.messages.filter((m) => m.role === "toolResult");
			expect(toolResults).toHaveLength(3);
			for (const tr of toolResults) {
				if (tr.role === "toolResult") {
					expect(tr.isError).toBe(true);
				}
			}
		} finally {
			session.dispose();
		}
	});

	it("warns on conflicting third-party subagent tool registration and rejects background mode in headless print/json mode", async () => {
		const cwd = makeTempDir("conflict-cwd");
		const agentDir = makeTempDir("conflict-agent");
		const warnings: string[] = [];

		const conflictingTool = defineTool({
			name: "subagent",
			label: "ThirdPartySubagent",
			description: "Conflicting tool",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text", text: "conflict" }], details: undefined };
			},
		});

		const { session: conflictSession } = await createParentSessionWithSubagents({
			cwd,
			agentDir,
			extraTools: [conflictingTool],
		});
		try {
			await conflictSession.bindExtensions({
				mode: "tui",
				uiContext: {
					notify: (msg: string) => warnings.push(msg),
					setStatus: () => {},
					theme: { fg: (_c: string, t: string) => t },
				} as any,
			});
			expect(warnings.some((w) => w.includes("Conflicting third-party `subagent` tool"))).toBe(true);
		} finally {
			conflictSession.dispose();
		}

		const { session, faux } = await createParentSessionWithSubagents({
			cwd,
			agentDir,
		});

		try {
			await session.bindExtensions({
				mode: "print",
			});

			// Now test background: true in print mode -> fails explicitly before admission
			faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall(
						"subagent",
						{
							agent: "explorer",
							task: "Try background in print mode",
							background: true,
						},
						{ id: "c_bg_print" },
					),
				]),
				fauxAssistantMessage("Print mode rejected background subagent."),
			]);

			await session.prompt("Try background in print mode.", { expandPromptTemplates: false });
			const bgResult = session.messages.find((m) => m.role === "toolResult" && m.toolCallId === "c_bg_print");
			expect(bgResult?.role).toBe("toolResult");
			if (bgResult?.role === "toolResult") {
				expect(bgResult.isError).toBe(true);
				const text = bgResult.content.map((c) => (c.type === "text" ? c.text : "")).join("");
				expect(text).toContain('not supported in one-shot "print" mode');
			}
		} finally {
			session.dispose();
		}
	});
});

describe("Ticket #7 — Uncapped saved roles", () => {
	function writeRole(dir: string, name: string, extra: string[] = []) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${name}.md`),
			["---", `name: ${name}`, `description: Role ${name}.`, ...extra, "---", "Do the assigned work."].join("\n"),
		);
	}

	async function routedDescription(cwd: string, agentDir: string) {
		const { session, faux } = await createParentSessionWithSubagents({ cwd, agentDir });
		try {
			await session.bindExtensions({ mode: "print" });
			let description = "";
			faux.setResponses([
				(context) => {
					description = getCurrentTools(context.messages).find((t) => t.name === "subagent")?.description ?? "";
					return fauxAssistantMessage("Done.");
				},
			]);
			await session.prompt("Which roles exist?", { expandPromptTemplates: false });
			return description;
		} finally {
			session.dispose();
		}
	}

	it("offers every one of 40 saved roles to the orchestrator", async () => {
		const cwd = makeTempDir("roles40-cwd");
		const agentDir = makeTempDir("roles40-agent");
		for (let i = 0; i < 30; i++) writeRole(join(agentDir, "agents"), `user-role-${i}`);
		for (let i = 0; i < 10; i++) writeRole(join(cwd, ".pi", "agents"), `project-role-${i}`);

		const description = await routedDescription(cwd, agentDir);

		for (let i = 0; i < 30; i++) expect(description).toContain(`user-role-${i}`);
		for (let i = 0; i < 10; i++) expect(description).toContain(`project-role-${i}`);
		expect(description).not.toMatch(/maxTurns/);
	});

	it("offers a saved role with a long description and large instructions", async () => {
		const cwd = makeTempDir("large-cwd");
		const agentDir = makeTempDir("large-agent");
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		const description = `Large role ${"d".repeat(600)}`;
		writeFileSync(
			join(agentDir, "agents", "large-role.md"),
			["---", "name: large-role", `description: ${description}`, "---", "x".repeat(40 * 1024)].join("\n"),
		);

		expect(await routedDescription(cwd, agentDir)).toContain(description);
	});

	it("runs a saved role without tools on the current read-only path", async () => {
		const cwd = makeTempDir("inherit-cwd");
		const agentDir = makeTempDir("inherit-agent");
		writeRole(join(agentDir, "agents"), "general-purpose");
		const { session, faux } = await createParentSessionWithSubagents({ cwd, agentDir });
		try {
			await session.bindExtensions({ mode: "print" });
			faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("subagent", { agent: "general-purpose", task: "Report." }, { id: "inherit" }),
				]),
				(context) => {
					const childTools = getCurrentTools(context.messages).map((t) => t.name);
					return fauxAssistantMessage(`Child tools: ${childTools.sort().join(",")}`);
				},
				fauxAssistantMessage("Done."),
			]);
			await session.prompt("Delegate.", { expandPromptTemplates: false });
			const result = session.messages.find((m) => m.role === "toolResult" && m.toolCallId === "inherit");
			expect(result?.role === "toolResult" && result.isError).toBe(false);
			const text =
				result?.role === "toolResult" ? result.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
			expect(text).toContain("Child tools: find,grep,ls,read");
		} finally {
			session.dispose();
		}
	});

	it("refuses a saved role that still declares the obsolete maxTurns field", async () => {
		const cwd = makeTempDir("maxturns-cwd");
		const agentDir = makeTempDir("maxturns-agent");
		writeRole(join(agentDir, "agents"), "explorer", ["maxTurns: 6"]);
		const { session, faux } = await createParentSessionWithSubagents({ cwd, agentDir });
		try {
			await session.bindExtensions({ mode: "print" });
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("subagent", { agent: "explorer", task: "Inspect." }, { id: "legacy" })]),
				fauxAssistantMessage("Refused."),
			]);
			await session.prompt("Delegate.", { expandPromptTemplates: false });
			const result = session.messages.find((m) => m.role === "toolResult" && m.toolCallId === "legacy");
			expect(result?.role === "toolResult" && result.isError).toBe(true);
			const text =
				result?.role === "toolResult" ? result.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
			expect(text).toMatch(/maxTurns/);
			expect(text).toMatch(/remove/i);
		} finally {
			session.dispose();
		}
	});
});

describe("Ticket #11 — Inline run-local roles", () => {
	it("runs an inline role over a same-named saved role, reports its source as inline, and writes no definition file", async () => {
		const cwd = makeTempDir("inline-cwd");
		const agentDir = makeTempDir("inline-agent");
		const savedPath = join(agentDir, "agents", "schema-checker.md");
		mkdirSync(dirname(savedPath), { recursive: true });
		writeFileSync(savedPath, "---\nname: schema-checker\ndescription: Saved role.\n---\nSAVED-MARKER\n");
		const savedBefore = statSync(savedPath).mtimeMs;
		const { session, faux } = await createParentSessionWithSubagents({ cwd, agentDir });
		try {
			await session.bindExtensions({ mode: "print" });
			faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall(
						"subagent",
						{
							agent: {
								name: "schema-checker",
								description: "Checks schema files.",
								instructions: "INLINE-MARKER: inspect only the schema directory.",
							},
							task: "Check the schema.",
						},
						{ id: "inline_ok" },
					),
				]),
				(context) => {
					const sys = context.messages.find((m) => m.role === "system");
					const sysText = sys?.role === "system" ? getSystemMessageText(sys) : "";
					return fauxAssistantMessage(`Child saw marker: ${sysText.includes("INLINE-MARKER")}`);
				},
				fauxAssistantMessage("Done."),
			]);
			await session.prompt("Delegate.", { expandPromptTemplates: false });

			const { result, text } = toolResultText(session, "inline_ok");
			expect(result?.isError, text).toBe(false);
			expect(text).toContain("Child saw marker: true");
			expect(text).toContain("agent=schema-checker, source=inline");
			const record = readPersistedRunRecord(
				agentDir,
				session.sessionId,
				(result?.details as { runId: string }).runId,
			);
			expect(record).toMatchObject({ agentName: "schema-checker", definitionSource: "inline" });
			expect(readdirSync(join(agentDir, "agents"))).toEqual(["schema-checker.md"]);
			expect(readFileSync(savedPath, "utf8")).toContain("SAVED-MARKER");
			expect(statSync(savedPath).mtimeMs).toBe(savedBefore);
			expect(existsSync(join(cwd, ".pi"))).toBe(false);
		} finally {
			session.dispose();
		}
	});

	it("rejects invalid inline roles and inline tool widening before admission", async () => {
		const cwd = makeTempDir("inline-bad-cwd");
		const agentDir = makeTempDir("inline-bad-agent");
		const role = { name: "checker", description: "Checks.", instructions: "Check." };
		const cases = [
			{
				id: "bad_name",
				agent: { ...role, name: "Bad Name" },
				error: /Invalid agent name "Bad Name" in inline role/,
			},
			{ id: "reserved", agent: { ...role, name: "sub_checker" }, error: /reserved task prefixes/ },
			{ id: "control", agent: { ...role, description: "Bad\u0007desc" }, error: /control characters/ },
			{ id: "empty_body", agent: { ...role, instructions: "   " }, error: /non-empty instructions/ },
			{ id: "widen", agent: { ...role, tools: ["read", "bash"] }, error: /not released/ },
			{ id: "unknown_tool", agent: { ...role, tools: ["mcp"] }, error: /forbidden or unknown tool "mcp"/ },
		];
		const { session, faux } = await createParentSessionWithSubagents({ cwd, agentDir });
		try {
			await session.bindExtensions({ mode: "print" });
			const before = faux.state.callCount;
			faux.setResponses([
				fauxAssistantMessage(
					cases.map((c) => fauxToolCall("subagent", { agent: c.agent, task: "Check." }, { id: c.id })),
				),
				fauxAssistantMessage("Refused."),
			]);
			await session.prompt("Delegate.", { expandPromptTemplates: false });

			for (const c of cases) {
				const { result, text } = toolResultText(session, c.id);
				expect(result?.isError, c.id).toBe(true);
				expect(text, c.id).toMatch(c.error);
			}
			expect(faux.state.callCount - before).toBe(2);
			expect(existsSync(join(agentDir, "bluclawd", "subagents", session.sessionId))).toBe(false);
		} finally {
			session.dispose();
		}
	});
});

describe("Ticket #10 — Per-spawn model and thinking selection", () => {
	it("lists subagent models with auth, thinking levels and execution support, without secrets", async () => {
		const cwd = makeTempDir("models-cwd");
		const agentDir = makeTempDir("models-agent");
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ anthropic: { type: "api_key", key: "sk-test-secret-123" } }),
		);
		const { session, faux, modelRuntime } = await createParentSessionWithSubagents({ cwd, agentDir });
		modelRuntime.registerVirtualModel({
			provider: "virtual-router",
			id: "auto",
			name: "Virtual Auto Router",
			thinkingLevels: ["low", "high"],
			route: () => ({ model: faux.getModel("faux-main"), thinkingLevel: "low" }),
		});
		await modelRuntime.refresh({ allowNetwork: false });
		try {
			await session.bindExtensions({ mode: "print" });
			faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("subagent_models", {}, { id: "all" }),
					fauxToolCall("subagent_models", { provider: "faux-tool" }, { id: "faux_only" }),
				]),
				fauxAssistantMessage("Listed."),
			]);
			await session.prompt("Which models can subagents use?", { expandPromptTemplates: false });

			const all = toolResultText(session, "all");
			expect(all.result?.isError, all.text).toBe(false);
			expect(all.text).not.toContain("sk-test-secret-123");
			const models = JSON.parse(all.text).models as Array<Record<string, unknown>>;
			expect(models.find((m) => m.provider === "anthropic" && m.auth === "configured")).toBeDefined();
			expect(models.find((m) => m.provider === "openai")).toMatchObject({
				auth: "missing",
				executionSupport: "supported",
			});
			expect(models.find((m) => m.provider === "virtual-router")).toMatchObject({
				id: "auto",
				thinkingLevels: null,
				executionSupport: "unavailable",
				reason: expect.stringMatching(/router/i),
			});

			const fauxOnly = JSON.parse(toolResultText(session, "faux_only").text).models;
			expect(fauxOnly).toEqual([
				{
					provider: "faux-tool",
					id: "faux-main",
					name: "faux-main",
					auth: expect.stringMatching(/^(configured|unknown)$/),
					thinkingLevels: ["off", "minimal", "low", "medium", "high"],
					executionSupport: "supported",
				},
				{
					provider: "faux-tool",
					id: "faux-alt",
					name: "faux-alt",
					auth: expect.stringMatching(/^(configured|unknown)$/),
					thinkingLevels: ["off"],
					executionSupport: "supported",
				},
			]);
		} finally {
			session.dispose();
		}
	});

	async function spawnAndObserve(cwd: string, agentDir: string, spawns: Array<Record<string, unknown>>) {
		const { session, faux } = await createParentSessionWithSubagents({ cwd, agentDir });
		try {
			await session.bindExtensions({ mode: "print" });
			faux.setResponses(
				spawns.flatMap((args, i) => [
					fauxAssistantMessage([fauxToolCall("subagent", { task: "Report.", ...args }, { id: `spawn_${i}` })]),
					(
						_context: unknown,
						options: { reasoning?: string } | undefined,
						_state: unknown,
						model: { id: string },
					) => fauxAssistantMessage(`ran=${model.id}/${options?.reasoning ?? "off"}`),
				]),
			);
			faux.appendResponses([fauxAssistantMessage("Done.")]);
			await session.prompt("Delegate.", { expandPromptTemplates: false });
			return spawns.map((_, i) => {
				const { result, text } = toolResultText(session, `spawn_${i}`);
				const record = result?.details
					? readPersistedRunRecord(agentDir, session.sessionId, (result.details as { runId: string }).runId)
					: undefined;
				return { isError: result?.isError, ran: text.match(/ran=(\S+)/)?.[1] ?? text, record };
			});
		} finally {
			session.dispose();
		}
	}

	it("runs the child with the spawn-selected model and thinking level", async () => {
		const cwd = makeTempDir("spawn-model-cwd");
		const agentDir = makeTempDir("spawn-model-agent");
		const [alt, deep] = await spawnAndObserve(cwd, agentDir, [
			{ agent: "explorer", model: "faux-tool/faux-alt", thinkingLevel: "off" },
			{ agent: "explorer", thinkingLevel: "high" },
		]);
		expect(alt).toMatchObject({ isError: false, ran: "faux-alt/off" });
		expect(alt.record).toMatchObject({ modelId: "faux-alt", thinkingLevel: "off" });
		expect(deep).toMatchObject({ isError: false, ran: "faux-main/high" });
		expect(deep.record).toMatchObject({ modelId: "faux-main", thinkingLevel: "high" });
	});

	it("resolves model and thinking independently with spawn over role over parent", async () => {
		const cwd = makeTempDir("precedence-cwd");
		const agentDir = makeTempDir("precedence-agent");
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(
			join(agentDir, "agents", "tuned.md"),
			"---\nname: tuned\ndescription: Alt model.\nmodel: faux-tool/faux-alt\nthinkingLevel: off\n---\nWork.\n",
		);
		writeFileSync(
			join(agentDir, "agents", "deep.md"),
			"---\nname: deep\ndescription: Deep thinking.\nthinkingLevel: high\n---\nWork.\n",
		);
		const runs = await spawnAndObserve(cwd, agentDir, [
			{ agent: "tuned" },
			{ agent: "tuned", model: "inherit", thinkingLevel: "medium" },
			{ agent: "deep", model: "inherit" },
			{ agent: "deep", thinkingLevel: "inherit" },
			{ agent: { name: "inline-deep", description: "Inline.", instructions: "Work.", thinkingLevel: "minimal" } },
		]);
		expect(runs.map((r) => r.ran)).toEqual([
			"faux-alt/off",
			"faux-main/medium",
			"faux-main/high",
			"faux-main/low",
			"faux-main/minimal",
		]);
	});

	it("fails unknown models, missing auth, unsupported thinking and virtual routers with named errors before admission", async () => {
		const cwd = makeTempDir("model-errors-cwd");
		const agentDir = makeTempDir("model-errors-agent");
		const savedOpenAiKey = process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_API_KEY;
		const { session, faux, modelRuntime } = await createParentSessionWithSubagents({ cwd, agentDir });
		modelRuntime.registerVirtualModel({
			provider: "virtual-router",
			id: "auto",
			name: "Virtual Auto Router",
			thinkingLevels: ["low", "high"],
			route: () => ({ model: faux.getModel("faux-main"), thinkingLevel: "low" }),
		});
		await modelRuntime.refresh({ allowNetwork: false });
		const cases = [
			{ id: "unknown", args: { model: "faux-tool/missing" }, error: /"faux-tool\/missing" is not available/ },
			{
				id: "no_auth",
				args: { model: "openai/gpt-4.1", thinkingLevel: "off" },
				error: /No authentication configured.*"openai"/,
			},
			{
				id: "unsupported",
				args: { model: "faux-tool/faux-alt", thinkingLevel: "high" },
				error: /Thinking level "high" is not supported.*faux-alt.*supported: off/,
			},
			{
				id: "inherited_unsupported",
				args: { model: "faux-tool/faux-alt" },
				error: /Thinking level "low" is not supported/,
			},
			{
				id: "virtual",
				args: { model: "virtual-router/auto" },
				error: /Virtual model "virtual-router\/auto" cannot be used by a subagent: virtual model routers are not inspectable/,
			},
			{ id: "bad_level", args: { thinkingLevel: "ultra" }, error: /Invalid subagent "thinkingLevel" value "ultra"/ },
			{ id: "bad_model", args: { model: "sonnet" }, error: /Invalid subagent "model" value "sonnet"/ },
		];
		try {
			await session.bindExtensions({ mode: "print" });
			const before = faux.state.callCount;
			faux.setResponses([
				fauxAssistantMessage(
					cases.map((c) =>
						fauxToolCall("subagent", { agent: "explorer", task: "Report.", ...c.args }, { id: c.id }),
					),
				),
				fauxAssistantMessage("Refused."),
			]);
			await session.prompt("Delegate.", { expandPromptTemplates: false });
			for (const c of cases) {
				const { result, text } = toolResultText(session, c.id);
				expect(result?.isError, c.id).toBe(true);
				expect(text, c.id).toMatch(c.error);
			}
			expect(faux.state.callCount - before).toBe(2);
			expect(existsSync(join(agentDir, "bluclawd", "subagents", session.sessionId))).toBe(false);
		} finally {
			session.dispose();
			if (savedOpenAiKey !== undefined) process.env.OPENAI_API_KEY = savedOpenAiKey;
		}
	});

	it("lists a provider registered after the first listing without a restart", async () => {
		const cwd = makeTempDir("late-provider-cwd");
		const agentDir = makeTempDir("late-provider-agent");
		const { session, faux, modelRuntime } = await createParentSessionWithSubagents({ cwd, agentDir });
		try {
			await session.bindExtensions({ mode: "print" });
			const listLate = async (id: string) => {
				faux.setResponses([
					fauxAssistantMessage([fauxToolCall("subagent_models", { provider: "faux-late" }, { id })]),
					fauxAssistantMessage("Listed."),
				]);
				await session.prompt("List.", { expandPromptTemplates: false });
				return JSON.parse(toolResultText(session, id).text).models as Array<{ id: string }>;
			};

			expect(await listLate("before")).toEqual([]);
			modelRuntime.registerNativeProvider(
				fauxProvider({ provider: "faux-late", models: [{ id: "late-1" }] }).provider,
			);
			await modelRuntime.refresh({ allowNetwork: false });
			expect((await listLate("after")).map((m) => m.id)).toEqual(["late-1"]);
		} finally {
			session.dispose();
		}
	});

	it("runs a background child with the spawn-selected model and thinking level", async () => {
		const cwd = makeTempDir("bg-model-cwd");
		const agentDir = makeTempDir("bg-model-agent");
		const { session, faux } = await createParentSessionWithSubagents({ cwd, agentDir });
		try {
			await session.bindExtensions({ mode: "rpc" });
			let childRan = "";
			// The background child and the parent's next turn race for the shared faux queue.
			const respond = (
				_context: unknown,
				options: { reasoning?: string } | undefined,
				_state: unknown,
				model: { id: string },
			) => {
				if (model.id !== "faux-alt") return fauxAssistantMessage("Parent ack.");
				childRan = `${model.id}/${options?.reasoning ?? "off"}`;
				return fauxAssistantMessage("Child done.");
			};
			faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall(
						"subagent",
						{
							agent: "explorer",
							task: "Report.",
							background: true,
							model: "faux-tool/faux-alt",
							thinkingLevel: "off",
						},
						{ id: "bg_alt" },
					),
				]),
				respond,
				respond,
				respond,
			]);
			await session.prompt("Delegate in background.", { expandPromptTemplates: false });
			const runId = (toolResultText(session, "bg_alt").result?.details as { runId: string }).runId;
			for (
				let i = 0;
				i < 200 && readPersistedRunRecord(agentDir, session.sessionId, runId)?.status !== "completed";
				i++
			) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			await session.waitForIdle();

			expect(childRan).toBe("faux-alt/off");
			expect(readPersistedRunRecord(agentDir, session.sessionId, runId)).toMatchObject({
				status: "completed",
				modelId: "faux-alt",
				thinkingLevel: "off",
			});
		} finally {
			session.dispose();
		}
	});
});
