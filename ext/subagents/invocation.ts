import { isDeepStrictEqual } from "node:util";
import { type Static, Type } from "typebox";
import { SUBAGENT_THINKING_LEVELS } from "./definitions.ts";

/** One Run's parameters: those of a single assignment, which a `tasks` entry shares in part. */
const RUN_PARAMETERS = Type.Object({
	agent: Type.Union([
		Type.String({
			description: "Saved subagent role name (for example 'explorer' or 'reviewer').",
		}),
		Type.Object(
			{
				name: Type.String({ description: "Run-local role name; never saved." }),
				description: Type.String({ description: "One-line purpose of this role." }),
				instructions: Type.String({ description: "System instructions for the child." }),
				tools: Type.Optional(Type.Array(Type.String())),
				model: Type.Optional(Type.String({ description: '"inherit" or "provider/model".' })),
				thinkingLevel: Type.Optional(Type.String({ description: "Default thinking level for this role." })),
			},
			{ additionalProperties: false, description: "Inline role used only for this run." },
		),
	]),
	name: Type.Optional(
		Type.String({
			description:
				'Unique name for this child among running agents, used to address it (lowercase letters, digits, "-", "_"). Defaults to "<role>-<n>".',
		}),
	),
	task: Type.String({
		description: "Self-contained task instructions with explicit file paths, symbols, or diff context (max 32 KiB).",
	}),
	cwd: Type.Optional(
		Type.String({
			description:
				"Directory the run works in: absolute, or relative to yours. Defaults to yours. Its project roles are found from there up to its repository root.",
		}),
	),
	agentScope: Type.Optional(
		Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
			description:
				'Which saved roles `agent` may name: "user" (yours and the bundled ones), "project" (the project\'s), or "both" (the default). Project roles need the user\'s trust in their project either way.',
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				'Model for this run: "provider/model" from subagent_models, or "inherit" for the parent model. Overrides the role.',
		}),
	),
	thinkingLevel: Type.Optional(
		Type.String({
			description: `Thinking level for this run (${SUBAGENT_THINKING_LEVELS.join(", ")}), or "inherit" for the parent level. Overrides the role.`,
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"When true, launch in the background and deliver the completed report back to this session branch. Only when you have independent work to do meanwhile.",
		}),
	),
});

/** What each entry of a `tasks` batch chooses for itself; the call's other parameters apply to every entry. */
const TASK_ENTRY_KEYS = ["agent", "task", "name", "cwd", "model", "thinkingLevel"] as const;
const run = RUN_PARAMETERS.properties;

export const SUBAGENT_TOOL_PARAMETERS = Type.Object({
	...run,
	agent: Type.Optional(run.agent),
	task: Type.Optional(run.task),
	tasks: Type.Optional(
		Type.Array(
			Type.Object(
				{
					agent: run.agent,
					task: run.task,
					name: run.name,
					cwd: run.cwd,
					model: run.model,
					thinkingLevel: run.thinkingLevel,
				},
				{ additionalProperties: false },
			),
			{
				minItems: 1,
				description:
					"Independent assignments to run side by side, in place of agent and task: each entry is a subagent of its own, with its own role, task, name, cwd, model and thinking level. The call waits for every one (unless background) and returns one combined report.",
			},
		),
	),
	chain: Type.Optional(
		Type.Array(
			Type.Object(
				{
					agent: Type.Optional(run.agent),
					resume: Type.Optional(
						Type.String({
							description:
								"In place of agent, name and cwd: the name of an earlier step of this chain, which goes on in its own session, with its context, role and workspace.",
						}),
					),
					task: run.task,
					name: run.name,
					cwd: run.cwd,
					model: run.model,
					thinkingLevel: run.thinkingLevel,
				},
				{ additionalProperties: false },
			),
			{
				minItems: 1,
				description:
					"Dependent steps to run one after another, in place of agent and task: each starts once the one before it completed, given that step's Report. When a step edits, every step works in one isolated worktree, one at a time. A failed, cancelled or blocked step halts the chain; a review that finds defects has completed. The call waits for the whole chain (unless background) and returns one combined report.",
			},
		),
	),
});

