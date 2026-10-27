import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createSubagentPolicySnapshot } from "../ext/permissions/policy.ts";
import {
	discoverAgentDefinitions,
	isReadOnlySubagentTools,
	resolveAgentDefinition,
} from "../ext/subagents/definitions.ts";
import {
	captureWorkspaceSnapshot,
	MAX_CHILD_TOOL_OUTPUT_BYTES,
	resolveChildModelAndRuntime,
	runRestrictedSubagent,
} from "../ext/subagents/runner.ts";
import { SubagentRunScheduler } from "../ext/subagents/runs.ts";

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

describe("Task 4 (M1) — Restricted child runner", () => {
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
		expect(inherited.ok).toBe(true);
		expect(inherited.model?.id).toBe("faux-1");
		expect(inherited.thinkingLevel).toBe("low");

		// 2. Missing parent model fails before starting work
		const missingParent = await resolveChildModelAndRuntime({
			agentDir,
			requestedModel: "inherit",
			parentModel: undefined,
			requestedThinkingLevel: "off",
			parentModelRegistry: registry,
		});
		expect(missingParent.ok).toBe(false);
		expect(missingParent.error).toMatch(/no active model/i);

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
		expect(virtualRes.ok).toBe(false);
		expect(virtualRes.error).toMatch(/virtual model/i);

		// 4. Explicit unknown provider/model fails before starting work
		const unknownExplicit = await resolveChildModelAndRuntime({
			agentDir,
			requestedModel: "unknown-prov/missing-model",
			parentModel: model,
			requestedThinkingLevel: "low",
			parentModelRegistry: registry,
		});
		expect(unknownExplicit.ok).toBe(false);
		expect(unknownExplicit.error).toMatch(/unknown-prov\/missing-model/i);
	});

	it.each([false, true])(
		"enforces read-only tools, deny rules, output caps, and global instructions when project trust=%s",
		async (projectTrusted) => {
			const cwd = makeTempDir("cwd");
			const agentDir = makeTempDir("agent");
			mkdirSync(join(cwd, "src"), { recursive: true });
			writeFileSync(join(cwd, "src", "hello.ts"), "export const greeting = 'hello world';\n", "utf8");
			writeFileSync(join(cwd, ".env"), "SECRET_TOKEN=top_secret_value\n", "utf8");
			writeFileSync(join(agentDir, "AGENTS.md"), "GLOBAL_BOUNDARY_RULE: preserve user instructions.\n");
			writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_BOUNDARY_RULE: load only when trusted.\n");
			writeFileSync(join(cwd, "src", "huge.txt"), `${"line-content-0123456789abcdef\n".repeat(2000)}`, "utf8");

			const { registry, faux, model } = await createTestParentRegistry(agentDir);
			const catalog = discoverAgentDefinitions({ cwd, agentDir, projectTrusted: true });
			const explorer = resolveAgentDefinition(catalog, "explorer").definition!;
			if (!isReadOnlySubagentTools(explorer.tools)) throw new Error("Expected read-only explorer");
			const policy = createSubagentPolicySnapshot({
				cwd,
				denyRules: ["Read(.env)"],
				allowedTools: explorer.tools,
			}).snapshot!;

			let activeToolsSeenByChild: string[] = [];
			let childSystemPrompt = "";
			faux.setResponses([
				// Turn 1: read allowed file, attempt denied file `.env`, and read huge file
				fauxAssistantMessage([
					fauxToolCall("read", { path: "src/hello.ts" }, { id: "c_read_ok" }),
					fauxToolCall("read", { path: ".env" }, { id: "c_read_denied" }),
					fauxToolCall("read", { path: "src/huge.txt" }, { id: "c_read_huge" }),
				]),
				// Turn 2: summarize findings
				(context) => {
					const toolMessages = context.messages.filter((m) => m.role === "toolResult");
					const deniedMsg = toolMessages.find((m) => m.toolCallId === "c_read_denied");
					const hugeMsg = toolMessages.find((m) => m.toolCallId === "c_read_huge");
					const deniedText = deniedMsg?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
					const hugeText = hugeMsg?.content.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
					return fauxAssistantMessage(
						[
							"### Scope",
							"- Inspected: `src/hello.ts`, `src/huge.txt`",
							"- Omitted: `.env` (denied)",
							"- Assumptions: none",
							"",
							"### Summary",
							`Found greeting in src/hello.ts. Denied check=${deniedMsg?.isError}:${deniedText.includes("Blocked by permission rule")}. Huge capped=${Buffer.byteLength(hugeText, "utf8") <= MAX_CHILD_TOOL_OUTPUT_BYTES + 256 && hugeText.includes("Child tool output capped")}.`,
							"",
							"### Evidence",
							"- `src/hello.ts:1` — exports `greeting`",
							"",
							"### Blockers",
							"- `.env` blocked by Read(.env)",
						].join("\n"),
					);
				},
			]);

			const scheduler = new SubagentRunScheduler({
				executeRun: (params) =>
					runRestrictedSubagent({
						...params,
						agentDir,
						definition: explorer,
						requestedModel: explorer.model,
						task: "/not_a_command Inspect src/hello.ts",
						policySnapshot: policy,
						parentModel: model,
						requestedThinkingLevel: "low",
						parentModelRegistry: registry,
						projectTrusted,
						onChildSessionCreated: (session) => {
							childSystemPrompt = session.systemPrompt;
							activeToolsSeenByChild = session.getActiveToolNames();
						},
					}),
			});

			const admitted = scheduler.admit({
				parentSessionId: "parent_1",
				runtimeGeneration: 1,
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
			});
			expect(admitted.ok).toBe(true);
			const finalRecord = await admitted.handle!.completion;

			expect(finalRecord.status).toBe("completed");
			expect(finalRecord.complete).toBe(true);
			expect(activeToolsSeenByChild.sort()).toEqual(["find", "grep", "ls", "read"]);
			expect(childSystemPrompt).toContain("GLOBAL_BOUNDARY_RULE");
			expect(childSystemPrompt.includes("PROJECT_BOUNDARY_RULE")).toBe(projectTrusted);
			expect(finalRecord.summaryText).toContain("Denied check=true:true");
			expect(finalRecord.summaryText).toContain("Huge capped=true");
			expect(finalRecord.summaryText).not.toContain("top_secret_value");
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
		const explorer = resolveAgentDefinition(catalog, "explorer").definition!;
		if (!isReadOnlySubagentTools(explorer.tools)) throw new Error("Expected read-only explorer");
		const policy = createSubagentPolicySnapshot({
			cwd,
			denyRules: ["Read(.env)"],
			allowedTools: explorer.tools,
		}).snapshot!;

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" }, { id: "r1" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" }, { id: "r2" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" }, { id: "r3" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: "a.ts" }, { id: "r4" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: ".env" }, { id: "d1" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: ".env" }, { id: "d2" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: ".env" }, { id: "d3" })]),
			fauxAssistantMessage([fauxToolCall("read", { path: ".env" }, { id: "d4" })]),
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

		const scheduler = new SubagentRunScheduler({
			executeRun: (params) =>
				runRestrictedSubagent({
					...params,
					agentDir,
					definition: explorer,
					requestedModel: explorer.model,
					task: "Loop on a.ts",
					policySnapshot: policy,
					parentModel: model,
					requestedThinkingLevel: "off",
					parentModelRegistry: registry,
					projectTrusted: true,
				}),
		});

		const loopHandle = scheduler.admit({
			parentSessionId: "p1",
			runtimeGeneration: 1,
			parentTurnId: "t1",
			originToolCallId: "c_loop",
			agentName: "explorer",
			definitionSource: explorer.source,
			provider: model.provider,
			modelId: model.id,
			thinkingLevel: "off",
			cwd,
			deliveryMode: "foreground",
		}).handle!;

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

		const errHandle = scheduler.admit({
			parentSessionId: "p1",
			runtimeGeneration: 1,
			parentTurnId: "t1",
			originToolCallId: "c_err",
			agentName: "explorer",
			definitionSource: explorer.source,
			provider: model.provider,
			modelId: model.id,
			thinkingLevel: "off",
			cwd,
			deliveryMode: "foreground",
		}).handle!;

		const errResult = await errHandle.completion;
		expect(errResult.status).toBe("failed");
		expect(errResult.complete).toBe(false);
		expect(errResult.summaryText).toContain("Earlier turn finding before provider crash.");
		expect(errResult.errorMessage).toContain("500 Internal Provider Failure");
		expect(errResult.errorMessage).not.toContain("sk-secret-123456");
	});
});
