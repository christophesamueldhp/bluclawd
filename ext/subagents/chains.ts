/**
 * A `chain`: dependent Runs, one step after another. Every step is checked as a single Run's would be before the first
 * starts; each later one is admitted, through the same Admission and queue, once the step before it completed, and
 * is given that step's Report, bounded. When a step edits, every step works in one isolated worktree, recorded at the
 * first step's Admission and handed on by each step ending: no two steps work in it at once. A failed, cancelled or
 * blocked step halts the chain, and the steps after it never run. Nothing is integrated: the chain's output is its
 * worktree and its last Report, for the orchestrator to review.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type AdmissionContext,
	type AdmissionResult,
	CHAIN_ID_PREFIX,
	invalidModelChoice,
	invalidTaskText,
	type LaunchRequest,
	MAX_TASK_INPUT_BYTES,
	nameTaken,
	type RunAdmission,
} from "./admission.ts";
import {
	type BatchMember,
	capAggregate,
	fullReportOf,
	inlineReports,
	memberOutcome,
	settleBatch,
	settledMember,
} from "./batches.ts";
import { generationDefinition, runWorkspace } from "./generation-state.ts";
import type { ChainStep } from "./invocation.ts";
import { GROUP_PROGRESS, NOT_APPROVAL, NOTHING_TO_CLOSE, type RunReports, whileRunning } from "./messages.ts";
import type { ParentScopeChecks } from "./parent-scope.ts";
import { sanitizeReportText, truncateUtf8Safe } from "./results.ts";
import {
	describeWorkspace,
	type IsolatedWorkspace,
	type RunBaseline,
	releaseUnchangedWorktree,
} from "./run-worktree.ts";
import { createRunId, formatRunLabel, type SubagentRunRecord } from "./runs.ts";
import {
	getSubagentsRootDir,
	readPersistedRunRecord,
	storedRunReportTextPath,
	subagentRunDir,
	writeAtomicPrivateFile,
} from "./storage.ts";

/** How much of the orchestrator's context a settled chain takes, however long its Reports. */
const MAX_CHAIN_AGGREGATE_BYTES = 16 * 1024;
/** How much of a step's Report the next step is given; the rest stays in its file. */
const MAX_HANDOFF_REPORT_BYTES = 8 * 1024;
/** How much of a step's failure the aggregate lists: one line, the manifest keeping all of it. */
const MAX_REASON_BYTES = 300;

const createChainId = (): string => `${CHAIN_ID_PREFIX}${randomUUID().slice(0, 8)}`;
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Where a chain's manifest is kept: beside its steps' run directories. */
function chainManifestPath(agentDir: string, parentSessionId: string, chain: string): string {
	return join(getSubagentsRootDir(agentDir), parentSessionId, "chains", `${chain}.md`);
}

/** Where a settled chain's {@link ChainResultDetails} are kept. */
export function chainResultPath(agentDir: string, parentSessionId: string, chain: string): string {
	return join(getSubagentsRootDir(agentDir), parentSessionId, "chain-results", `${chain}.json`);
}

/** What became of a step: it ran, or was refused or stopped before it started, or never got its turn. */
type StepResult = { member: BatchMember } | { blocked: string } | { cancelled: string } | undefined;

/** What a chain's tool result or notice carries besides its text. */
export interface ChainResultDetails {
	chain: string;
	deliveryMode: "foreground" | "background";
	manifestPath: string;
	/** Each step's outcome once the chain settled: completed, failed, cancelled, blocked or "not run". */
	runs: { step: number; runId?: string; name?: string; status: string }[];
	/** Every step completed: the chain's output is ready for review and Integration. */
	completed: boolean;
	/** The worktree the steps shared, and its baseline: what Integration compares the chain's changes with. */
	workspace?: { root: string; baseline: RunBaseline };
	truncated: boolean;
}

