import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	Type,
} from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	type ExtensionFactory,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bluclawd-${prefix}-`));
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

async function createOfflineModelRuntime(agentDir: string): Promise<ModelRuntime> {
	return ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: true,
	});
}

async function createRestrictedLoader(
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	extensionFactories: ExtensionFactory[] = [],
): Promise<DefaultResourceLoader> {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
	});
	await loader.reload();
	return loader;
}

describe("Task 0 (M0) — Pi 1.0.4 public SDK compatibility and lifecycle proof", () => {
	it("binds extensions before prompting, streams events in order, and settles with agent_settled", async () => {
		const cwd = makeTempDir("sdk-cwd");
		const agentDir = makeTempDir("sdk-agent");
		const modelRuntime = await createOfflineModelRuntime(agentDir);
		const faux = fauxProvider({
			provider: "faux-local",
			models: [{ id: "faux-chat", reasoning: true }],
		});
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });

		faux.setResponses([fauxAssistantMessage("Offline child response.")]);

		const events: string[] = [];
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const resourceLoader = await createRestrictedLoader(cwd, agentDir, settingsManager, [
			(pi) => {
				pi.on("session_start", () => {
					events.push("ext:session_start");
				});
				pi.on("before_agent_start", () => {
					events.push("ext:before_agent_start");
				});
				pi.on("agent_settled", () => {
					events.push("ext:agent_settled");
				});
			},
		]);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: faux.getModel("faux-chat"),
			thinkingLevel: "low",
			tools: ["read"],
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
		});

		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (
				event.type === "agent_start" ||
				event.type === "message_start" ||
				event.type === "message_end" ||
				event.type === "agent_end" ||
				event.type === "agent_settled"
			) {
				events.push(`session:${event.type}`);
			}
		});

		try {
			await session.bindExtensions({});
			expect(events).toEqual(["ext:session_start"]);

			await session.prompt("Inspect the workspace.", { expandPromptTemplates: false });
			expect(session.getLastAssistantText()).toBe("Offline child response.");
			expect(events.indexOf("ext:session_start")).toBeLessThan(events.indexOf("ext:before_agent_start"));
			expect(events.indexOf("session:agent_end")).toBeLessThan(events.indexOf("session:agent_settled"));
		} finally {
			unsubscribe();
			session.dispose();
		}
	});

	it("waits for retry completion before emitting agent_settled and surfaces final error or length outcomes", async () => {
		const cwd = makeTempDir("sdk-retry-cwd");
		const agentDir = makeTempDir("sdk-retry-agent");
		const modelRuntime = await createOfflineModelRuntime(agentDir);
		const faux = fauxProvider({
			provider: "faux-retry",
			models: [{ id: "faux-retry-model", reasoning: false }],
		});
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });

		faux.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "529 Overloaded",
			}),
			fauxAssistantMessage("Recovered on retry."),
		]);

		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 5, maxAgentDelayMs: 10 },
		});
		const resourceLoader = await createRestrictedLoader(cwd, agentDir, settingsManager);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: faux.getModel("faux-retry-model"),
			noTools: "all",
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
		});

		const agentEndWillRetry: boolean[] = [];
		let settledCount = 0;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_end") {
				agentEndWillRetry.push(event.willRetry);
			}
			if (event.type === "agent_settled") {
				settledCount++;
			}
		});

		try {
			await session.bindExtensions({});
			await session.prompt("Test retry settlement.", { expandPromptTemplates: false });
			expect(agentEndWillRetry).toEqual([true, false]);
			expect(settledCount).toBe(1);
			expect(session.getLastAssistantText()).toBe("Recovered on retry.");

			// Non-retryable error outcome
			faux.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "400 Invalid request payload",
				}),
			]);
			await session.prompt("Trigger non-retryable error.", { expandPromptTemplates: false });
			const lastErr = session.messages.at(-1);
			expect(lastErr?.role).toBe("assistant");
			if (lastErr?.role === "assistant") {
				expect(lastErr.stopReason).toBe("error");
				expect(lastErr.errorMessage).toContain("400 Invalid request payload");
			}

			// Length stop reason outcome
			faux.setResponses([
				fauxAssistantMessage("Partial output cut off at token limit", {
					stopReason: "length",
				}),
			]);
			await session.prompt("Trigger length stop.", { expandPromptTemplates: false });
			const lastLength = session.messages.at(-1);
			expect(lastLength?.role).toBe("assistant");
			if (lastLength?.role === "assistant") {
				expect(lastLength.stopReason).toBe("length");
			}
		} finally {
			unsubscribe();
			session.dispose();
		}
	});

	it("supports cancellation during streaming and during retry backoff", async () => {
		const cwd = makeTempDir("sdk-abort-cwd");
		const agentDir = makeTempDir("sdk-abort-agent");
		const modelRuntime = await createOfflineModelRuntime(agentDir);
		const faux = fauxProvider({
			provider: "faux-slow",
			tokensPerSecond: 10,
			models: [{ id: "faux-slow-model", reasoning: false }],
		});
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });

		faux.setResponses([fauxAssistantMessage("A long streamed response ".repeat(40))]);

		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 5000, maxAgentDelayMs: 5000 },
		});
		const resourceLoader = await createRestrictedLoader(cwd, agentDir, settingsManager);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: faux.getModel("faux-slow-model"),
			noTools: "all",
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
		});

		const unsubscribe = session.subscribe((event) => {
			if (event.type === "message_update") {
				void session.abort();
			}
			if (event.type === "auto_retry_start") {
				session.abortRetry();
			}
		});

		try {
			await session.bindExtensions({});
			await session.prompt("Stream and abort.", { expandPromptTemplates: false });
			const last = session.messages.at(-1);
			expect(last?.role).toBe("assistant");
			if (last?.role === "assistant") {
				expect(last.stopReason).toBe("aborted");
			}

			// Now test aborting during retry backoff
			faux.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "529 Overloaded",
				}),
				fauxAssistantMessage("Should never be reached after abortRetry."),
			]);
			await session.prompt("Fail and abort retry.", { expandPromptTemplates: false });
			expect(faux.getPendingResponseCount()).toBe(1);
		} finally {
			unsubscribe();
			session.dispose();
		}
	});

	it("proves model and thinking inheritance across native, models.json, and extension-registered providers, and explicitly detects virtual models", async () => {
		const agentDir = makeTempDir("sdk-inherit-agent");
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({
				"configured-json": { type: "api_key", key: "synthetic-json-key" },
			}),
			"utf8",
		);
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"configured-json": {
						name: "Configured JSON Provider",
						baseUrl: "http://127.0.0.1:0/v1",
						api: "openai-completions",
						models: [
							{
								id: "json-model-1",
								name: "JSON Model 1",
								reasoning: true,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 64000,
								maxTokens: 4096,
							},
						],
					},
				},
			}),
			"utf8",
		);

		const parentRuntime = await createOfflineModelRuntime(agentDir);
		const parentRegistry = new ModelRegistry(parentRuntime);

		// 1. Native provider registered on parent
		const nativeFaux = fauxProvider({
			provider: "native-ext",
			models: [{ id: "native-1", reasoning: true }],
		});
		parentRegistry.registerProvider(nativeFaux.provider);

		// 2. Extension provider registered via ProviderConfigInput with custom streamSimple
		let observedHeader: string | undefined;
		let observedReasoning: string | undefined;
		parentRegistry.registerProvider("config-ext", {
			name: "Config Extension Provider",
			baseUrl: "http://127.0.0.1:0/ext",
			apiKey: "synthetic-ext-key",
			api: "openai-completions",
			headers: { "x-custom-org": "bluclawd-test" },
			models: [
				{
					id: "config-model-1",
					name: "Config Model 1",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32000,
					maxTokens: 2048,
				},
			],
			streamSimple: (model, _context, options) => {
				observedHeader = options?.headers?.["x-custom-org"];
				observedReasoning = options?.reasoning;
				const stream = createAssistantMessageEventStream();
				const msg = {
					...fauxAssistantMessage("From config-ext streamSimple."),
					api: model.api,
					provider: model.provider,
					model: model.id,
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: { ...msg, stopReason: "pending" } });
					stream.push({ type: "done", reason: "stop", message: msg });
					stream.end(msg);
				});
				return stream;
			},
		});

		// 3. Virtual model registered on parent
		parentRegistry.registerVirtualModel({
			provider: "virtual-router",
			id: "auto",
			name: "Virtual Auto Router",
			thinkingLevels: ["low", "high"],
			route: () => ({
				model: nativeFaux.getModel("native-1"),
				thinkingLevel: "low",
			}),
		});
		await parentRegistry.refresh({ allowNetwork: false });

		// Clone provider registrations into a child ModelRuntime using ONLY public ModelRegistry APIs
		const childRuntime = await createOfflineModelRuntime(agentDir);
		for (const providerId of parentRegistry.getRegisteredProviderIds()) {
			const nativeProvider = parentRegistry.getRegisteredNativeProvider(providerId);
			if (nativeProvider) {
				childRuntime.registerNativeProvider(nativeProvider);
				continue;
			}
			const providerConfig = parentRegistry.getRegisteredProviderConfig(providerId);
			if (providerConfig) {
				childRuntime.registerProvider(providerId, providerConfig);
			}
		}
		await childRuntime.refresh({ allowNetwork: false });
		await childRuntime.getAvailable();

		// Verify configured models.json model & auth are inherited
		const jsonModel = childRuntime.getModel("configured-json", "json-model-1");
		expect(jsonModel).toBeDefined();
		expect((await childRuntime.checkAuth("configured-json")) !== undefined).toBe(true);

		// Verify native extension provider is inherited
		const nativeModel = childRuntime.getModel("native-ext", "native-1");
		expect(nativeModel).toBeDefined();
		expect((await childRuntime.checkAuth("native-ext")) !== undefined).toBe(true);

		// Verify config extension provider + headers + thinking level are inherited when running a child session
		const configModel = childRuntime.getModel("config-ext", "config-model-1");
		expect(configModel).toBeDefined();
		const cwd = makeTempDir("sdk-inherit-cwd");
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const resourceLoader = await createRestrictedLoader(cwd, agentDir, settingsManager);
		const { session: childSession } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: childRuntime,
			model: configModel,
			thinkingLevel: "high",
			noTools: "all",
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
		});
		try {
			await childSession.bindExtensions({});
			await childSession.prompt("Verify inherited provider.", { expandPromptTemplates: false });
			expect(childSession.getLastAssistantText()).toBe("From config-ext streamSimple.");
			expect(observedHeader).toBe("bluclawd-test");
			expect(observedReasoning).toBe("high");
		} finally {
			childSession.dispose();
		}

		// Verify virtual model is identifiable via public `model.api === "pi-virtual"` so it can be rejected explicitly
		const virtualModel = parentRegistry.find("virtual-router", "auto");
		expect(virtualModel).toBeDefined();
		expect(virtualModel?.api).toBe("pi-virtual");
		expect(childRuntime.getModel("virtual-router", "auto")).toBeUndefined();
	});

	it("returns child usage once through the outer tool contract and marks tool failures with isError: true while preserving details and usage", async () => {
		const cwd = makeTempDir("sdk-usage-cwd");
		const agentDir = makeTempDir("sdk-usage-agent");
		const modelRuntime = await createOfflineModelRuntime(agentDir);
		const faux = fauxProvider({
			provider: "faux-parent",
			models: [{ id: "faux-model", reasoning: false }],
		});
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });

		const syntheticChildUsage = {
			input: 120,
			output: 45,
			cacheRead: 10,
			cacheWrite: 20,
			totalTokens: 195,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
		};

		const subagentProbeTool = defineTool({
			name: "subagent_probe",
			label: "Subagent Probe",
			description: "Test tool for M0 usage and error contract",
			parameters: Type.Object({
				shouldFail: Type.Boolean(),
			}),
			async execute(_toolCallId, params) {
				if (params.shouldFail) {
					return {
						content: [{ type: "text", text: "Subagent run failed (provider error)." }],
						details: { runId: "sub_err_1", status: "failed" },
						usage: syntheticChildUsage,
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: "Subagent run completed." }],
					details: { runId: "sub_ok_1", status: "completed" },
					usage: syntheticChildUsage,
				};
			},
		});

		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const resourceLoader = await createRestrictedLoader(cwd, agentDir, settingsManager);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: faux.getModel("faux-model"),
			noTools: "builtin",
			customTools: [subagentProbeTool],
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
		});

		try {
			await session.bindExtensions({});

			// 1. Successful tool call with child usage
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("subagent_probe", { shouldFail: false }, { id: "call_ok" })]),
				fauxAssistantMessage("Parent received child result."),
			]);
			await session.prompt("Run successful child probe.", { expandPromptTemplates: false });

			const okResultMsg = session.messages.find((m) => m.role === "toolResult" && m.toolCallId === "call_ok");
			expect(okResultMsg?.role).toBe("toolResult");
			if (okResultMsg?.role === "toolResult") {
				expect(okResultMsg.isError).toBe(false);
				expect(okResultMsg.details).toEqual({ runId: "sub_ok_1", status: "completed" });
				expect(okResultMsg.usage).toEqual(syntheticChildUsage);
			}

			const statsAfterOk = session.getSessionStats();
			// Parent faux model has 0 cost; child usage has 0.033 total cost, counted exactly once
			expect(statsAfterOk.cost).toBeCloseTo(0.033, 6);

			// 2. Failed tool call returning isError: true preserves details and usage
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("subagent_probe", { shouldFail: true }, { id: "call_err" })]),
				fauxAssistantMessage("Parent handled child failure."),
			]);
			await session.prompt("Run failing child probe.", { expandPromptTemplates: false });

			const errResultMsg = session.messages.find((m) => m.role === "toolResult" && m.toolCallId === "call_err");
			expect(errResultMsg?.role).toBe("toolResult");
			if (errResultMsg?.role === "toolResult") {
				expect(errResultMsg.isError).toBe(true);
				expect(errResultMsg.details).toEqual({ runId: "sub_err_1", status: "failed" });
				expect(errResultMsg.usage).toEqual(syntheticChildUsage);
			}

			const statsAfterErr = session.getSessionStats();
			expect(statsAfterErr.cost).toBeCloseTo(0.066, 6);
		} finally {
			session.dispose();
		}
	});
});
