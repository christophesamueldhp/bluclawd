import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
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
import { runWorkspace } from "./generation-state.ts";
import type { ChainStep } from "./invocation.ts";
import {
	GROUP_PROGRESS,
	haltedIntegration,
	NOT_APPROVAL,
	NOTHING_TO_CLOSE,
	type RunReports,
	whileRunning,
} from "./messages.ts";
import type { ParentScopeChecks } from "./parent-scope.ts";
import { sanitizeReportText, truncateUtf8Safe } from "./results.ts";
import {
	describeWorkspace,
	type IsolatedWorkspace,
	type RunBaseline,
	releaseUnchangedWorktree,
} from "./run-worktree.ts";
import { bestEffort, createRunId, formatRunLabel, handedOff, type SubagentRunRecord } from "./runs.ts";
import {
	type BatchMember,
	type CallResult,
	type CallsUnderWay,
	capAggregate,
	failureReason,
	fullReportOf,
	inlineReports,
	MAX_AGGREGATE_BYTES,
	type MemberOutcome,
	memberLines,
	memberOutcome,
	settleBatch,
	settleCall,
	settledMember,
	storeManifest,
} from "./settling.ts";
import {
	type ChainPlan,
	chainPlanPath,
	chainResultPath,
	getSubagentsRootDir,
	readChainPlan,
	readPersistedRunRecord,
	storedRunReportTextPath,
	subagentRunDir,
	writeAtomicPrivateFile,
} from "./storage.ts";

const MAX_HANDOFF_REPORT_BYTES = 8 * 1024;

const createChainId = (): string => `${CHAIN_ID_PREFIX}${randomUUID().slice(0, 8)}`;
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

function chainManifestPath(agentDir: string, parentSessionId: string, chain: string): string {
	return join(getSubagentsRootDir(agentDir), parentSessionId, "chains", `${chain}.md`);
}

type StepResult = { member: BatchMember } | { blocked: string } | { cancelled: string } | undefined;

export type ChainStepStatus = MemberOutcome["status"] | "blocked" | "not run" | "starting";

export interface ChainResultDetails {
	chain: string;
	deliveryMode: "foreground" | "background";
	manifestPath: string;
	runs: { step: number; runId?: string; name?: string; status: ChainStepStatus }[];
	completed: boolean;
	workspace?: { root: string; baseline: RunBaseline };
	truncated: boolean;
}

export interface ChainDeps {
	admission: Pick<RunAdmission, "check" | "launch" | "resume">;
	nameHolder(name: string): Readonly<SubagentRunRecord> | undefined;
	agentDir(): string;
	reports: Pick<RunReports, "next">;
	getRun(runId: string): Readonly<SubagentRunRecord> | undefined;
	whenFinal(runId: string): Promise<Readonly<SubagentRunRecord>> | undefined;
	handOff: AbortSignal;
	cancel(runId: string, reason: string): void;
	scope: Pick<ParentScopeChecks, "current" | "inScope" | "onBranch">;
	context(): AdmissionContext | undefined;
	calls: CallsUnderWay;
	notify(first: Readonly<SubagentRunRecord>, notice: { parentText: string; details: ChainResultDetails }): void;
}

type ChainToolResult = CallResult<ChainResultDetails | undefined>;

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
				const result = await deps.admission.check({ ...request, params: step.run, group: { chain } }, ctx);
				if (result.ok) checked[i] = result.checked;
				else faults.push({ i, error: result.error });
			} catch (error) {
				faults.push({ i, error: error instanceof Error ? error.message : String(error) });
			}
		}),
	);
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
			group: { chain },
			runId: plan.ran[0]?.runId,
			...(writer >= 0 ? { workspace: "isolated" as const } : {}),
			keepWorktree: true,
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
	const launched = (): CallResult<ChainResultDetails> => ({
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
	});
	const cancelled = () =>
		fail(
			`Cancelling chain ${chain}: its working step was asked to stop, and no later step starts. Sessions, Reports and its worktree are kept; only subagent_resume continues a step. Once it settles, every step's status is in ${manifestPath}.`,
		);
	return settleCall(
		settled,
		{ background, signal: request.signal, notify: (notice) => deps.notify(start, notice) },
		launched,
		cancelled,
	);
}

function storePlan(path: string, plan: ChainPlan): void {
	bestEffort(() => writeAtomicPrivateFile(path, JSON.stringify(plan)));
}

function chainLabel(steps: readonly ChainStep[]): (i: number) => string {
	const stepName = (i: number): string => {
		const step = steps[i];
		if ("resume" in step) return stepName(step.resume);
		const { name, agent } = step.run;
		return name?.trim() || (typeof agent === "string" ? agent : agent.name);
	};
	return (i) => `chain[${i}] (${JSON.stringify(stepName(i))})`;
}

