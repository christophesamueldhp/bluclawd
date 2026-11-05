import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir, type ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { isSubagentThinkingLevel, type SubagentModelSpec } from "./definitions.ts";

const VIRTUAL_MODEL_API = "pi-virtual";
const VIRTUAL_MODEL_REASON =
	"virtual model routers are not inspectable via public ModelRegistry APIs, so a child cannot preserve their routing";

export interface ResolveChildModelOptions {
	agentDir?: string;
	requestedModel: SubagentModelSpec;
	parentModel: Model<Api> | undefined;
	requestedThinkingLevel: ThinkingLevel | string | undefined;
	parentModelRegistry: ModelRegistry;
}

export type ResolveChildModelResult =
	| {
			readonly ok: true;
			readonly modelRuntime: ModelRuntime;
			readonly model: Model<Api>;
			readonly thinkingLevel?: ThinkingLevel;
	  }
	| { readonly ok: false; readonly error: string };

export interface SubagentModelInfo {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
	readonly auth: "configured" | "missing" | "unknown";
	readonly thinkingLevels: readonly ModelThinkingLevel[] | null;
	readonly executionSupport: "supported" | "unavailable";
	readonly reason?: string;
}

export function describeSubagentModels(registry: ModelRegistry, provider?: string): SubagentModelInfo[] {
	return registry
		.getAll()
		.filter((model) => !provider || model.provider === provider)
		.map((model) => {
			// Native providers resolve their own auth, so an unconfigured one is not known to be missing.
			const auth = registry.hasConfiguredAuth(model)
				? "configured"
				: registry.getRegisteredNativeProvider(model.provider)
					? "unknown"
					: "missing";
			const identity = { provider: model.provider, id: model.id, name: model.name, auth } as const;
			if (model.api === VIRTUAL_MODEL_API) {
				return { ...identity, thinkingLevels: null, executionSupport: "unavailable", reason: VIRTUAL_MODEL_REASON };
			}
			return { ...identity, thinkingLevels: getSupportedThinkingLevels(model), executionSupport: "supported" };
		});
}

export async function resolveChildModelAndRuntime(options: ResolveChildModelOptions): Promise<ResolveChildModelResult> {
	const agentDir = options.agentDir ?? getAgentDir();

	if (options.requestedModel === "inherit" && !options.parentModel) {
		return {
			ok: false,
			error: "Cannot launch subagent: parent session has no active model selected.",
		};
	}

	if (options.requestedModel === "inherit" && options.parentModel?.api === VIRTUAL_MODEL_API) {
		return {
			ok: false,
			error: `Virtual model "${options.parentModel.provider}/${options.parentModel.id}" cannot be inherited by a subagent: ${VIRTUAL_MODEL_REASON}. Select a physical model before delegating.`,
		};
	}

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "models-store.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});

	for (const providerId of options.parentModelRegistry.getRegisteredProviderIds()) {
		const nativeProvider = options.parentModelRegistry.getRegisteredNativeProvider(providerId);
		if (nativeProvider) {
			modelRuntime.registerNativeProvider(nativeProvider);
			continue;
		}
		const providerConfig = options.parentModelRegistry.getRegisteredProviderConfig(providerId);
		if (providerConfig) {
			modelRuntime.registerProvider(providerId, providerConfig);
		}
	}
	await modelRuntime.refresh({ allowNetwork: false });
	await modelRuntime.getAvailable();

	let targetModel: Model<Api> | undefined;
	if (options.requestedModel === "inherit") {
		const parentModel = options.parentModel!;
		targetModel = modelRuntime.getModel(parentModel.provider, parentModel.id) ?? parentModel;
	} else {
		const slashIdx = options.requestedModel.indexOf("/");
		const providerId = options.requestedModel.slice(0, slashIdx);
		const modelId = options.requestedModel.slice(slashIdx + 1);
		targetModel = modelRuntime.getModel(providerId, modelId) ?? options.parentModelRegistry.find(providerId, modelId);
		if (!targetModel) {
			return {
				ok: false,
				error: `Subagent model "${options.requestedModel}" is not available in the model catalog.`,
			};
		}
	}

	if (targetModel.api === VIRTUAL_MODEL_API) {
		return {
			ok: false,
			error: `Virtual model "${targetModel.provider}/${targetModel.id}" cannot be used by a subagent: ${VIRTUAL_MODEL_REASON}. Choose a physical provider/model.`,
		};
	}

	const requestedLevel = options.requestedThinkingLevel;
	const supportedLevels = getSupportedThinkingLevels(targetModel);
	let thinkingLevel: ThinkingLevel | undefined;
	if (requestedLevel !== undefined) {
		if (!isSubagentThinkingLevel(requestedLevel) || !supportedLevels.includes(requestedLevel)) {
			return {
				ok: false,
				error: `Thinking level "${requestedLevel}" is not supported by subagent model "${targetModel.provider}/${targetModel.id}" (supported: ${supportedLevels.join(", ")}).`,
			};
		}
		thinkingLevel = requestedLevel;
	}

	if (!modelRuntime.hasConfiguredAuth(targetModel.provider)) {
		const parentApiKey = await options.parentModelRegistry.getApiKeyForProvider(targetModel.provider);
		if (parentApiKey) {
			await modelRuntime.setRuntimeApiKey(targetModel.provider, parentApiKey);
		}
	}

	const hasAuth =
		modelRuntime.hasConfiguredAuth(targetModel.provider) ||
		(await modelRuntime.checkAuth(targetModel.provider)) !== undefined ||
		options.parentModelRegistry.hasConfiguredAuth(targetModel);
	if (!hasAuth) {
		return {
			ok: false,
			error: `No authentication configured for subagent model provider "${targetModel.provider}".`,
		};
	}

	return {
		ok: true,
		modelRuntime,
		model: targetModel,
		thinkingLevel,
	};
}
