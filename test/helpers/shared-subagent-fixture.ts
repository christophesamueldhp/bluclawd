import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Model,
	type Provider,
	Type,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	createCodemodeExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	type ExtensionFactory,
	type ExtensionToolContext,
	type ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
	type ToolLoadout,
} from "@earendil-works/pi-coding-agent";

const CHILD_VIRTUAL_API = "pi-subagent-virtual-proxy";

export function bridgeModelToParentRegistry(
	childRuntime: ModelRuntime,
	parentRegistry: ModelRegistry,
	targetModel: Model<Api>,
): Model<Api> {
	const exposedModel: Model<Api> =
		targetModel.api === "pi-virtual"
			? {
					...targetModel,
					api: CHILD_VIRTUAL_API,
				}
			: targetModel;

	const existingProvider = childRuntime.getProvider(targetModel.provider);
	const mergedModels = [
		...(existingProvider?.getModels().filter((m) => m.id !== exposedModel.id) ?? []),
		exposedModel,
	];

	const proxyProvider: Provider = {
		id: targetModel.provider,
		name: parentRegistry.getProviderDisplayName(targetModel.provider),
		auth: {
			apiKey: {
				name: "Parent ModelRegistry proxy",
				resolve: async () => ({ auth: { apiKey: "parent-registry-proxy" }, source: "runtime" }),
			},
		},
		getModels: () => mergedModels,
		stream: (_model, context, options) => parentRegistry.stream(targetModel, context, options),
		streamSimple: (_model, context, options) => parentRegistry.streamSimple(targetModel, context, options),
	};
	childRuntime.registerNativeProvider(proxyProvider);
	return exposedModel;
}

