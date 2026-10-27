import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionFactory,
	getAgentDir,
	loadProjectContextFiles,
	type ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
	type ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	createChildPolicyExtension,
	isValidSubagentPolicySnapshot,
	type SubagentReadPolicySnapshot,
} from "../permissions/policy.ts";
import {
	type AgentDefinition,
	type AllowedSubagentTool,
	isSubagentThinkingLevel,
	type SubagentModelSpec,
} from "./definitions.ts";
import {
	addSubagentUsage,
	createEmptySubagentUsage,
	type SubagentRunnerExecuteParams,
	type SubagentRunnerOutcome,
	type WorkspaceSnapshot,
} from "./runs.ts";

export const MAX_CHILD_TOOL_OUTPUT_BYTES = 32 * 1024;
const VIRTUAL_MODEL_API = "pi-virtual";
const VIRTUAL_MODEL_REASON =
	"virtual model routers are not inspectable via public ModelRegistry APIs, so a child cannot preserve their routing";

const FORBIDDEN_TOOL_PATTERNS = [
	"bash",
	"edit",
	"write",
	"powershell",
	"monitor",
	"subagent",
	"codemode",
	"tool_search",
	"mcp__*",
];

export interface ResolveChildModelOptions {
	agentDir?: string;
	requestedModel: SubagentModelSpec;
	parentModel: Model<Api> | undefined;
	requestedThinkingLevel: ThinkingLevel | string | undefined;
	parentModelRegistry: ModelRegistry;
}

export interface ResolveChildModelResult {
	readonly ok: boolean;
	readonly modelRuntime?: ModelRuntime;
	readonly model?: Model<Api>;
	readonly thinkingLevel?: ThinkingLevel;
	readonly error?: string;
}

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

export interface RunRestrictedSubagentOptions extends SubagentRunnerExecuteParams {
	agentDir?: string;
	definition: AgentDefinition;
	task: string;
	policySnapshot: SubagentReadPolicySnapshot;
	requestedModel: SubagentModelSpec;
	parentModel: Model<Api> | undefined;
	requestedThinkingLevel: ThinkingLevel | string | undefined;
	parentModelRegistry: ModelRegistry;
	projectTrusted: boolean;
	childSessionDir?: string;
	/** Extra runtime-bound tools for the child, such as its message tool. */
	childTools?: readonly ToolDefinition[];
	onChildSessionCreated?: (session: AgentSession) => void;
}

export function sanitizeDiagnosticText(input: string): string {
	return input
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
		.replace(/\b(sk-[A-Za-z0-9_-]{6,})\b/g, "[REDACTED_KEY]")
		.replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"',;)]+/gi, "$1=[REDACTED]");
}

