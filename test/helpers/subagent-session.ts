import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type defineTool,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createSubagentsExtension } from "../../ext/subagents/index.ts";

/** A parent session on a faux provider with the subagents extension and the given tools and hooks. */
export async function createParentSessionWithSubagents(options: {
	cwd: string;
	agentDir: string;
	extraTools?: ReturnType<typeof defineTool>[];
	/** Pi built-in tools the parent has; none when omitted. */
	builtinTools?: string[];
	extensions?: ExtensionFactory[];
	batchWindowMs?: number;
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
		extensionFactories: [
			createSubagentsExtension({ agentDir: options.agentDir, batchWindowMs: options.batchWindowMs }),
			...(options.extensions ?? []),
		],
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
		...(options.builtinTools
			? { tools: [...options.builtinTools, "subagent*", ...(options.extraTools ?? []).map((tool) => tool.name)] }
			: { noTools: "builtin" as const }),
		customTools: options.extraTools,
		resourceLoader,
		sessionManager: SessionManager.inMemory(options.cwd),
		settingsManager,
	});

	return { session, faux, modelRuntime };
}