export async function createSharedSubagentFixture() {
	const cwd = mkdtempSync(join(tmpdir(), "bluclawd-shared-sdk-"));
	const faux = fauxProvider({
		provider: "faux-shared-sdk",
		models: [
			{
				id: "first-model",
				reasoning: true,
				cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			},
			{
				id: "second-model",
				reasoning: true,
				cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			},
		],
	});
	const events: AgentSessionEvent[] = [];
	const hookCalls: Array<{ name: string; parentToolCallId?: string }> = [];
	const deniedPaths = new Set<string>();
	const approvalRequiredTools = new Set<string>();
	const approvalQueue: boolean[] = [];
	const children: AgentSession[] = [];
	let context: ExtensionToolContext | undefined;
	let loadout: ToolLoadout | undefined;
	let modelOnlyExecutions = 0;
	let disposed = false;

	async function runtimeAt(name: string) {
		return ModelRuntime.create({
			authPath: join(cwd, name, "auth.json"),
			modelsPath: join(cwd, name, "models.json"),
			modelsStorePath: join(cwd, name, "models-store.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
	}

	async function loaderFor(
		name: string,
		extensions: ExtensionFactory[] = [],
		disabledBuiltinExtensions: string[] = ["mcp", "codemode", "tool_search"],
	) {
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: join(cwd, name),
			settingsManager,
			extensionFactories: extensions,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			disabledBuiltinExtensions,
		});
		await resourceLoader.reload();
		return { settingsManager, resourceLoader };
	}

	const modelRuntime = await runtimeAt("parent");
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const resources = await loaderFor("parent", [
		createToolSearchExtension(),
		createCodemodeExtension({ mode: "on" }),
		(pi) => {
			pi.on("tool_call", async (event, ctx) => {
				hookCalls.push({ name: event.toolName, parentToolCallId: event.parentToolCallId });
				if (event.toolName === "subagent" && event.parentToolCallId) {
					return { block: true, reason: "Nested subagent delegation is forbidden." };
				}
				if (event.toolName === "write" && deniedPaths.has(String(event.input.path))) {
					return { block: true, reason: "Denied by current fixture parent policy" };
				}
				if (approvalRequiredTools.has(event.toolName)) {
					const approved = await ctx.ui.confirm("Approve tool?", event.toolName);
					if (!approved) {
						return { block: true, reason: `User denied ${event.toolName}` };
					}
				}
			});
			pi.registerTool({
				name: "subagent",
				label: "Subagent",
				exposure: "model-only",
				description: "Simulated orchestrator-only subagent tool.",
				parameters: Type.Object({ task: Type.String() }),
				execute: async () => ({
					content: [{ type: "text", text: "Subagent spawned." }],
					details: undefined,
				}),
			});
			pi.registerTool({
				name: "launch_fixture",
				label: "Launch fixture",
				exposure: "model-only",
				description: "Capture the public parent execution context for the SDK proof.",
				parameters: Type.Object({
					runChildWrite: Type.Optional(Type.Boolean()),
				}),
				prepareLoadout: (current) => {
					loadout = current;
					return undefined;
				},
				execute: async (_id, args, signal, _update, ctx) => {
					context = ctx;
					if (args.runChildWrite) {
						const nested = await ctx!.executeTool("metered_note", { text: "foreground-nested" }, { signal });
						if (nested.isError) {
							return { content: nested.result.content, details: undefined, isError: true };
						}
						return {
							content: [{ type: "text", text: "Foreground launch with nested usage." }],
							details: undefined,
							usage: {
								input: 11,
								output: 7,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 18,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						};
					}
					return { content: [{ type: "text", text: "Launched." }], details: undefined };
				},
			});
			pi.registerTool({
				name: "fixture_action",
				label: "Model-only action",
				exposure: "model-only",
				description: "Perform an interactive model-only fixture action that is never callable via executeTool.",
				parameters: Type.Object({}),
				execute: async () => {
					writeFileSync(join(cwd, "model-only.txt"), String(++modelOnlyExecutions));
					return { content: [{ type: "text", text: "Action completed." }], details: undefined };
				},
			});
			pi.registerTool({
				name: "deferred_stamp",
				label: "Deferred stamp",
				exposure: "deferred",
				description: "Write a stamp file after being discovered through tool_search.",
				parameters: Type.Object({ value: Type.String() }),
				execute: async (_id, args) => {
					writeFileSync(join(cwd, "stamp.txt"), args.value, "utf8");
					return { content: [{ type: "text", text: `Stamped ${args.value}` }], details: undefined };
				},
			});
			pi.registerTool({
				name: "metered_note",
				label: "Metered note",
				description: "Callable tool that reports nested model/classifier token usage.",
				parameters: Type.Object({ text: Type.String() }),
				execute: async (_id, args) => {
					writeFileSync(join(cwd, "metered.txt"), args.text, "utf8");
					return {
						content: [{ type: "text", text: `Noted ${args.text}` }],
						details: undefined,
						usage: {
							input: 5,
							output: 3,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 8,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
				},
			});
			pi.registerTool({
				name: "nested_write",
				label: "Nested write",
				description: "Exercise an integration calling the parent's write tool.",
				parameters: Type.Object({ path: Type.String(), content: Type.String() }),
				execute: async (_id, args, signal, _update, ctx) => {
					const outcome = await ctx!.executeTool("write", args, { signal });
					return { ...outcome.result, isError: outcome.isError };
				},
			});
			pi.registerTool({
				name: "attempt_nested_subagent",
				label: "Attempt nested subagent",
				description: "Attempt to invoke subagent through nested executeTool.",
				parameters: Type.Object({}),
				execute: async (_id, _args, signal, _update, ctx) => {
					const outcome = await ctx!.executeTool("subagent", { task: "illegal nested spawn" }, { signal });
					return { ...outcome.result, isError: outcome.isError };
				},
			});
		},
	]);
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir: join(cwd, "parent"),
		modelRuntime,
		model: faux.getModel("first-model"),
		thinkingLevel: "off",
		tools: [
			"read",
			"write",
			"edit",
			"subagent",
			"launch_fixture",
			"fixture_action",
			"deferred_stamp",
			"metered_note",
			"nested_write",
			"attempt_nested_subagent",
			"tool_search",
			"codemode",
		],
		...resources,
		sessionManager: SessionManager.inMemory(cwd),
	});
	parent.subscribe((event) => events.push(event));
	await parent.bindExtensions({
		mode: "tui",
		uiContext: {
			confirm: async () => approvalQueue.shift() ?? false,
			notify: () => {},
			setStatus: () => {},
			setTitle: () => {},
			setWidget: () => {},
			custom: async () => undefined as never,
			getEditorText: () => "",
			setEditorText: () => {},
			theme: {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
				dim: (text: string) => text,
				italic: (text: string) => text,
				underline: (text: string) => text,
				strikethrough: (text: string) => text,
			} as never,
		} as never,
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("fixture_action", {}, { id: "parent-action" })),
		fauxAssistantMessage(fauxToolCall("launch_fixture", {}, { id: "parent-launch" })),
		fauxAssistantMessage("Parent finished its launch turn."),
	]);
	await parent.prompt("Perform the action and launch the fixture.", { expandPromptTemplates: false });

	function getToolContext(): ExtensionToolContext {
		if (!context) throw new Error("Parent did not supply a tool context");
		return context;
	}

	return {
		cwd,
		parent,
		faux,
		events,
		hookCalls,
		deniedPaths,
		approvalRequiredTools,
		approvalQueue,
		getToolContext,
		getLoadout: () => loadout,
		readModelOnlyCount: () => readFileSync(join(cwd, "model-only.txt"), "utf8"),
		async createChild(modelId = "faux-shared-sdk/first-model", thinkingLevel: ThinkingLevel = "off") {
			const ctx = getToolContext();
			const childName = `child-${children.length}`;
			const childRuntime = await runtimeAt(childName);
			const slash = modelId.indexOf("/");
			const targetModel = ctx.modelRegistry.find(modelId.slice(0, slash), modelId.slice(slash + 1));
			if (!targetModel || !loadout) throw new Error("Missing selected model or public tool loadout");
			const childModel = bridgeModelToParentRegistry(childRuntime, ctx.modelRegistry, targetModel);
			await childRuntime.refresh({ allowNetwork: false });

			const callableDefinitions: ToolDefinition[] = loadout.callable.map((tool) => {
				const exposure = loadout!.getExposure(tool.name);
				const namespace = loadout!.getNamespace(tool.name);
				const guidelines = loadout!.getPromptGuidelines(tool.name);
				return {
					name: tool.name,
					label: tool.label,
					description: tool.description,
					parameters: tool.parameters,
					outputSchema: tool.outputSchema,
					exposure,
					namespace,
					promptGuidelines: guidelines.length > 0 ? [...guidelines] : undefined,
					execute: async (_id, args, signal, onUpdate) => {
						const outcome = await ctx.executeTool(tool.name, args, { signal, onUpdate });
						return {
							...outcome.result,
							...(outcome.result.structuredContent !== undefined
								? { structuredContent: outcome.result.structuredContent }
								: {}),
							isError: outcome.isError,
						};
					},
				};
			});

			const declaredActiveNames = loadout.declared
				.map((tool) => tool.name)
				.filter(
					(name) =>
						name !== "subagent" &&
						name !== "launch_fixture" &&
						(loadout!.getExposure(name) === "direct" || name === "tool_search" || name === "codemode"),
				);

			const childResources = await loaderFor(childName, [
				createToolSearchExtension(),
				createCodemodeExtension({ mode: "on" }),
			]);
			const { session } = await createAgentSession({
				cwd,
				agentDir: join(cwd, childName),
				modelRuntime: childRuntime,
				model: childModel,
				thinkingLevel,
				noTools: "builtin",
				tools: [...new Set([...declaredActiveNames, ...callableDefinitions.map((tool) => tool.name)])],
				customTools: callableDefinitions,
				...childResources,
				sessionManager: SessionManager.inMemory(cwd),
			});
			children.push(session);
			await session.bindExtensions({});
			session.setActiveToolsByName(declaredActiveNames);
			return session;
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			for (const session of [...children, parent]) {
				await session.abort();
				await session.waitForIdle();
				session.dispose();
			}
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}
