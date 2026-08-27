/**
 * In-process subagent engine (PLAN.md F3.1).
 *
 * Runs a child agent session entirely in-process (no subprocess) via
 * `createAgentSession` + `SessionManager.inMemory()`. Replaces the donor's
 * subprocess-spawn `runSingleAgent`.
 *
 * Isolation & safety:
 *   - Trap 1 (recursion): the child's tool allowlist is stripped of the `task`
 *     tool, so a child can never spawn further subagents.
 *   - Trap 2 (minimality/leaks): the child gets a bare `DefaultResourceLoader`
 *     that carries ONLY the def body (appendSystemPrompt) — no parent
 *     extensions, skills, prompts, themes, or context files. A separate Agent +
 *     in-memory SessionManager means the child cannot mutate the parent.
 *     SECURITY CONSEQUENCE: no permissions extension loads in children, so a
 *     child's bash/edit/write run UNGATED in ctx.cwd. Only expose such tools to
 *     trusted (user/bundled) defs; project defs must pass the index.ts trust
 *     gate (ctx.isProjectTrusted / human confirm) before ever reaching here.
 *   - Trap 3 (disposal/abort): every child unsubscribes its listener and calls
 *     `session.dispose()` in a `finally`; the parent abort signal is forwarded
 *     to `session.abort()` and detached afterwards.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import type { AgentSessionEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getAuthPath, getModelsPath } from "../../../packages/coding-agent/src/config.ts";
import { createAgentSession } from "../../../packages/coding-agent/src/core/sdk.ts";
import subagentPermissionGate from "../permissions/subagent-gate.ts";
import type { AgentDef } from "./defs.ts";
import { emptyUsage, type SingleResult } from "./render.ts";

/**
 * The ModelRuntime every subagent child is built with.
 *
 * `createAgentSession` needs a runtime, and pi's public `ModelRegistry` facade
 * does not expose the one the parent session uses. The fork reached in by adding
 * a getter to pi's class; this layer instead creates its own once and caches it,
 * so parallel children still share a single reader of auth.json / models.json
 * rather than re-reading both per child.
 *
 * Cached for the process, like the parent's own runtime: credentials are re-read
 * by the runtime itself when they change.
 */
let runtimePromise: Promise<ModelRuntime> | undefined;
function sharedModelRuntime(): Promise<ModelRuntime> {
	runtimePromise ??= ModelRuntime.create({
		authPath: getAuthPath(),
		modelsPath: getModelsPath(),
	});
	return runtimePromise;
}

/** Name of the delegation tool. Stripped from every child allowlist (Trap 1). */
export const TASK_TOOL_NAME = "task";

/**
 * Remove the `task` tool from a child's allowlist so children can't recurse.
 * `undefined` (inherit defaults) stays `undefined`; the default built-ins never
 * include `task`, so inheriting is already safe.
 */
export function stripTaskTool(tools: string[] | undefined): string[] | undefined {
	if (!tools) return undefined;
	return tools.filter((t) => t !== TASK_TOOL_NAME);
}

/** Resolve `def.model` ("provider/id") against the parent registry; else inherit parent model. */
function resolveModel(def: AgentDef, ctx: ExtensionContext): Model<any> | undefined {
	if (def.model) {
		const slash = def.model.indexOf("/");
		if (slash > 0 && slash < def.model.length - 1) {
			const found = ctx.modelRegistry.find(def.model.slice(0, slash), def.model.slice(slash + 1));
			if (found) return found;
		}
	}
	return ctx.model;
}

interface AssistantLike {
	stopReason?: string;
	errorMessage?: string;
	model?: string;
}

function lastAssistant(messages: readonly { role: string }[]): AssistantLike | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") return messages[i] as unknown as AssistantLike;
	}
	return undefined;
}

export interface RunSubagentOptions {
	def: AgentDef;
	task: string;
	ctx: ExtensionContext;
	signal?: AbortSignal;
	/** 1-based step index for chain mode (drives render labels). */
	step?: number;
	/** Streaming callback fired on each child message_end with a fresh snapshot. */
	onUpdate?: (result: SingleResult) => void;
}

/**
 * Build the child session's settings + resource loader. Exported for tests.
 *
 * Project-scoped config applies ONLY when the project is trusted: children run
 * with a minimal loader (no discovered extensions — Trap 2), so an untrusted
 * repo's .bluclawd/SYSTEM.md (which would REPLACE the child's base system
 * prompt) or settings.json must never steer them. The one inline extension a
 * child DOES load is the deny-only permission gate (audit B.5): deny rules and
 * protected paths from the parent's settings apply inside children too, so
 * delegation cannot be used to circumvent them.
 */