interface ChainRun {
	plan: ChainPlan;
	planPath: string;
	request: Pick<LaunchRequest, "toolCallId" | "parentTurnId" | "signal">;
	background: boolean;
	start: Readonly<SubagentRunRecord>;
	workspace: IsolatedWorkspace | undefined;
	stop: AbortController;
	stopped: AbortSignal;
}

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
	deps.calls.add(chain, "chain", stop);

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
					group: { chain },
					runId,
					...(workspace ? { workspace } : {}),
					origin: start.originEntryId,
					keepWorktree: true,
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
		return deps.admission.resume(resumed, { from: "orchestrator", text: () => `${own}${handoff}` }, now, {
			model,
			thinkingLevel,
			keepWorktree: true,
		});
	};

	const drive = async () => {
		let next = from.next;
		for (let i = from.index; i < steps.length; i++) {
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
			if (stopped.aborted) deps.cancel(active, stopReason());
			const [member] = await settleBatch(agentDir, [next.handle], deps.reports);
			active = undefined;
			results[i] = { member };
			next = undefined;
		}
		await from.earlier;
		if (deps.handOff.aborted) return handedOff();
		deps.calls.settled(chain);
		return settle();
	};

	const settle = async () => {
		const owner = { agentDir, runId: start.runId, runDir: firstDir };
		if (workspace) await releaseUnchangedWorktree(workspace, owner);
		const lines = workspace ? await describeWorkspace(workspace, firstDir) : [];
		const completed = results.every(
			(result) => result && "member" in result && memberOutcome(result.member).status === "completed",
		);
		const statuses = results.map(statusOf);
		const manifest = storeManifest(manifestPath, chainManifest(chain, steps, results, label, lines));
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
		bestEffort(() =>
			writeAtomicPrivateFile(chainResultPath(agentDir, start.parentSessionId, chain), JSON.stringify(details)),
		);
		plan.settled = true;
		storePlan(planPath, plan);
		return { text, details };
	};

	return drive();
}

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
		const plan = readChainPlan(planPath);
		if (!plan || plan.settled || deps.calls.kind(plan.chain)) continue;
		const first = plan.ran[0] && recordOf(plan.ran[0].runId);
		if (!first) {
			plan.settled = true;
			storePlan(planPath, plan);
			continue;
		}
		if (!deps.scope.onBranch(first.originEntryId)) continue;
		const start = { ...first, sessionEpoch: scope.sessionEpoch };
		const firstDir = subagentRunDir(agentDir, parentSessionId, start.runId);
		const workspace = plan.writes ? runWorkspace(firstDir) : undefined;
		let at = 0;
		for (let i = 0; i < plan.ran.length; i++) if (plan.ran[i]) at = i;
		const results: StepResult[] = plan.steps.map(() => undefined);
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

const completedMember = (agentDir: string, record: Readonly<SubagentRunRecord>, generation: number) =>
	settledMember(agentDir, { ...record, status: "closed", generation });

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
	return truncateUtf8Safe(handoff, Math.max(0, room)).text;
}

function statusOf(result: StepResult): ChainStepStatus {
	if (!result) return "not run";
	if ("blocked" in result) return "blocked";
	if ("cancelled" in result) return "cancelled";
	return memberOutcome(result.member).status;
}

function stepLabel(steps: readonly ChainStep[], result: StepResult, i: number, label: (i: number) => string): string {
	if (!result || !("member" in result)) return label(i);
	return `chain[${i}] ${formatRunLabel(result.member.record)}${"resume" in steps[i] ? ", resumed" : ""}`;
}

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
	return why === undefined ? undefined : failureReason(why, brief);
}

function formatChainAggregate(
	chain: string,
	steps: readonly ChainStep[],
	results: readonly StepResult[],
	label: (i: number) => string,
	statuses: readonly ChainStepStatus[],
	completed: boolean,
	workspaceLines: readonly string[],
	manifest: string,
	workspace: IsolatedWorkspace | undefined,
	budget = MAX_AGGREGATE_BYTES,
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
				: `The chain halted: its worktree keeps the partial work for you to inspect. It is not ready to integrate, and none of it is in your checkout. ${haltedIntegration(chain)}`
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

function chainManifest(
	chain: string,
	steps: readonly ChainStep[],
	results: readonly StepResult[],
	label: (i: number) => string,
	workspaceLines: readonly string[],
): string {
	return [
		`# Chain ${chain}`,
		"",
		...workspaceLines,
		"",
		...results.flatMap((result, i) => {
			const status = statusOf(result);
			const why = reasonOf(result, false);
			const line = `- ${stepLabel(steps, result, i, label)}: ${status}${why ? `: ${why}` : ""}`;
			if (!result || !("member" in result)) return [line];
			return [line, ...memberLines(result.member, { workspace: false })];
		}),
		"",
	].join("\n");
}
