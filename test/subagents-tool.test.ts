import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
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
