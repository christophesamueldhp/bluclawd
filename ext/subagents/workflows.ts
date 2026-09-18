/**
 * Saved workflows: a named chain of subagent steps, a step being one agent or a
 * group running in parallel (pi-subagents' `runs.run` / `runs.all`).
 *
 * Declarative on purpose. pi-subagents runs workflow *scripts* in a JS sandbox;
 * node's `vm` is not a security boundary, and a script escaping it would run with
 * the extension's full authority — past every permission rule a child obeys. A
 * chain of parallel groups covers the orchestration the scripts are used for
 * (fan out, merge, hand on), and every step is an ordinary `task` child.
 *
 * Files are markdown with YAML frontmatter — `name`, `description`, `chain` —
 * found like agent defs: bundled < `<agentDir>/workflows` < `<project>/<config
 * dir>/workflows` (a project's only when it is trusted). `{input}` in a task is the
 * call's `input`; `{previous}` is the prior step's output, as in any chain.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface StepTask {
	agent: string;
	task: string;
	gate?: string;
}

/** One chain step: a single agent, or a parallel group. */
export interface ChainStep {
	agent?: string;
	task?: string;
	gate?: string;
	parallel?: StepTask[];
}

export interface Workflow {
	name: string;
	description: string;
	chain: ChainStep[];
	origin: "bundled" | "user" | "project";
	filePath: string;
}

export function bundledWorkflowsDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), "workflows");
}

/** The tasks a step runs: its parallel group when it has a non-empty one, else itself. */
export function stepTasks(step: ChainStep): StepTask[] {
	if (step.parallel && step.parallel.length > 0) return step.parallel;
	return [{ agent: step.agent ?? "", task: step.task ?? "", gate: step.gate }];
}

const isTask = (v: unknown): v is StepTask =>
	!!v &&
	typeof (v as StepTask).agent === "string" &&
	typeof (v as StepTask).task === "string" &&
	((v as StepTask).gate === undefined || typeof (v as StepTask).gate === "string");

function parseStep(raw: unknown): ChainStep | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const { parallel } = raw as { parallel?: unknown };
	if (Array.isArray(parallel)) return parallel.length > 0 && parallel.every(isTask) ? { parallel } : undefined;
	return isTask(raw) ? { agent: raw.agent, task: raw.task, gate: raw.gate } : undefined;
}

/** A workflow file's parts, or why it will not load. */
export function parseWorkflow(content: string): Omit<Workflow, "origin" | "filePath"> | { problem: string } {
	let frontmatter: Record<string, unknown>;
	try {
		frontmatter = parseFrontmatter<Record<string, unknown>>(content).frontmatter;
	} catch (error) {
		return { problem: `invalid YAML (${error instanceof Error ? error.message : String(error)})` };
	}
	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!name || !description) return { problem: "name and description are required" };
	if (!Array.isArray(frontmatter.chain) || frontmatter.chain.length === 0) return { problem: "chain is empty" };
	const chain = frontmatter.chain.map(parseStep);
	if (chain.some((s) => !s))
		return { problem: "every step needs agent and task, or a non-empty parallel list of them" };
	return { name, description, chain: chain as ChainStep[] };
}

function loadDir(dir: string, origin: Workflow["origin"]): Workflow[] {
	if (!existsSync(dir)) return [];
	const out: Workflow[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".md")) continue;
		const filePath = join(dir, file);
		try {
			const parsed = parseWorkflow(readFileSync(filePath, "utf-8"));
			if (!("problem" in parsed)) out.push({ ...parsed, origin, filePath });
		} catch {
			// An unreadable file is skipped, like a bad agent def.
		}
	}
	return out;
}

/** Nearest ancestor project workflows dir, as agent defs find theirs. */
function projectWorkflowsDir(cwd: string): string | undefined {
	for (let dir = cwd; ; dir = dirname(dir)) {
		const candidate = join(dir, CONFIG_DIR_NAME, "workflows");
		if (existsSync(candidate)) return candidate;
		if (dirname(dir) === dir) return undefined;
	}
}

export function discoverWorkflows(cwd: string, trusted: boolean): Workflow[] {
	const byName = new Map<string, Workflow>();
	const project = trusted ? projectWorkflowsDir(cwd) : undefined;
	for (const wf of [
		...loadDir(bundledWorkflowsDir(), "bundled"),
		...loadDir(join(getAgentDir(), "workflows"), "user"),
		...(project ? loadDir(project, "project") : []),
	])
		byName.set(wf.name, wf);
	return Array.from(byName.values());
}

/** The workflow's chain with `{input}` filled in. `{previous}` is left for the chain runner. */
export function expandWorkflow(wf: Workflow, input: string): ChainStep[] {
	const fill = (t: StepTask): StepTask => ({ ...t, task: t.task.replace(/\{input\}/g, input) });
	return wf.chain.map((step) =>
		step.parallel ? { parallel: step.parallel.map(fill) } : { ...fill(stepTasks(step)[0]) },
	);
}
