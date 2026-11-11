/**
 * A `chain`: dependent Runs, one step after another. Every step is checked as a single Run's would be before the first
 * starts; each later one is admitted, through the same Admission and queue, once the step before it completed, and
 * is given that step's Report, bounded. When a step edits, every step works in one isolated worktree, recorded at the
 * first step's Admission and handed on by each step ending: no two steps work in it at once. A failed, cancelled or
 * blocked step halts the chain, and the steps after it never run. Nothing is integrated: the chain's output is its
 * worktree and its last Report, for the orchestrator to review.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	type AdmissionContext,
	type AdmissionResult,
	CHAIN_ID_PREFIX,
	type ChainStep,
	formatRunLabel,
	invalidModelChoice,
	invalidTaskText,
	type LaunchRequest,
	MAX_TASK_INPUT_BYTES,
	type RunAdmission,
} from "./admission.ts";
import { type BatchMember, memberOutcome, settleBatch } from "./batches.ts";
import { NOT_APPROVAL } from "./messages.ts";
import type { ParentScopeChecks } from "./parent-scope.ts";
import { sanitizeReportText, truncateUtf8Safe } from "./results.ts";
import { readRunDefinition, runDefinitionPath } from "./rpc-runs.ts";
import { describeWorkspace, type IsolatedWorkspace, type RunBaseline } from "./run-worktree.ts";
import type { SubagentRunRecord } from "./runs.ts";
import { getSubagentsRootDir, storedRunReportTextPath, subagentRunDir, writeAtomicPrivateFile } from "./storage.ts";
import type { RunReports } from "./tmux-runs.ts";

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
	/** Cancels a step's run, queued or working. */
	cancel(runId: string, reason: string): void;
	scope: Pick<ParentScopeChecks, "inScope" | "onBranch">;
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
	const stepName = (i: number): string => {
		const step = steps[i];
		if ("resume" in step) return stepName(step.resume);
		const { name, agent } = step.run;
		return name?.trim() || (typeof agent === "string" ? agent : agent.name);
	};
	const label = (i: number) => `chain[${i}] (${JSON.stringify(stepName(i))})`;
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
			else if (holder)
				faults.push({ i, error: `Subagent name "${named}" is already used by running agent ${holder.runId}.` });
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
	const admitted = await deps.admission.launch(
		{
			...request,
			signal: stopped,
			params: first,
			chain: { id: chain, ...(writer >= 0 ? { workspace: "record" } : {}) },
		},
		ctx,
	);
	if (!admitted.ok) return fail(`No step of the chain was started:\n- ${label(0)}: ${admitted.error}`);
	const start = admitted.handle.record;
	const agentDir = deps.agentDir();
	const firstDir = subagentRunDir(agentDir, start.parentSessionId, start.runId);
	const workspace = writer >= 0 ? readRunDefinition(runDefinitionPath(firstDir, 0))?.workspace : undefined;
	const manifestPath = chainManifestPath(agentDir, start.parentSessionId, chain);
	deps.live.set(chain, stop);

	/** The run of the step working now, which a stop cancels. */
	let active: string | undefined;
	const stopReason = () =>
		stop.signal.aborted ? `Its chain ${chain} was stopped` : "Cancelled by parent tool signal";
	stopped.addEventListener("abort", () => {
		if (active) deps.cancel(active, stopReason());
	});

	const results: StepResult[] = steps.map(() => undefined);
	/** Admits a later step, after the step before it completed, given that step's Report. */
	const admitStep = async (i: number, before: { index: number; member: BatchMember }): Promise<AdmissionResult> => {
		const now = deps.context();
		if (!now || !deps.scope.inScope(start) || !deps.scope.onBranch(start.originEntryId)) {
			return { ok: false, error: "its orchestrator's session or branch changed since the chain began" };
		}
		if (writer >= 0 && !workspace) return { ok: false, error: "the worktree of its chain is not stored" };
		const step = steps[i];
		const own = "run" in step ? step.run.task : step.task;
		const handoff = handoffText(agentDir, before, MAX_TASK_INPUT_BYTES - bytes(own));
		if ("run" in step) {
			return deps.admission.launch(
				{
					...request,
					signal: stopped,
					params: { ...step.run, task: `${own}${handoff}` },
					chain: { id: chain, ...(workspace ? { workspace } : {}), origin: start.originEntryId },
				},
				now,
			);
		}
		const run = results[step.resume];
		const resumed = run && "member" in run ? deps.getRun(run.member.record.runId) : undefined;
		if (!resumed) return { ok: false, error: `${label(step.resume)} has no run to resume` };
		const { model, thinkingLevel } = step;
		return deps.admission.resume(resumed, () => `${own}${handoff}`, now, { model, thinkingLevel });
	};

	const drive = async () => {
		let next: AdmissionResult = admitted;
		for (let i = 0; i < steps.length; i++) {
			if (i > 0) {
				const before = results[i - 1];
				if (!before || !("member" in before) || memberOutcome(before.member).status !== "completed") break;
				if (stopped.aborted) {
					results[i] = { cancelled: `${stopReason()} before it started` };
					break;
				}
				next = await admitStep(i, { index: i - 1, member: before.member });
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
		}
		deps.live.delete(chain);
		return settle();
	};

	const settle = async () => {
		const lines = workspace ? await describeWorkspace(workspace) : [];
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
		return { text, details };
	};

	const settled = drive();
	if (background) {
		void settled.then(({ text, details }) => deps.notify(start, { parentText: text, details }));
		return {
			content: [
				{
					type: "text",
					text: [
						`Background chain launched: ${chain}, ${steps.length} step${steps.length === 1 ? "" : "s"}, from ${label(0)} ${formatRunLabel(start)}: ${start.agentName} (${start.provider}/${start.modelId}).`,
						`Each step starts once the one before it completed; their reports arrive together, as one message, once the chain has finished or halted. subagent_stop "${chain}" stops the whole chain.`,
						"While it runs, do not redo or touch its work, and do not poll `subagent_status` by reflex. With no independent work left, end your turn and say you are waiting for the chain: its report will wake you. Never predict or invent its results.",
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
	if (bytes(text) <= fits) return `${head}${text}`;
	return `${head}${truncateUtf8Safe(text, Math.max(0, fits - bytes(cut))).text}${cut}`;
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
		? completed
			? `Every step completed: the worktree holds the chain's work, ready for you to review and integrate; none of it is in your checkout.`
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
	const last = results.reduce<number>(
		(found, result, i) =>
			result && "member" in result && statuses[i] === "completed" && result.member.report?.text.trim() ? i : found,
		-1,
	);
	if (last < 0) return truncateUtf8Safe(head, budget);
	const member = (results[last] as { member: BatchMember }).member;
	const heading = `\n\n### ${stepLabel(steps, results[last], last, label)}: completed\n`;
	const text = sanitizeReportText(member.report?.text ?? "").trim();
	const cut = `\n[Cut short; its full Report: ${member.record.reportPath ?? "see the manifest"}]`;
	const room = budget - bytes(head) - bytes(heading);
	if (bytes(text) <= room) return { text: `${head}${heading}${text}`, truncated: false };
	return {
		text: `${head}${heading}${truncateUtf8Safe(text, Math.max(0, room - bytes(cut))).text}${cut}`,
		truncated: true,
	};
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
				`  Report: ${record.reportPath ?? "none stored"}`,
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