export interface ChainDeps {
	admission: Pick<RunAdmission, "launch" | "resume">;
	/** The running agent of the orchestrator's current scope that holds `name`, if any. */
	nameHolder(name: string): Readonly<SubagentRunRecord> | undefined;
	agentDir(): string;
	reports: Pick<RunReports, "next">;
	/** A step's run as it is now. */
	getRun(runId: string): Readonly<SubagentRunRecord> | undefined;
	/** Settles with a run's record once its current generation is final; undefined for a run not known here. */
	whenFinal(runId: string): Promise<Readonly<SubagentRunRecord>> | undefined;
	/** Aborted when this orchestrator hands its open runs and chains over to the next instance of its session. */
	handOff: AbortSignal;
	/** Cancels a step's run, queued or working. */
	cancel(runId: string, reason: string): void;
	scope: Pick<ParentScopeChecks, "current" | "inScope" | "onBranch">;
	/** The orchestrator's context now, which a later step is admitted with. */
	context(): AdmissionContext | undefined;
	/** The chains under way, by ID: aborting one stops it before its next step. */
	live: Map<string, AbortController>;
	/** Tells the orchestrator of a background chain's aggregate, if the chain is still in its scope. */
	notify(first: Readonly<SubagentRunRecord>, notice: { parentText: string; details: ChainResultDetails }): void;
}

type ChainToolResult = {
	content: { type: "text"; text: string }[];
	details: ChainResultDetails | undefined;
	isError?: boolean;
};

/**
 * Runs the steps of a `chain` call. Every step is checked first, and none starts unless all pass. In the foreground
 * the call waits for the chain to complete or halt, and returns its aggregate; cancelling the call cancels its working
 * step, and no later one starts. In the background it returns once its first step is admitted, and the aggregate
 * comes as one notice.
 */