export function createChildLoader(
	ctx: ExtensionContext,
	def: AgentDef,
): { settingsManager: SettingsManager; childLoader: DefaultResourceLoader } {
	const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir(), {
		projectTrusted: ctx.isProjectTrusted(),
	});
	const childLoader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		settingsManager,
		appendSystemPrompt: def.systemPrompt.trim() ? [def.systemPrompt] : [],
		extensionFactories: [subagentPermissionGate],
		// Trap 2: keep the child minimal — no inherited extensions/resources.
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	return { settingsManager, childLoader };
}

/**
 * Run one child agent to completion and return its result.
 * Never throws: failures (including abort) are reported via the returned
 * SingleResult (status !== "ok" and/or stopReason).
 */
export async function runSubagent(opts: RunSubagentOptions): Promise<SingleResult> {
	const { def, task, ctx, signal, step, onUpdate } = opts;

	const base: SingleResult = {
		agent: def.name,
		agentSource: def.source,
		task,
		status: "running",
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: undefined,
		step,
	};

	// Fail closed if the parent already aborted.
	if (signal?.aborted) {
		return {
			...base,
			status: "failed",
			stopReason: "aborted",
			errorMessage: "Subagent was aborted before starting.",
		};
	}

	// Construction is guarded too: a throw here (settings/loader/session) would
	// otherwise escape the try/finally below and violate the "never throws"
	// contract — chain/single callers don't catch (2026-07-10 review).
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
	try {
		const { settingsManager, childLoader } = createChildLoader(ctx, def);
		await childLoader.reload();

		// Resolve once and report THIS model, not the raw def.model: on a
		// malformed/unknown def.model, resolution silently inherits the parent
		// model, and the result must name the model that actually ran.
		const resolvedModel = resolveModel(def, ctx);
		base.model = resolvedModel ? `${resolvedModel.provider}/${resolvedModel.id}` : undefined;

		({ session } = await createAgentSession({
			cwd: ctx.cwd,
			model: resolvedModel,
			tools: stripTaskTool(def.tools), // Trap 1
			modelRuntime: await sharedModelRuntime(),
			sessionManager: SessionManager.inMemory(ctx.cwd),
			settingsManager,
			resourceLoader: childLoader,
		}));
	} catch (err) {
		return {
			...base,
			status: "failed",
			stopReason: "error",
			errorMessage: err instanceof Error ? err.message : String(err),
		};
	}

	const snapshot = (): SingleResult => {
		const stats = session.getSessionStats();
		const last = lastAssistant(session.state.messages);
		return {
			...base,
			messages: [...session.state.messages],
			usage: {
				input: stats.tokens.input,
				output: stats.tokens.output,
				cacheRead: stats.tokens.cacheRead,
				cacheWrite: stats.tokens.cacheWrite,
				cost: stats.cost,
				contextTokens: 0,
				turns: stats.assistantMessages,
			},
			model: base.model ?? last?.model,
		};
	};

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (onUpdate && event.type === "message_end") onUpdate(snapshot());
	});

	const onAbort = () => {
		// Fire-and-forget: not awaited on purpose. The finally block's
		// session.dispose() (which idempotently calls agent.abort()) covers cleanup;
		// awaiting here would only add latency to the abort path.
		void session.abort();
	};
	if (signal) signal.addEventListener("abort", onAbort, { once: true });

	try {
		// Re-check after attaching the listener: an abort fired during the loader
		// reload / session creation awaits above landed BEFORE the listener existed
		// and would otherwise be lost — the child would run its entire task (Trap 3).
		if (signal?.aborted) {
			return {
				...base,
				status: "failed",
				stopReason: "aborted",
				errorMessage: "Subagent was aborted before starting.",
			};
		}
		await session.prompt(`Task: ${task}`);
		const final = snapshot();
		const last = lastAssistant(session.state.messages);
		if (signal?.aborted) {
			final.status = "failed";
			final.stopReason = "aborted";
			final.errorMessage = final.errorMessage ?? "Subagent was aborted.";
		} else if (last?.stopReason === "error") {
			final.status = "failed";
			final.stopReason = "error";
			final.errorMessage = last.errorMessage ?? "Subagent ended with an error.";
		} else {
			final.status = "ok";
			final.stopReason = last?.stopReason;
		}
		return final;
	} catch (err) {
		const final = snapshot();
		final.status = "failed";
		final.stopReason = signal?.aborted ? "aborted" : "error";
		final.errorMessage = err instanceof Error ? err.message : String(err);
		return final;
	} finally {
		if (signal) signal.removeEventListener("abort", onAbort);
		unsubscribe();
		session.dispose();
	}
}