export function captureWorkspaceSnapshot(cwd: string): WorkspaceSnapshot {
	try {
		const headRes = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
			cwd,
			encoding: "utf8",
			timeout: 2000,
		});
		const headCommit = headRes.status === 0 ? headRes.stdout.trim() || null : null;

		const statusRes = spawnSync("git", ["status", "--porcelain=v1", "-uall"], {
			cwd,
			encoding: "utf8",
			timeout: 2000,
		});
		if (statusRes.status !== 0) {
			return { headCommit, dirty: false, statusDigest: "" };
		}
		const rawStatus = statusRes.stdout ?? "";
		const dirty = rawStatus.trim().length > 0;
		const statusDigest = dirty ? createHash("sha256").update(rawStatus).digest("hex").slice(0, 16) : "";
		return { headCommit, dirty, statusDigest };
	} catch {
		return { headCommit: null, dirty: false, statusDigest: "" };
	}
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

	const thinkingLevel = options.requestedThinkingLevel;
	const supportedLevels = getSupportedThinkingLevels(targetModel);
	if (!isSubagentThinkingLevel(thinkingLevel) || !supportedLevels.includes(thinkingLevel)) {
		return {
			ok: false,
			error: `Thinking level "${thinkingLevel}" is not supported by subagent model "${targetModel.provider}/${targetModel.id}" (supported: ${supportedLevels.join(", ")}).`,
		};
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

function buildApprovedReadTools(cwd: string, allowedTools: readonly AllowedSubagentTool[]): ToolDefinition[] {
	const factories: Record<AllowedSubagentTool, () => ToolDefinition> = {
		read: () => createReadToolDefinition(cwd),
		grep: () => createGrepToolDefinition(cwd),
		find: () => createFindToolDefinition(cwd),
		ls: () => createLsToolDefinition(cwd),
	};
	return allowedTools.map((name) => factories[name]());
}

function capChildToolOutputText(text: string): string | undefined {
	if (Buffer.byteLength(text, "utf8") <= MAX_CHILD_TOOL_OUTPUT_BYTES) {
		return undefined;
	}
	const buf = Buffer.from(text, "utf8").subarray(0, MAX_CHILD_TOOL_OUTPUT_BYTES);
	const sliced = buf.toString("utf8");
	const lastNewline = sliced.lastIndexOf("\n");
	const cleanHead = lastNewline > MAX_CHILD_TOOL_OUTPUT_BYTES / 2 ? sliced.slice(0, lastNewline) : sliced;
	return `${cleanHead}\n\n[Child tool output capped at 32 KiB; narrow your path, pattern, or offset/limit]`;
}

function extractAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const chunks: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const text = (block as { text?: string }).text;
			if (typeof text === "string" && text.trim().length > 0) {
				chunks.push(text.trim());
			}
		}
	}
	return chunks.join("\n\n");
}