export async function runChain(
	deps: ChainDeps,
	steps: readonly ChainStep[],
	request: Pick<LaunchRequest, "toolCallId" | "parentTurnId" | "signal">,
	ctx: AdmissionContext,
): Promise<ChainToolResult> {
	const fail = (text: string): ChainToolResult => ({
		content: [{ type: "text", text }],
		details: undefined,
		isError: true,
	});
	const chain = createChainId();
	const fresh = (i: number) => {
		const step = steps[i];
		return "run" in step ? step.run : undefined;
	};
	const label = chainLabel(steps);
	const first = fresh(0);
	const background = first?.background === true;
	if (!first) return fail("chain[0]: the first step of a chain cannot resume one.");
	if (steps.some((step) => "resume" in step) && (ctx.mode === "print" || ctx.mode === "json")) {
		return fail(
			`A chain with a step that resumes an earlier one is not supported in one-shot "${ctx.mode}" mode: give that step an agent of its own.`,
		);
	}

	// Every step is checked as a single Run's would be, none admitted, so a fault anywhere refuses the whole chain.
	const faults: { i: number; error: string }[] = [];
	const checked: ({ cwd: string; root: string; writes: boolean } | undefined)[] = [];
	await Promise.all(
		steps.map(async (step, i) => {
			if ("resume" in step) {
				const invalid = invalidTaskText(step.task) ?? invalidModelChoice(step);
				if (invalid) faults.push({ i, error: invalid });
				return;
			}
			const named = step.run.name?.trim();
			const twin = named ? steps.findIndex((other) => "run" in other && other.run.name?.trim() === named) : i;
			const holder = named ? deps.nameHolder(named) : undefined;
			if (twin < i) faults.push({ i, error: `"${named}" is also the name of chain[${twin}]; give each its own.` });
			else if (named && holder) faults.push({ i, error: `${nameTaken(named, holder)}.` });
			try {
				const result = await deps.admission.launch(
					{
						...request,
						params: step.run,
						chain: { id: chain },
						ready: async (run) => {
							checked[i] = run;
							return false;
						},
					},
					ctx,
				);
				if (!checked[i] && !result.ok) faults.push({ i, error: result.error });
			} catch (error) {
				faults.push({ i, error: error instanceof Error ? error.message : String(error) });
			}
		}),
	);
	// When a step edits, every step works in its worktree: each must be in the repository it is made from.
	const writer = checked.findIndex((run) => run?.writes);
	if (writer >= 0) {
		const { root } = checked[writer] ?? { root: "" };
		checked.forEach((run, i) => {
			if (!run || run.root === root) return;
			faults.push({
				i,
				error: `its cwd ${run.cwd} is not in ${root}, the repository of the worktree the chain's steps share since ${label(writer)} edits. Give work in another repository a subagent call of its own, and hand it what it needs.`,
			});
		});
	}
	if (faults.length > 0) {
		const listed = faults
			.sort((a, b) => a.i - b.i)
			.map(({ i, error }) => `- ${label(i)}: ${error}`)
			.join("\n");
		return fail(`No step of the chain was started:\n${listed}`);
	}

	const stop = new AbortController();
	const stopped = background || !request.signal ? stop.signal : AbortSignal.any([stop.signal, request.signal]);
	const agentDir = deps.agentDir();
	// Stored before its first step is admitted: an instance of the session that takes over after a reload or a crash
	// goes on with it.
	const plan: ChainPlan = {
		chain,
		steps: [...steps],
		toolCallId: request.toolCallId,
		parentTurnId: request.parentTurnId,
		writes: writer >= 0,
		ran: steps.map((_, i) => (i === 0 ? { runId: createRunId(), generation: 0 } : null)),
	};
	const planPath = chainPlanPath(agentDir, ctx.sessionManager.getSessionId(), chain);
	storePlan(planPath, plan);
	const admitted = await deps.admission.launch(
		{
			...request,
			signal: stopped,
			params: first,
			chain: { id: chain, runId: plan.ran[0]?.runId, ...(writer >= 0 ? { workspace: "record" } : {}) },
		},
		ctx,
	);
	if (!admitted.ok) {
		rmSync(planPath, { force: true });
		return fail(`No step of the chain was started:\n- ${label(0)}: ${admitted.error}`);
	}
	const start = admitted.handle.record;
	const firstDir = subagentRunDir(agentDir, start.parentSessionId, start.runId);
	const workspace = writer >= 0 ? runWorkspace(firstDir) : undefined;
	const manifestPath = chainManifestPath(agentDir, start.parentSessionId, chain);
	const settled = driveChain(
		deps,
		{ plan, planPath, request, background, start, workspace, stop, stopped },
		{ index: 0, results: steps.map(() => undefined), next: admitted },
	);
	if (background) {
		void settled.then(({ text, details }) => deps.notify(start, { parentText: text, details }));
		return {
			content: [
				{
					type: "text",
					text: [
						`Background chain launched: ${chain}, ${steps.length} step${steps.length === 1 ? "" : "s"}, from ${label(0)} ${formatRunLabel(start)}: ${start.agentName} (${start.provider}/${start.modelId}).`,
						`Each step starts once the one before it completed; their reports arrive together, as one message, once the chain has finished or halted. subagent_stop "${chain}" stops the whole chain.`,
						whileRunning({ runs: "it runs", waitingFor: "the chain", result: "results" }),
						`${GROUP_PROGRESS} Its processes end by themselves once it reports: ${NOTHING_TO_CLOSE}`,
					].join("\n"),
				},
			],
			details: {
				chain,
				deliveryMode: "background",
				manifestPath,
				runs: steps.map((_, step) => ({ step, status: step === 0 ? "starting" : "not run" })),
				completed: false,
				...(workspace ? { workspace: { root: workspace.root, baseline: workspace.baseline } } : {}),
				truncated: false,
			},
		};
	}
	const aborted = new Promise<undefined>((resolve) => {
		if (request.signal?.aborted) resolve(undefined);
		request.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
	});
	const outcome = await Promise.race([settled, aborted]);
	if (outcome) return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
	return fail(
		`Cancelling chain ${chain}: its working step was asked to stop, and no later step starts. Sessions, Reports and its worktree are kept; only subagent_resume continues a step. Once it settles, every step's status is in ${manifestPath}.`,
	);
}

