/**
 * Subagents core extension — the `task` tool (Claude Code parity, PLAN.md F3.1).
 *
 * Delegates work to specialized child agents (defined in `agents/*.md`) that run
 * IN-PROCESS with an isolated context window. Three modes:
 *   - single:   { agent, task }
 *   - parallel: { tasks: [{ agent, task }, ...] }  (≤8 tasks, ≤4 concurrent)
 *   - chain:    { chain: [{ agent, task }, ...] }   ({previous} → prior output)
 *
 * Migrated from the donor `examples/extensions/subagent/` (which spawned a
 * subprocess per task) to the in-process engine (see engine.ts). The tool is
 * named `task` (the donor called it `subagent`).
 */

import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../packages/coding-agent/src/config.ts";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
} from "../../../packages/coding-agent/src/core/extensions/types.ts";
import { type AgentDef, type AgentScope, bundledAgentsDir, discoverDefs, formatAgentList } from "./defs.ts";
import { runSubagent } from "./engine.ts";
import {
	capText,
	emptyUsage,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	renderCall,
	renderResult,
	type SingleResult,
	type SubagentDetails,
} from "./render.ts";

/** Substitute the `{previous}` placeholder with the prior chain stage's output. */
export function substitutePrevious(task: string, previous: string): string {
	return task.replace(/\{previous\}/g, previous);
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight, preserving order.
 * Lifted from the donor. Note: `fn` should not throw — callers wrap failures
 * into result objects so one bad task doesn't reject the whole batch.
 */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function unknownAgentResult(agentName: string, task: string, defs: AgentDef[], step?: number): SingleResult {
	const available = defs.map((d) => `"${d.name}"`).join(", ") || "none";
	return {
		agent: agentName,
		agentSource: "unknown",
		task,
		status: "failed",
		messages: [],
		stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
		usage: emptyUsage(),
		step,
	};
}

/** The project-source (repo-controlled) defs among the agents a call requests. */
function collectProjectDefs(
	defs: AgentDef[],
	params: {
		agent?: string;
		tasks?: Array<{ agent: string }>;
		chain?: Array<{ agent: string }>;
	},
): AgentDef[] {
	const requested = new Set<string>();
	if (params.chain) for (const s of params.chain) requested.add(s.agent);
	if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
	if (params.agent) requested.add(params.agent);
	return Array.from(requested)
		.map((name) => defs.find((d) => d.name === name))
		.filter((d): d is AgentDef => d?.source === "project");
}

/** Resolve a def by name and run it in-process, or return an unknown-agent failure. */
async function runOne(
	defs: AgentDef[],
	agentName: string,
	task: string,
	step: number | undefined,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	onUpdate: ((snap: SingleResult) => void) | undefined,
): Promise<SingleResult> {
	const def = defs.find((d) => d.name === agentName);
	if (!def) return unknownAgentResult(agentName, task, defs, step);
	return runSubagent({ def, task, ctx, signal, step, onUpdate });
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description: "Task with optional {previous} placeholder for prior output",
	}),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const TaskParams = Type.Object({
	agent: Type.Optional(
		Type.String({
			description: "Name of the agent to invoke (for single mode)",
		}),
	),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "Array of {agent, task} for sequential execution",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
});