export async function runRestrictedSubagent(options: RunRestrictedSubagentOptions): Promise<SubagentRunnerOutcome> {
	if (!isValidSubagentPolicySnapshot(options.policySnapshot)) {
		return {
			status: "failed",
			complete: false,
			summaryText: "",
			errorMessage: "Refusing to launch subagent: policy snapshot is missing or malformed.",
			endSnapshot: captureWorkspaceSnapshot(options.record.cwd),
		};
	}

	const resolvedModel = await resolveChildModelAndRuntime({
		agentDir: options.agentDir,
		requestedModel: options.requestedModel,
		parentModel: options.parentModel,
		requestedThinkingLevel: options.requestedThinkingLevel,
		parentModelRegistry: options.parentModelRegistry,
	});
	if (!resolvedModel.ok || !resolvedModel.modelRuntime || !resolvedModel.model) {
		return {
			status: "failed",
			complete: false,
			summaryText: "",
			errorMessage: sanitizeDiagnosticText(resolvedModel.error ?? "Failed to resolve child model."),
			endSnapshot: captureWorkspaceSnapshot(options.record.cwd),
		};
	}

	const cwd = options.record.cwd;
	const agentDir = options.agentDir ?? getAgentDir();
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		cacheWarming: "off",
		retry: { enabled: false },
	});

	const lifecycleExtension: ExtensionFactory = (pi: ExtensionAPI) => {
		pi.on("tool_call", async () => {
			options.controller.recordToolCall();
			if (options.signal.aborted) {
				return {
					block: true,
					reason: "Subagent run was stopped.",
					terminate: true,
				};
			}
			return undefined;
		});

		pi.on("tool_result", async (event): Promise<ToolResultEventResult | undefined> => {
			if (event.isError) return undefined;

			let capped = false;
			const nextContent = event.content.map((part) => {
				if (part.type !== "text" || typeof part.text !== "string") return part;
				const truncated = capChildToolOutputText(part.text);
				if (truncated === undefined) return part;
				capped = true;
				return { ...part, text: truncated };
			});
			if (!capped) return undefined;
			return {
				content: nextContent,
				structuredContent: undefined,
			};
		});
	};

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [createChildPolicyExtension(options.policySnapshot), lifecycleExtension],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: !options.projectTrusted,
		agentsFilesOverride: options.projectTrusted
			? undefined
			: () => ({
					agentsFiles: loadProjectContextFiles({ cwd: agentDir, agentDir }).filter(
						(file) => dirname(resolve(file.path)) === resolve(agentDir),
					),
				}),
		disabledBuiltinExtensions: ["mcp", "codemode", "tool_search"],
		appendSystemPrompt: [options.definition.instructions],
	});
	await resourceLoader.reload();

	const sessionManager = options.childSessionDir
		? SessionManager.create(cwd, options.childSessionDir)
		: SessionManager.inMemory(cwd);

	const approvedTools = buildApprovedReadTools(cwd, options.policySnapshot.allowedTools);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: resolvedModel.modelRuntime,
		model: resolvedModel.model,
		thinkingLevel: resolvedModel.thinkingLevel,
		noTools: "builtin",
		tools: [...options.policySnapshot.allowedTools, ...(options.childTools ?? []).map((tool) => tool.name)],
		excludeTools: FORBIDDEN_TOOL_PATTERNS,
		customTools: [...approvedTools, ...(options.childTools ?? [])],
		resourceLoader,
		sessionManager,
		settingsManager,
	});

	options.onChildSessionCreated?.(session);

	const usageTotals = createEmptySubagentUsage();
	const collectedAssistantTexts: string[] = [];
	let finalAssistantStopReason: string | undefined;
	let finalAssistantErrorMessage: string | undefined;
	let resolveSettled!: () => void;
	const settledPromise = new Promise<void>((res) => {
		resolveSettled = res;
	});

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "turn_start") {
			options.controller.recordTurn();
			if (options.signal.aborted) {
				queueMicrotask(() => {
					void session.abort();
				});
			}
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const assistantMsg = event.message as {
				stopReason?: string;
				errorMessage?: string;
				usage?: {
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
					totalTokens?: number;
					cost?: {
						input?: number;
						output?: number;
						cacheRead?: number;
						cacheWrite?: number;
						total?: number;
					};
				};
			};
			finalAssistantStopReason = assistantMsg.stopReason;
			if (assistantMsg.errorMessage) {
				finalAssistantErrorMessage = sanitizeDiagnosticText(assistantMsg.errorMessage);
			}
			const text = extractAssistantText(event.message);
			if (text) {
				collectedAssistantTexts.push(text);
				options.controller.updateProgress(text.slice(0, 240));
			}
			if (assistantMsg.usage) {
				const delta = {
					input: assistantMsg.usage.input ?? 0,
					output: assistantMsg.usage.output ?? 0,
					cacheRead: assistantMsg.usage.cacheRead ?? 0,
					cacheWrite: assistantMsg.usage.cacheWrite ?? 0,
					totalTokens:
						assistantMsg.usage.totalTokens ??
						(assistantMsg.usage.input ?? 0) +
							(assistantMsg.usage.output ?? 0) +
							(assistantMsg.usage.cacheRead ?? 0) +
							(assistantMsg.usage.cacheWrite ?? 0),
					cost: {
						input: assistantMsg.usage.cost?.input ?? 0,
						output: assistantMsg.usage.cost?.output ?? 0,
						cacheRead: assistantMsg.usage.cost?.cacheRead ?? 0,
						cacheWrite: assistantMsg.usage.cost?.cacheWrite ?? 0,
						total: assistantMsg.usage.cost?.total ?? 0,
					},
					hasUnknownCost: assistantMsg.usage.cost?.total === undefined,
				};
				addSubagentUsage(usageTotals, delta);
				options.controller.recordUsage(delta);
			}
			if (options.signal.aborted) {
				queueMicrotask(() => {
					void session.abort();
				});
			}
			return;
		}
		if (event.type === "agent_settled") {
			resolveSettled();
		}
	});

	const onSignalAbort = () => {
		queueMicrotask(() => {
			void session.abort();
		});
	};
	options.signal.addEventListener("abort", onSignalAbort, { once: true });

	try {
		await session.bindExtensions({});
		options.controller.markRunning(session.sessionId);

		if (options.signal.aborted) {
			return {
				status: "cancelled",
				complete: false,
				summaryText: collectedAssistantTexts.join("\n\n"),
				childSessionId: session.sessionId,
				transcriptPath: session.sessionFile,
				endSnapshot: captureWorkspaceSnapshot(cwd),
				usage: usageTotals,
			};
		}

		await session.prompt(options.task, {
			expandPromptTemplates: false,
			source: "extension",
		});
		await settledPromise;

		const latestText =
			session.getLastAssistantText() ??
			(collectedAssistantTexts.length > 0 ? collectedAssistantTexts.join("\n\n") : "");

		if (options.signal.aborted || finalAssistantStopReason === "aborted") {
			return {
				status: "cancelled",
				complete: false,
				summaryText: collectedAssistantTexts.length > 0 ? collectedAssistantTexts.join("\n\n") : latestText,
				stopReason: "aborted",
				childSessionId: session.sessionId,
				transcriptPath: session.sessionFile,
				endSnapshot: captureWorkspaceSnapshot(cwd),
				usage: usageTotals,
			};
		}

		if (finalAssistantStopReason === "error") {
			return {
				status: "failed",
				complete: false,
				summaryText: collectedAssistantTexts.length > 0 ? collectedAssistantTexts.join("\n\n") : latestText,
				stopReason: "error",
				errorMessage: finalAssistantErrorMessage ?? "Subagent model request failed.",
				childSessionId: session.sessionId,
				transcriptPath: session.sessionFile,
				endSnapshot: captureWorkspaceSnapshot(cwd),
				usage: usageTotals,
			};
		}

		if (finalAssistantStopReason === "length") {
			return {
				status: "completed",
				complete: false,
				summaryText: latestText,
				stopReason: "length",
				errorMessage: "Subagent response was truncated at the model output token limit.",
				childSessionId: session.sessionId,
				transcriptPath: session.sessionFile,
				endSnapshot: captureWorkspaceSnapshot(cwd),
				usage: usageTotals,
			};
		}

		if (!latestText.trim()) {
			return {
				status: "failed",
				complete: false,
				summaryText: "",
				stopReason: finalAssistantStopReason ?? "empty_output",
				errorMessage: "Subagent finished without producing a report.",
				childSessionId: session.sessionId,
				transcriptPath: session.sessionFile,
				endSnapshot: captureWorkspaceSnapshot(cwd),
				usage: usageTotals,
			};
		}

		return {
			status: "completed",
			complete: true,
			summaryText: latestText,
			stopReason: finalAssistantStopReason ?? "stop",
			childSessionId: session.sessionId,
			transcriptPath: session.sessionFile,
			endSnapshot: captureWorkspaceSnapshot(cwd),
			usage: usageTotals,
		};
	} catch (err) {
		const sanitizedErr = sanitizeDiagnosticText(err instanceof Error ? err.message : String(err));
		return {
			status: options.signal.aborted ? "cancelled" : "failed",
			complete: false,
			summaryText: collectedAssistantTexts.join("\n\n"),
			errorMessage: sanitizedErr,
			childSessionId: session.sessionId,
			transcriptPath: session.sessionFile,
			endSnapshot: captureWorkspaceSnapshot(cwd),
			usage: usageTotals,
		};
	} finally {
		options.signal.removeEventListener("abort", onSignalAbort);
		try {
			await session.waitForIdle();
		} catch {
			// Ignore drain errors during cleanup
		}
		unsubscribe();
		session.dispose();
		if (process.platform !== "win32" && session.sessionFile && existsSync(session.sessionFile)) {
			chmodSync(session.sessionFile, 0o600);
		}
	}
}