/** A chain as stored for the next instance of its orchestrator's session, which goes on with it. */
interface ChainPlan {
	chain: string;
	steps: ChainStep[];
	toolCallId: string;
	parentTurnId: string;
	/** A step edits: every step works in the worktree its first step's Admission recorded. */
	writes: boolean;
	/** Each step's run and generation, stored before it is admitted; null for a step not reached. */
	ran: ({ runId: string; generation: number } | null)[];
	/** Stopped as a whole, or its call cancelled: no later step starts, whoever goes on with it. */
	stopped?: true;
	settled?: true;
}

function chainPlanPath(agentDir: string, parentSessionId: string, chain: string): string {
	return join(getSubagentsRootDir(agentDir), parentSessionId, "chain-plans", `${chain}.json`);
}

/** Stores the plan as it is now; one that cannot be stored leaves the chain to this instance alone. */
function storePlan(path: string, plan: ChainPlan): void {
	try {
		writeAtomicPrivateFile(path, JSON.stringify(plan));
	} catch {
		// Kept in memory: an instance taking the session over would not go on with it.
	}
}

function readPlan(path: string): ChainPlan | undefined {
	try {
		const plan = JSON.parse(readFileSync(path, "utf8")) as ChainPlan;
		return Array.isArray(plan.steps) && Array.isArray(plan.ran) && plan.ran.length === plan.steps.length
			? plan
			: undefined;
	} catch {
		return undefined;
	}
}

/** How a chain's step `i` is named before it has a run: by its own name or role, or that of the step it resumes. */
function chainLabel(steps: readonly ChainStep[]): (i: number) => string {
	const stepName = (i: number): string => {
		const step = steps[i];
		if ("resume" in step) return stepName(step.resume);
		const { name, agent } = step.run;
		return name?.trim() || (typeof agent === "string" ? agent : agent.name);
	};
	return (i) => `chain[${i}] (${JSON.stringify(stepName(i))})`;
}

/** A chain under way, as its driver goes on with it. */
interface ChainRun {
	plan: ChainPlan;
	planPath: string;
	request: Pick<LaunchRequest, "toolCallId" | "parentTurnId" | "signal">;
	background: boolean;
	/** Its first step's run, which a later step is held to the scope and branch of. */
	start: Readonly<SubagentRunRecord>;
	workspace: IsolatedWorkspace | undefined;
	stop: AbortController;
	stopped: AbortSignal;
}

/**
 * Goes on with a chain from its step `from.index`: waits for that step's run, `from.next`, or admits it once the step
 * before it completed, and so on, until a step does not complete or none is left. Then settles it: its aggregate.
 */
