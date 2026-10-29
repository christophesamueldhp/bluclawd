import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, fauxAssistantMessage, fauxProvider, fauxToolCall, type Model, Type } from "@earendil-works/pi-ai";
import { createReadToolDefinition, defineTool, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgentDefinitions, resolveAgentDefinition } from "../ext/subagents/definitions.ts";
import {
	captureWorkspaceSnapshot,
	type ResolvedChildModel,
	resolveChildModelAndRuntime,
	runSubagent,
} from "../ext/subagents/runner.ts";
import { type AdmitSubagentRunResult, SubagentRunScheduler } from "../ext/subagents/runs.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-runner-${prefix}-`));
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

async function createTestParentRegistry(agentDir: string) {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
	const faux = fauxProvider({
		provider: "faux-runner",
		models: [{ id: "faux-1", reasoning: true }],
	});
	runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false });
	const registry = new ModelRegistry(runtime);
	return { runtime, registry, faux, model: faux.getModel("faux-1")! };
}

function admitted(result: AdmitSubagentRunResult) {
	if (!result.ok) throw new Error(`Expected an admitted run, got: ${result.error}`);
	return result.handle;
}

async function inheritedChildModel(
	agentDir: string,
	registry: ModelRegistry,
	model: Model<Api>,
	requestedThinkingLevel: string,
): Promise<ResolvedChildModel> {
	const resolved = await resolveChildModelAndRuntime({
		agentDir,
		requestedModel: "inherit",
		parentModel: model,
		requestedThinkingLevel,
		parentModelRegistry: registry,
	});
	if (!resolved.ok) throw new Error(resolved.error);
	return { model: resolved.model, modelRuntime: resolved.modelRuntime, thinkingLevel: resolved.thinkingLevel };
}

// The child's tools stand in for the orchestrator's proxied tools, which the tool-level tests cover.
const deniedTool = defineTool({
	name: "denied_action",
	label: "Denied action",
	description: "Always refused, like a call the parent policy blocks.",
	parameters: Type.Object({}),
	execute: async () => ({
		content: [{ type: "text", text: "Blocked by permission rule" }],
		details: undefined,
		isError: true,
	}),
});

