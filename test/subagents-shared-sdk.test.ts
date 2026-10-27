import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { resolveChildModelAndRuntime } from "../ext/subagents/runner.ts";
import { createSharedSubagentFixture } from "./helpers/shared-subagent-fixture.ts";

const fixtures: Awaited<ReturnType<typeof createSharedSubagentFixture>>[] = [];

async function fixture() {
	const value = await createSharedSubagentFixture();
	fixtures.push(value);
	return value;
}

afterEach(async () => {
	for (const value of fixtures.splice(0)) await value.dispose();
});

describe("shared-subagent public SDK release gate", () => {
	it("writes the live parent tree through its hook after the launch turn settles", async () => {
		const f = await fixture();
		expect(f.parent.isStreaming).toBe(false);
		const child = await f.createChild();
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "worker.ts", content: "export const worker = 1;\n" })),
			fauxAssistantMessage("Child wrote the file."),
		]);
		await child.prompt("Write worker.ts.", { expandPromptTemplates: false });
		expect(readFileSync(join(f.cwd, "worker.ts"), "utf8")).toBe("export const worker = 1;\n");
		expect(f.hookCalls).toContainEqual({ name: "write", parentToolCallId: "parent-launch" });
	});

	it("keeps parent approval checks after launch and measures foreground nested usage", async () => {
		const f = await fixture();
		const parentHookNames: string[] = [];
		const child = await f.createChild();

		// 1. Post-launch deny check through nested integration
		f.deniedPaths.add("blocked.ts");
		f.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"nested_write",
					{ path: "blocked.ts", content: "must not be written" },
					{ id: "denied-child" },
				),
			),
			fauxAssistantMessage("The parent denied this write."),
		]);
		await child.prompt("Attempt the nested write.", { expandPromptTemplates: false });
		const backgroundDenied = child.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "denied-child",
		);
		expect(backgroundDenied?.role === "toolResult" && backgroundDenied.isError).toBe(true);
		expect(existsSync(join(f.cwd, "blocked.ts"))).toBe(false);

		// 2. Post-launch live user approval check
		f.approvalRequiredTools.add("write");
		f.approvalQueue.push(false, true);
		const deniedWrite = await f
			.getToolContext()
			.executeTool("write", { path: "approved.ts", content: "v1\n" }, { signal: new AbortController().signal });
		expect(deniedWrite.isError).toBe(true);
		expect(existsSync(join(f.cwd, "approved.ts"))).toBe(false);

		const approvedWrite = await f
			.getToolContext()
			.executeTool("write", { path: "approved.ts", content: "v2\n" }, { signal: new AbortController().signal });
		expect(approvedWrite.isError).toBe(false);
		expect(readFileSync(join(f.cwd, "approved.ts"), "utf8")).toBe("v2\n");
		for (const call of f.hookCalls) {
			parentHookNames.push(call.name);
		}
		expect(parentHookNames).toContain("write");

		// 3. Foreground nested tool usage is attributed once by the parent SDK on toolResult
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("launch_fixture", { runChildWrite: true }, { id: "fg-launch" })),
			fauxAssistantMessage("Foreground launch done."),
		]);
		await f.parent.prompt("Run foreground launch with nested usage.", { expandPromptTemplates: false });
		const fgToolResult = f.parent.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "fg-launch",
		);
		const ownModelTokens = 18;
		const nestedToolTokens = 8;
		const attributedTokens = fgToolResult?.role === "toolResult" ? (fgToolResult.usage?.totalTokens ?? 0) : 0;
		expect(attributedTokens).toBe(ownModelTokens + nestedToolTokens);
	});

	it("exercises local tool_search and codemode proxies without claiming arbitrary model-only parity", async () => {
		const f = await fixture();
		expect(f.readModelOnlyCount()).toBe("1");
		const child = await f.createChild();

		// Built-in model-only tool_search discovers and activates deferred parent tools in the child
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("tool_search", { query: "deferred stamp" }, { id: "search-1" })),
			fauxAssistantMessage(fauxToolCall("deferred_stamp", { value: "from-child" }, { id: "stamp-1" })),
			fauxAssistantMessage(
				fauxToolCall(
					"codemode",
					{ code: 'await tools.metered_note({ text: "from-codemode" }); return "codemode-ok";' },
					{ id: "code-1" },
				),
			),
			fauxAssistantMessage(fauxToolCall("attempt_nested_subagent", {}, { id: "nested-sub-1" })),
			fauxAssistantMessage("Finished child integration checks."),
		]);
		await child.prompt("Use tool_search, deferred_stamp, codemode, and attempt nested subagent.", {
			expandPromptTemplates: false,
		});

		expect(readFileSync(join(f.cwd, "stamp.txt"), "utf8")).toBe("from-child");
		expect(readFileSync(join(f.cwd, "metered.txt"), "utf8")).toBe("from-codemode");

		const nestedSubagentResult = child.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "nested-sub-1",
		);
		expect(nestedSubagentResult?.role === "toolResult" && nestedSubagentResult.isError).toBe(true);

		// Arbitrary interactive/orchestrating model-only tools are never in loadout.callable and cannot be called via executeTool
		expect(f.getLoadout()?.callable.some((tool) => tool.name === "fixture_action")).toBe(false);
		expect(f.getLoadout()?.callable.some((tool) => tool.name === "subagent")).toBe(false);
		const directModelOnlyAttempt = await f
			.getToolContext()
			.executeTool("fixture_action", {}, { signal: new AbortController().signal });
		expect(directModelOnlyAttempt.isError).toBe(true);
		expect(f.readModelOnlyCount()).toBe("1");
	});

	it("routes virtual models in the child through public ModelRegistry.streamSimple and discloses direct-route state limits", async () => {
		const f = await fixture();
		const registry = f.getToolContext().modelRegistry;
		const observedReasons: string[] = [];
		registry.registerVirtualModel({
			provider: "faux-shared-sdk",
			id: "router",
			name: "Transcript-aware fixture router",
			thinkingLevels: ["off", "high"],
			route: (request) => {
				observedReasons.push(request.reason);
				const nextModelId = request.previous?.model.id === "first-model" ? "second-model" : "first-model";
				return {
					model: registry.find("faux-shared-sdk", nextModelId)!,
					thinkingLevel: request.thinkingLevel,
					state: { step: nextModelId },
				};
			},
		});

		const child = await f.createChild("faux-shared-sdk/router", "high");
		f.faux.setResponses([fauxAssistantMessage("First child route."), fauxAssistantMessage("Second child route.")]);
		await child.prompt("First routed child turn.", { expandPromptTemplates: false });
		await child.prompt("Second routed child turn.", { expandPromptTemplates: false });
		const childModels = child.messages
			.filter((message) => message.role === "assistant")
			.map((message) => message.model);
		expect(childModels).toEqual(["first-model", "second-model"]);
		expect(observedReasons).toEqual(["direct", "direct"]);
	});

	// Decided in #9 (option 2): children get the parent's callable tools only. Model-only tools,
	// which include bluclawd's own delegation tools, stay with the orchestrator.
	it("keeps a parent model-only action out of the child and never executes it", async () => {
		const f = await fixture();
		expect(f.readModelOnlyCount()).toBe("1");
		const child = await f.createChild();
		f.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("fixture_action", {}, { id: "child-action" })),
			fauxAssistantMessage("Child action unavailable."),
		]);
		await child.prompt("Perform the same authorized action.", { expandPromptTemplates: false });
		const result = child.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "child-action",
		);
		const actionResult = result?.role === "toolResult" ? result : undefined;
		expect(actionResult, JSON.stringify(actionResult?.content)).toMatchObject({ isError: true });
		expect(f.readModelOnlyCount()).toBe("1");
	});

	// Decided in #9 (option 2): the public SDK does not carry router state into a child, so
	// production refuses every virtual model for subagents instead of degrading its routing.
	it("does not carry stateful router state into a child, so subagents refuse virtual models", async () => {
		const f = await fixture();
		const registry = f.getToolContext().modelRegistry;
		registry.registerVirtualModel({
			provider: "faux-shared-sdk",
			id: "stateful",
			name: "Stateful fixture router",
			thinkingLevels: ["off"],
			route: (request) => ({
				model: registry.find("faux-shared-sdk", request.state !== undefined ? "second-model" : "first-model")!,
				thinkingLevel: "off",
				state: { progressed: true },
			}),
		});
		await f.parent.setModel(registry.find("faux-shared-sdk", "stateful")!);
		f.faux.setResponses([fauxAssistantMessage("First parent route."), fauxAssistantMessage("Second parent route.")]);
		await f.parent.prompt("First routed turn.", { expandPromptTemplates: false });
		await f.parent.prompt("Second routed turn.", { expandPromptTemplates: false });
		const parentModels = f.parent.messages
			.filter((message) => message.role === "assistant")
			.map((message) => message.model);
		expect(parentModels.slice(-2)).toEqual(["first-model", "second-model"]);

		const child = await f.createChild("faux-shared-sdk/stateful");
		f.faux.setResponses([fauxAssistantMessage("First child route."), fauxAssistantMessage("Second child route.")]);
		await child.prompt("First routed child turn.", { expandPromptTemplates: false });
		await child.prompt("Second routed child turn.", { expandPromptTemplates: false });
		const childModels = child.messages
			.filter((message) => message.role === "assistant")
			.map((message) => message.model);
		expect(childModels).toEqual(["first-model", "first-model"]);

		for (const requestedModel of ["inherit", "faux-shared-sdk/stateful"] as const) {
			const resolved = await resolveChildModelAndRuntime({
				agentDir: join(f.cwd, "parent"),
				requestedModel,
				parentModel: f.parent.model,
				requestedThinkingLevel: "off",
				parentModelRegistry: registry,
			});
			expect(resolved).toMatchObject({ ok: false, error: expect.stringMatching(/Virtual model .* subagent/) });
		}
	});

	it("refuses the captured executor after parent disposal", async () => {
		const f = await fixture();
		const ctx = f.getToolContext();
		await f.dispose();
		await expect(
			ctx.executeTool(
				"write",
				{ path: "late.txt", content: "must not be written" },
				{ signal: new AbortController().signal },
			),
		).rejects.toThrow(/stale|disposed|invalid/i);
		expect(existsSync(join(f.cwd, "late.txt"))).toBe(false);
	});
});