async function driveChain(
	deps: ChainDeps,
	run: ChainRun,
	from: { index: number; results: StepResult[]; earlier?: Promise<unknown>; next?: AdmissionResult },
): Promise<{ text: string; details: ChainResultDetails }> {
	const { plan, planPath, request, background, start, workspace, stop, stopped } = run;
	const { chain, steps } = plan;
	const label = chainLabel(steps);
	const agentDir = deps.agentDir();
	const firstDir = subagentRunDir(agentDir, start.parentSessionId, start.runId);
	const manifestPath = chainManifestPath(agentDir, start.parentSessionId, chain);
	const results = from.results;
	deps.live.set(chain, stop);

	/** The run of the step working now, which a stop cancels. */
	let active: string | undefined;
	const stopReason = () =>
		stop.signal.aborted ? `Its chain ${chain} was stopped` : "Cancelled by parent tool signal";
	const onStop = () => {
		if (active) deps.cancel(active, stopReason());
		plan.stopped = true;
		storePlan(planPath, plan);
	};
	if (stopped.aborted) onStop();
	else stopped.addEventListener("abort", onStop);

	/** Admits a later step, after the step before it completed, given that step's Report. */
	const admitStep = async (i: number, before: { index: number; member: BatchMember }): Promise<AdmissionResult> => {
		const now = deps.context();
		if (!now || !deps.scope.inScope(start) || !deps.scope.onBranch(start.originEntryId)) {
			return { ok: false, error: "its orchestrator's session or branch changed since the chain began" };
		}
		if (plan.writes && !workspace) return { ok: false, error: "the worktree of its chain is not stored" };
		const step = steps[i];
		const own = "run" in step ? step.run.task : step.task;
		const handoff = handoffText(agentDir, before, MAX_TASK_INPUT_BYTES - bytes(own));
		if ("run" in step) {
			const runId = createRunId();
			plan.ran[i] = { runId, generation: 0 };
			storePlan(planPath, plan);
			return deps.admission.launch(
				{
					...request,
					signal: stopped,
					params: { ...step.run, task: `${own}${handoff}` },
					chain: { id: chain, runId, ...(workspace ? { workspace } : {}), origin: start.originEntryId },
				},
				now,
			);
		}
		const earlier = results[step.resume];
		const resumed = earlier && "member" in earlier ? deps.getRun(earlier.member.record.runId) : undefined;
		if (!resumed) return { ok: false, error: `${label(step.resume)} has no run to resume` };
		plan.ran[i] = { runId: resumed.runId, generation: resumed.generation + 1 };
		storePlan(planPath, plan);
		const { model, thinkingLevel } = step;
		return deps.admission.resume(resumed, () => `${own}${handoff}`, now, { model, thinkingLevel, chainStep: true });
	};

	/** Handed off on a reload: the next instance of the session goes on with the chain, and this one does nothing more. */
	const handedOff = () => new Promise<never>(() => {});
	const drive = async () => {
		let next = from.next;
		for (let i = from.index; i < steps.length; i++) {
			// A chain taken over settles its earlier steps meanwhile, never delaying the wait for the step working now.
			if (!next) await from.earlier;
			if (deps.handOff.aborted) return handedOff();
			if (!next) {
				const before = results[i - 1];
				if (!before || !("member" in before) || memberOutcome(before.member).status !== "completed") break;
				if (stopped.aborted) {
					results[i] = { cancelled: `${stopReason()} before it started` };
					break;
				}
				next = await admitStep(i, { index: i - 1, member: before.member });
				if (deps.handOff.aborted) return handedOff();
			}
			if (!next.ok) {
				results[i] = stopped.aborted ? { cancelled: `${stopReason()} before it started` } : { blocked: next.error };
				break;
			}
			active = next.handle.runId;
			// A Resume takes no call's signal: stopped while it was admitted, it is cancelled here.
			if (stopped.aborted) deps.cancel(active, stopReason());
			const [member] = await settleBatch(agentDir, [next.handle], deps.reports);
			active = undefined;
			results[i] = { member };
			next = undefined;
		}
		await from.earlier;
		if (deps.handOff.aborted) return handedOff();
		deps.live.delete(chain);
		return settle();
	};

	const settle = async () => {
		// Kept for each next step, even unchanged; once none runs in it, it goes like any run's worktree left unchanged.
		const owner = { agentDir, runId: start.runId, runDir: firstDir };
		if (workspace) await releaseUnchangedWorktree(workspace, owner);
		const lines = workspace ? await describeWorkspace(workspace, firstDir) : [];
		const completed = results.every(
			(result) => result && "member" in result && memberOutcome(result.member).status === "completed",
		);
		const statuses = results.map(statusOf);
		const unstored = writeManifest(manifestPath, chain, steps, results, label, lines);
		const manifest = unstored ? `none, it could not be stored (${unstored})` : manifestPath;
		const { text, truncated } = formatChainAggregate(
			chain,
			steps,
			results,
			label,
			statuses,
			completed,
			lines,
			manifest,
			workspace,
		);
		const details: ChainResultDetails = {
			chain,
			deliveryMode: background ? "background" : "foreground",
			manifestPath,
			runs: results.map((result, step) => {
				const record = result && "member" in result ? result.member.record : undefined;
				return {
					step,
					...(record ? { runId: record.runId, ...(record.name ? { name: record.name } : {}) } : {}),
					status: statuses[step],
				};
			}),
			completed,
			...(workspace ? { workspace: { root: workspace.root, baseline: workspace.baseline } } : {}),
			truncated,
		};
		// What Integration takes the chain's readiness and worktree from, after this call is long gone.
		try {
			writeAtomicPrivateFile(chainResultPath(agentDir, start.parentSessionId, chain), JSON.stringify(details));
		} catch {
			// The chain then cannot be integrated, which Integration says.
		}
		plan.settled = true;
		storePlan(planPath, plan);
		return { text, details };
	};

	return drive();
}