describe("Task 4 (M1) — Child runner", () => {
	it("resolves inherited and explicit models and rejects missing or virtual models before starting work", async () => {
		const agentDir = makeTempDir("agent");
		const { registry, model } = await createTestParentRegistry(agentDir);

		// 1. Inherited physical model succeeds
		const inherited = await resolveChildModelAndRuntime({
			agentDir,
			requestedModel: "inherit",
			parentModel: model,
			requestedThinkingLevel: "low",
			parentModelRegistry: registry,
		});
		expect(inherited).toMatchObject({ ok: true, model: { id: "faux-1" }, thinkingLevel: "low" });

		// 2. Missing parent model fails before starting work
		const missingParent = await resolveChildModelAndRuntime({
			agentDir,
			requestedModel: "inherit",
			parentModel: undefined,
			requestedThinkingLevel: "off",
			parentModelRegistry: registry,
		});
		expect(missingParent).toMatchObject({ ok: false, error: expect.stringMatching(/no active model/i) });

		// 3. Virtual model is rejected explicitly without silent fallback
		registry.registerVirtualModel({
			provider: "faux-runner",
			id: "virtual-auto",
			name: "Virtual Auto",
			route: () => ({ model, thinkingLevel: "low" }),
		});
		await registry.refresh({ allowNetwork: false });
		const virtualModel = registry.find("faux-runner", "virtual-auto")!;
		const virtualRes = await resolveChildModelAndRuntime({
			agentDir,
			requestedModel: "inherit",
			parentModel: virtualModel,
			requestedThinkingLevel: "low",
			parentModelRegistry: registry,
		});
		expect(virtualRes).toMatchObject({ ok: false, error: expect.stringMatching(/virtual model/i) });

		// 4. Explicit unknown provider/model fails before starting work
		const unknownExplicit = await resolveChildModelAndRuntime({
			agentDir,
			requestedModel: "unknown-prov/missing-model",
			parentModel: model,
			requestedThinkingLevel: "low",
			parentModelRegistry: registry,
		});
		expect(unknownExplicit).toMatchObject({
			ok: false,
			error: expect.stringMatching(/unknown-prov\/missing-model/i),
		});
	});

	it.each([false, true])(
		"runs the given tools, records their executions, and loads global instructions when project trust=%s",
		async (projectTrusted) => {
			const cwd = makeTempDir("cwd");
			const agentDir = makeTempDir("agent");
			mkdirSync(join(cwd, "src"), { recursive: true });
			writeFileSync(join(cwd, "src", "hello.ts"), "export const greeting = 'hello world';\n", "utf8");
			writeFileSync(join(agentDir, "AGENTS.md"), "GLOBAL_BOUNDARY_RULE: preserve user instructions.\n");
			writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_BOUNDARY_RULE: load only when trusted.\n");

			const { registry, faux, model } = await createTestParentRegistry(agentDir);
			const catalog = discoverAgentDefinitions({ cwd, agentDir, projectTrusted: true });
			const resolved = resolveAgentDefinition(catalog, "explorer");
			if (!resolved.ok) throw new Error(resolved.error);
			const explorer = resolved.definition;

			let childSystemPrompt = "";
			faux.setResponses([
				fauxAssistantMessage([
					fauxToolCall("read", { path: "src/hello.ts" }, { id: "c_read_ok" }),
					fauxToolCall("denied_action", {}, { id: "c_denied" }),
				]),
				(context) => {
					const denied = context.messages.find((m) => m.role === "toolResult" && m.toolCallId === "c_denied");
					return fauxAssistantMessage(
						`Found greeting in src/hello.ts. Denied=${denied?.role === "toolResult" && denied.isError}.`,
					);
				},
			]);

			const childModel = await inheritedChildModel(agentDir, registry, model, "low");
			const scheduler = new SubagentRunScheduler({
				executeRun: (params) =>
					runSubagent({
						...params,
						agentDir,
						definition: explorer,
						task: "/not_a_command Inspect src/hello.ts",
						childModel,
						projectTrusted,
						childTools: [defineTool(createReadToolDefinition(cwd)), deniedTool],
						activeToolNames: ["read", "denied_action"],
						builtinExtensions: [],
						onChildSessionCreated: (session) => {
							childSystemPrompt = session.systemPrompt;
						},
					}),
			});

			const handle = admitted(
				scheduler.admit({
					parentSessionId: "parent_1",
					sessionEpoch: 1,
					parentTurnId: "turn_1",
					originToolCallId: "call_1",
					agentName: "explorer",
					definitionSource: explorer.source,
					provider: model.provider,
					modelId: model.id,
					thinkingLevel: "low",
					cwd,
					deliveryMode: "foreground",
					startSnapshot: captureWorkspaceSnapshot(cwd),
				}),
			);
			const finalRecord = await handle.completion;

			expect(finalRecord.status).toBe("completed");
			expect(finalRecord.complete).toBe(true);
			expect(finalRecord.toolExecutions).toEqual({ read: { ok: 1, error: 0 }, denied_action: { ok: 0, error: 1 } });
			expect(childSystemPrompt).toContain("GLOBAL_BOUNDARY_RULE");
			expect(childSystemPrompt.includes("PROJECT_BOUNDARY_RULE")).toBe(projectTrusted);
			expect(finalRecord.summaryText).toContain("Denied=true");
			expect(finalRecord.usage.totalTokens).toBeGreaterThan(0);
		},
	);

	it("lets repeated identical calls and repeated denials run to completion and preserves partial output and error causes against the real SDK", async () => {
		const cwd = makeTempDir("loop-cwd");
		const agentDir = makeTempDir("loop-agent");
		writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n", "utf8");
		writeFileSync(join(cwd, ".env"), "TOKEN=1\n", "utf8");

		const { registry, faux, model } = await createTestParentRegistry(agentDir);
		const catalog = discoverAgentDefinitions({ cwd, agentDir, projectTrusted: true });
		const resolved = resolveAgentDefinition(catalog, "explorer");
		if (!resolved.ok) throw new Error(resolved.error);
		const explorer = resolved.definition;

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" }, { id: "r1" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" }, { id: "r2" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" }, { id: "r3" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" }, { id: "r4" })]),
			fauxAssistantMessage([fauxToolCall("denied_action", {}, { id: "d1" })]),
			fauxAssistantMessage([fauxToolCall("denied_action", {}, { id: "d2" })]),
			fauxAssistantMessage([fauxToolCall("denied_action", {}, { id: "d3" })]),
			fauxAssistantMessage([fauxToolCall("denied_action", {}, { id: "d4" })]),
			(context) => {
				const denied = context.messages.filter(
					(m) =>
						m.role === "toolResult" &&
						m.isError &&
						m.content.some((c) => c.type === "text" && c.text.includes("Blocked by permission rule")),
				);
				return fauxAssistantMessage(`Finished after repeated calls. denied=${denied.length}`);
			},
		]);

		const childModel = await inheritedChildModel(agentDir, registry, model, "off");
		const scheduler = new SubagentRunScheduler({
			executeRun: (params) =>
				runSubagent({
					...params,
					agentDir,
					definition: explorer,
					task: "Loop on a.ts",
					childTools: [defineTool(createReadToolDefinition(cwd)), deniedTool],
					activeToolNames: ["read", "denied_action"],
					builtinExtensions: [],
					childModel,
					projectTrusted: true,
				}),
		});

		const loopHandle = admitted(
			scheduler.admit({
				parentSessionId: "p1",
				sessionEpoch: 1,
				parentTurnId: "t1",
				originToolCallId: "c_loop",
				agentName: "explorer",
				definitionSource: explorer.source,
				provider: model.provider,
				modelId: model.id,
				thinkingLevel: "off",
				cwd,
				deliveryMode: "foreground",
			}),
		);

		const loopResult = await loopHandle.completion;
		expect(loopResult.status).toBe("completed");
		expect(loopResult.complete).toBe(true);
		expect(loopResult.summaryText).toContain("Finished after repeated calls. denied=4");

		// Provider error after partial output preserves partial text and marks status failed
		faux.setResponses([
			fauxAssistantMessage([
				{ type: "text", text: "Earlier turn finding before provider crash." },
				fauxToolCall("read", { path: "a.ts" }, { id: "r_ok" }),
			]),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "500 Internal Provider Failure (Bearer sk-secret-123456)",
			}),
		]);

		const errHandle = admitted(
			scheduler.admit({
				parentSessionId: "p1",
				sessionEpoch: 1,
				parentTurnId: "t1",
				originToolCallId: "c_err",
				agentName: "explorer",
				definitionSource: explorer.source,
				provider: model.provider,
				modelId: model.id,
				thinkingLevel: "off",
				cwd,
				deliveryMode: "foreground",
			}),
		);

		const errResult = await errHandle.completion;
		expect(errResult.status).toBe("failed");
		expect(errResult.complete).toBe(false);
		expect(errResult.summaryText).toContain("Earlier turn finding before provider crash.");
		expect(errResult.errorMessage).toContain("500 Internal Provider Failure");
		expect(errResult.errorMessage).not.toContain("sk-secret-123456");
	});
});