/** One Run's parameters: a single assignment's, or a `tasks` entry's with the call's own. */
export type LaunchParams = Static<typeof RUN_PARAMETERS>;
export type SubagentCallParams = Static<typeof SUBAGENT_TOOL_PARAMETERS>;

/**
 * A step of a `chain`: a Run of its own, or the Resume of an earlier step's Run, by that step's index, with its next
 * instruction and any change of model or level.
 */
export type ChainStep =
	| { readonly run: LaunchParams }
	| { readonly resume: number; readonly task: string; readonly model?: string; readonly thinkingLevel?: string };

/**
 * What a subagent call asks for: one Run, a batch of independent ones, or a chain of dependent steps. Alternative
 * shapes are never combined.
 */
export type SubagentInvocation =
	| { readonly ok: true; readonly run: LaunchParams }
	| { readonly ok: true; readonly tasks: LaunchParams[] }
	| { readonly ok: true; readonly chain: ChainStep[] }
	| { readonly ok: false; readonly error: string };

export function subagentInvocation(params: SubagentCallParams): SubagentInvocation {
	const { tasks, chain, ...call } = params;
	if (tasks !== undefined && chain !== undefined) {
		return {
			ok: false,
			error: "`tasks` and `chain` are alternative shapes: give independent assignments as `tasks`, dependent steps as `chain`.",
		};
	}
	const shape = tasks !== undefined ? "tasks" : chain !== undefined ? "chain" : undefined;
	if (shape === undefined) {
		if (call.agent === undefined) return { ok: false, error: "Missing required parameter: agent" };
		if (call.task === undefined) return { ok: false, error: "Missing required parameter: task" };
		return { ok: true, run: { ...call, agent: call.agent, task: call.task } };
	}
	const conflicting = TASK_ENTRY_KEYS.filter((key) => call[key] !== undefined).map((key) => `\`${key}\``);
	if (conflicting.length > 0) {
		return {
			ok: false,
			error: `\`${shape}\` and ${conflicting.join(", ")} are alternative shapes: set ${conflicting.join(", ")} in each entry of \`${shape}\` instead, or leave \`${shape}\` out.`,
		};
	}
	const { agentScope, background } = call;
	if (tasks !== undefined) {
		return { ok: true, tasks: tasks.map((entry) => ({ ...entry, agentScope, background })) };
	}
	const steps: ChainStep[] = [];
	for (const [i, { resume, ...step }] of (chain ?? []).entries()) {
		if (resume === undefined) {
			if (step.agent === undefined) {
				return { ok: false, error: `chain[${i}]: give a step either \`agent\` or \`resume\`.` };
			}
			steps.push({ run: { ...step, agent: step.agent, agentScope, background } });
			continue;
		}
		const target = (chain ?? []).findIndex(
			(earlier, j) => j < i && earlier.resume === undefined && earlier.name?.trim() === resume.trim(),
		);
		if (target < 0) {
			return {
				ok: false,
				error: `chain[${i}]: \`resume\` names an earlier step of this chain by the name it was given, and no earlier step is named "${resume}".`,
			};
		}
		// Repeating the resumed step's role, name or cwd is harmless and ignored; only a different one is refused.
		const resumed = (chain ?? [])[target];
		const differing = (["agent", "name", "cwd"] as const).filter((key) =>
			key === "name"
				? step.name !== undefined && step.name.trim() !== resumed.name?.trim()
				: step[key] !== undefined && !isDeepStrictEqual(step[key], resumed[key]),
		);
		if (differing.length > 0) {
			const fields = differing.map((key) => `\`${key}\``).join(", ");
			return {
				ok: false,
				error: `chain[${i}]: a step that resumes an earlier one goes on with its role, name and cwd, and its ${fields} ${differing.length > 1 ? "differ" : "differs"} from chain[${target}]'s ("${resume}"): leave out ${fields}.`,
			};
		}
		const { task, model, thinkingLevel } = step;
		steps.push({ resume: target, task, ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) });
	}
	return { ok: true, chain: steps };
}