/**
 * Goes on with the chains an earlier instance of the orchestrator's session left under way, after a reload or a crash,
 * as stored. A step still working is waited for; one whose turn came meanwhile is admitted now, through the same
 * Admission as any, by the session that returned: none starts while no orchestrator is there. A chain stopped before
 * stays stopped. Each settles as a background chain does, with one notice. One off the branch waits, untouched.
 */
export function resumeChains(deps: ChainDeps, parentSessionId: string): void {
	const agentDir = deps.agentDir();
	const dir = join(getSubagentsRootDir(agentDir), parentSessionId, "chain-plans");
	const scope = deps.scope.current();
	let files: string[];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".json"));
	} catch {
		return;
	}
	if (!scope) return;
	const recordOf = (runId: string) => deps.getRun(runId) ?? readPersistedRunRecord(agentDir, parentSessionId, runId);
	for (const file of files) {
		const planPath = join(dir, file);
		const plan = readPlan(planPath);
		if (!plan || plan.settled || deps.live.has(plan.chain)) continue;
		const first = plan.ran[0] && recordOf(plan.ran[0].runId);
		// Its first step was never admitted: it never began.
		if (!first) {
			plan.settled = true;
			storePlan(planPath, plan);
			continue;
		}
		if (!deps.scope.onBranch(first.originEntryId)) continue;
		// The session reclaims it: its steps are held to this instance's scope from now on.
		const start = { ...first, sessionEpoch: scope.sessionEpoch };
		const firstDir = subagentRunDir(agentDir, parentSessionId, start.runId);
		const workspace = plan.writes ? runWorkspace(firstDir) : undefined;
		let at = 0;
		for (let i = 0; i < plan.ran.length; i++) if (plan.ran[i]) at = i;
		const results: StepResult[] = plan.steps.map(() => undefined);
		// The chain went on past each earlier step only once it completed.
		const earlier = Promise.all(
			plan.ran.slice(0, at).map(async (ran, i) => {
				const record = ran && recordOf(ran.runId);
				if (ran && record) results[i] = { member: await completedMember(agentDir, record, ran.generation) };
			}),
		);
		const current = plan.ran[at];
		const record = current && recordOf(current.runId);
		const next: AdmissionResult | undefined =
			current && record && record.generation >= current.generation
				? {
						ok: true,
						handle: {
							runId: record.runId,
							record,
							completion: deps.whenFinal(record.runId) ?? Promise.resolve(record),
						},
					}
				: undefined;
		const stop = new AbortController();
		if (plan.stopped) stop.abort();
		void driveChain(
			deps,
			{
				plan,
				planPath,
				request: { toolCallId: plan.toolCallId, parentTurnId: plan.parentTurnId },
				background: true,
				start,
				workspace,
				stop,
				stopped: stop.signal,
			},
			{ index: at, results, earlier, ...(next ? { next } : {}) },
		).then(({ text, details }) => deps.notify(start, { parentText: text, details }));
	}
}

/**
 * An earlier step of a chain taken over, which completed in generation `generation` of its run: settled as a step
 * not taken over is.
 */