export function factory(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "task",
		label: "Task",
		description: [
			"Delegate tasks to specialized subagents that run in-process with an isolated context window.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "user" (from ${join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		promptSnippet:
			"Use the task tool to delegate self-contained work to specialized subagents (modes: single, parallel, chain) — each runs in-process with its own isolated context",
		parameters: TaskParams,

		async execute(
			_toolCallId: string,
			params,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<SubagentDetails>> {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverDefs(ctx.cwd, agentScope);
			const defs = discovery.defs;

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";

			if (modeCount !== 1) {
				const available = defs.map((d) => `${d.name} (${d.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// Reject whitespace-only tasks (a string like "  " otherwise slips past the mode check).
			const hasEmptyTask =
				(hasSingle && !params.task?.trim()) ||
				(params.tasks?.some((t) => !t.task.trim()) ?? false) ||
				(params.chain?.some((s) => !s.task.trim()) ?? false);
			if (hasEmptyTask) {
				return {
					content: [{ type: "text", text: "Every task must be a non-empty string." }],
					details: makeDetails(mode)([]),
				};
			}

			// Trust gate for project-local (repo-controlled) agent defs. This is the
			// first-party project-trust primitive (same one permissions/hooks use), NOT a
			// model-settable param — the model must not be able to disable it. A def is
			// gated iff it was discovered from <cwd>/.bluclawd/agents (source "project").
			// User-scope and bundled-seed defs are trusted by origin and never gated.
			//   trusted            → run, no prompt (project was trusted at startup)
			//   untrusted + UI     → human confirm; declined → cancel
			//   untrusted + headless → fail CLOSED (block), mirroring permissions' headless deny
			const projectRequested = collectProjectDefs(defs, params);
			if (projectRequested.length > 0 && !ctx.isProjectTrusted()) {
				const names = projectRequested.map((d) => d.name).join(", ");
				const dir = discovery.projectAgentsDir ?? "(unknown)";
				if (!ctx.hasUI) {
					return {
						content: [
							{
								type: "text",
								text: `Blocked: project-local agents (${names}) from ${dir} require confirmation, but this session is running headless (no interactive UI). Blocked by default. Trust the project or run interactively to use project-local agents.`,
							},
						],
						details: makeDetails(mode)([]),
					};
				}
				const ok = await ctx.ui.confirm(
					"Run project-local agents?",
					`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
				);
				if (!ok)
					return {
						content: [
							{
								type: "text",
								text: "Canceled: project-local agents not approved.",
							},
						],
						details: makeDetails(mode)([]),
					};
			}

			// ── Chain mode ────────────────────────────────────────────────────
			if (params.chain && params.chain.length > 0) {
				if (params.chain.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many chain steps (${params.chain.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("chain")([]),
					};

				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const stepDef = params.chain[i];
					const taskWithContext = substitutePrevious(stepDef.task, previousOutput);

					const result = await runOne(
						defs,
						stepDef.agent,
						taskWithContext,
						i + 1,
						signal,
						ctx,
						onUpdate
							? (snap) =>
									onUpdate({
										content: [
											{
												type: "text",
												text: getFinalOutput(snap.messages) || "(running...)",
											},
										],
										details: makeDetails("chain")([...results, snap]),
									})
							: undefined,
					);
					results.push(result);

					if (isFailedResult(result)) {
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${stepDef.agent}): ${getResultOutput(result)}`,
								},
							],
							details: makeDetails("chain")(results),
						};
					}
					// Cap the prior output before substituting it into the next stage's
					// prompt, so a runaway child can't flood the parent context or compound
					// down the chain.
					previousOutput = capText(getFinalOutput(result.messages));
				}
				return {
					content: [
						{
							type: "text",
							text: capText(getFinalOutput(results[results.length - 1].messages)) || "(no output)",
						},
					],
					details: makeDetails("chain")(results),
				};
			}

			// ── Parallel mode ─────────────────────────────────────────────────
			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				const allResults: SingleResult[] = params.tasks.map((t) => ({
					agent: t.agent,
					agentSource: "unknown",
					task: t.task,
					status: "running",
					messages: [],
					stderr: "",
					usage: emptyUsage(),
				}));

				const emitParallelUpdate = () => {
					if (!onUpdate) return;
					const running = allResults.filter((r) => r.status === "running").length;
					const done = allResults.length - running;
					onUpdate({
						content: [
							{
								type: "text",
								text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
							},
						],
						details: makeDetails("parallel")([...allResults]),
					});
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					try {
						const result = await runOne(defs, t.agent, t.task, undefined, signal, ctx, (snap) => {
							allResults[index] = snap;
							emitParallelUpdate();
						});
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					} catch (err) {
						// A child crash must not sink the whole batch.
						const failed: SingleResult = {
							agent: t.agent,
							agentSource: "unknown",
							task: t.task,
							status: "failed",
							messages: [],
							stderr: err instanceof Error ? err.message : String(err),
							usage: emptyUsage(),
							stopReason: "error",
							errorMessage: err instanceof Error ? err.message : String(err),
						};
						allResults[index] = failed;
						emitParallelUpdate();
						return failed;
					}
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = capText(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			// ── Single mode ───────────────────────────────────────────────────
			if (params.agent && params.task) {
				const result = await runOne(
					defs,
					params.agent,
					params.task,
					undefined,
					signal,
					ctx,
					onUpdate
						? (snap) =>
								onUpdate({
									content: [
										{
											type: "text",
											text: getFinalOutput(snap.messages) || "(running...)",
										},
									],
									details: makeDetails("single")([snap]),
								})
						: undefined,
				);
				if (isFailedResult(result)) {
					return {
						content: [
							{
								type: "text",
								text: `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}`,
							},
						],
						details: makeDetails("single")([result]),
					};
				}
				return {
					content: [
						{
							type: "text",
							text: capText(getFinalOutput(result.messages)) || "(no output)",
						},
					],
					details: makeDetails("single")([result]),
				};
			}

			const available = defs.map((d) => `${d.name} (${d.source})`).join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text: `Invalid parameters. Available agents: ${available}`,
					},
				],
				details: makeDetails("single")([]),
			};
		},

		renderCall,
		renderResult,
	});
	pi.registerCommand("agents", {
		description: "List the subagents the task tool can delegate to",
		handler: async (_args, ctx) => {
			// Project defs are read only for a trusted project — an untrusted repo's
			// agent descriptions should not be surfaced, the same rule /hooks uses.
			const trusted = ctx.isProjectTrusted();
			const { defs, projectAgentsDir } = discoverDefs(ctx.cwd, trusted ? "both" : "user");
			const lines = formatAgentList(defs, bundledAgentsDir());
			if (lines.length === 0) {
				ctx.ui.notify(
					`No agents found. Add markdown defs to <agentDir>/agents or ${CONFIG_DIR_NAME}/agents.`,
					"info",
				);
				return;
			}
			const footer = !trusted
				? `Project agents are not listed — this project is untrusted. The task tool still offers them behind a confirmation prompt, and blocks them outright when headless.`
				: projectAgentsDir
					? `Project agents from ${projectAgentsDir} need agentScope: "both" (or "project") on the task call.`
					: `No ${CONFIG_DIR_NAME}/agents directory here; only user and bundled agents are available.`;
			ctx.ui.notify(["Agents:", "", ...lines, "", footer].join("\n"), "info");
		},
	});
}

const subagentsExtension: InlineExtension = { name: "subagents", factory };
export default subagentsExtension;