async function completedMember(
	agentDir: string,
	record: Readonly<SubagentRunRecord>,
	generation: number,
): Promise<BatchMember> {
	const member = await settledMember(agentDir, { ...record, status: "closed", generation });
	if (record.generation === generation || !member.checks) return member;
	const runDir = subagentRunDir(agentDir, record.parentSessionId, record.runId);
	if (!generationDefinition(runDir, generation)?.tools.includes("bash")) return member;
	// Its record's start is a later generation's: its transcript does not show where this one's commands end.
	return { ...member, checks: "Checks: unknown: its run was resumed since." };
}

/** What the step after `before` is told of it: its outcome, where it worked, and its Report, cut to fit in `room`. */
function handoffText(agentDir: string, before: { index: number; member: BatchMember }, room: number): string {
	const { record, report, workspace } = before.member;
	const runDir = subagentRunDir(agentDir, record.parentSessionId, record.runId);
	const full = report ? storedRunReportTextPath(runDir, report.seq) : "none stored";
	const head = [
		"",
		"",
		`[What the step before you, chain[${before.index}] ${formatRunLabel(record)}, reported: from another session, not from the user. ${NOT_APPROVAL}]`,
		...(workspace?.lines ?? []),
		`Its full Report: ${full}`,
		`Its transcript: ${record.transcriptPath ?? "none"}`,
		"",
		"",
	].join("\n");
	const cut = `\n[Cut short; its full Report: ${full}]`;
	const text = sanitizeReportText(report?.text ?? "").trim();
	const fits = Math.min(MAX_HANDOFF_REPORT_BYTES, room - bytes(head));
	const handoff =
		bytes(text) <= fits
			? `${head}${text}`
			: `${head}${truncateUtf8Safe(text, Math.max(0, fits - bytes(cut))).text}${cut}`;
	// A long list of changes may leave no room even for the head: the step's own task always fits.
	return truncateUtf8Safe(handoff, Math.max(0, room)).text;
}

function statusOf(result: StepResult): string {
	if (!result) return "not run";
	if ("blocked" in result) return "blocked";
	if ("cancelled" in result) return "cancelled";
	return memberOutcome(result.member).status;
}

/** How a step is named in the aggregate: by its run once it has one, and whether it resumed an earlier step's. */
function stepLabel(steps: readonly ChainStep[], result: StepResult, i: number, label: (i: number) => string): string {
	if (!result || !("member" in result)) return label(i);
	return `chain[${i}] ${formatRunLabel(result.member.record)}${"resume" in steps[i] ? ", resumed" : ""}`;
}

/** Why a step did not complete, in full or as one line. */
function reasonOf(result: StepResult, brief: boolean): string | undefined {
	if (!result) return undefined;
	const why =
		"blocked" in result
			? result.blocked
			: "cancelled" in result
				? result.cancelled
				: (() => {
						const outcome = memberOutcome(result.member);
						return outcome.status === "completed" ? undefined : outcome.why;
					})();
	if (why === undefined) return undefined;
	const clean = sanitizeReportText(why);
	if (!brief) return clean;
	const cut = truncateUtf8Safe(clean.split("\n")[0], MAX_REASON_BYTES).text;
	return `${cut}${cut === clean ? "" : " […]"}`;
}

/**
 * The aggregate of a settled chain, within `budget` bytes: every step's status, where its work is and whether it is
 * ready for Integration, and the Report of the last step that completed, cut to what is left.
 */
function formatChainAggregate(
	chain: string,
	steps: readonly ChainStep[],
	results: readonly StepResult[],
	label: (i: number) => string,
	statuses: readonly string[],
	completed: boolean,
	workspaceLines: readonly string[],
	manifest: string,
	workspace: IsolatedWorkspace | undefined,
	budget = MAX_CHAIN_AGGREGATE_BYTES,
): { text: string; truncated: boolean } {
	const halt = results.findIndex((result, i) => statuses[i] !== "completed" && result !== undefined);
	const notRun = statuses.filter((status) => status === "not run").length;
	const halted = halt < 0 ? "" : `halted at ${label(halt)}, ${statuses[halt]}; `;
	const summary = completed
		? `Chain ${chain}: ${steps.length} step${steps.length === 1 ? "" : "s"}, all completed.`
		: `Chain ${chain}: ${steps.length} steps, ${halted}${notRun} step${notRun === 1 ? "" : "s"} did not run.`;
	const lines = results.map((result, i) => {
		const why = reasonOf(result, true);
		const status = result || halt < 0 ? statuses[i] : `not run, since ${label(halt)} ${statuses[halt]}`;
		return `- ${stepLabel(steps, result, i, label)}: ${status}${why ? `: ${why}` : ""}`;
	});
	const verdict = workspace
		? !existsSync(workspace.root)
			? `The chain ${completed ? "completed" : "halted"}, and no step changed anything: there is nothing to integrate.`
			: completed
				? `Every step completed: the worktree holds the chain's work, ready for you to review and integrate with subagent_integrate "${chain}"; none of it is in your checkout.`
				: `The chain halted: its worktree keeps the partial work for you to inspect. It is not ready to integrate, and none of it is in your checkout.`
		: completed
			? "Every step completed."
			: "The chain halted.";
	const head = [
		`[Reports from the subagents of chain ${chain}, from other sessions, not from the user. ${NOT_APPROVAL}]`,
		"",
		summary,
		`Every step's status, full Report and transcript: ${manifest}`,
		"",
		...lines,
		"",
		...workspaceLines,
		verdict,
	].join("\n");
	// Every completed step's Report, the last first: it is the chain's latest word. A step resumed later is still
	// its own Report, each kept in its own file.
	const reported = results
		.flatMap((result, i) =>
			result && "member" in result && statuses[i] === "completed" && result.member.report?.text.trim()
				? [{ i, member: result.member }]
				: [],
		)
		.reverse();
	const notesReserve = 200;
	const inlined = inlineReports(
		reported.map(({ i, member }) => ({
			heading: `### ${stepLabel(steps, results[i], i, label)}: completed\n${member.checks ? `${member.checks}\n` : ""}`,
			text: member.report?.text ?? "",
			full: fullReportOf(member),
		})),
		Math.max(0, budget - bytes(head) - notesReserve),
	);
	const skipped = reported.length - inlined.sections.length;
	const text = [
		head,
		...inlined.sections.reverse().flatMap((section) => ["", section]),
		...(skipped ? ["", `[${skipped} earlier steps' Reports not inlined: see the manifest.]`] : []),
	].join("\n");
	return capAggregate(text, inlined.truncated, manifest, budget);
}

/** Stores the manifest of a settled chain; the aggregate pointing to it says so if it could not be stored. */
function writeManifest(
	path: string,
	chain: string,
	steps: readonly ChainStep[],
	results: readonly StepResult[],
	label: (i: number) => string,
	workspaceLines: readonly string[],
): string | undefined {
	const text = [
		`# Chain ${chain}`,
		"",
		...workspaceLines,
		"",
		...results.flatMap((result, i) => {
			const status = statusOf(result);
			const why = reasonOf(result, false);
			const line = `- ${stepLabel(steps, result, i, label)}: ${status}${why ? `: ${why}` : ""}`;
			if (!result || !("member" in result)) return [line];
			const { record } = result.member;
			return [
				line,
				`  Role ${record.agentName}, model ${record.provider}/${record.modelId} at thinking ${record.thinkingLevel}, cwd ${record.cwd}`,
				...(result.member.checks ? [`  ${result.member.checks}`] : []),
				`  Report: ${(result.member.report && fullReportOf(result.member)) ?? "none stored"}`,
				`  Transcript: ${record.transcriptPath ?? "none"}`,
			];
		}),
		"",
	].join("\n");
	try {
		writeAtomicPrivateFile(path, text);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
