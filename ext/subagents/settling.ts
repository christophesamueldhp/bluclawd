/**
 * How an orchestrator's call settles, whatever its shape: a single Run, a Batch or a Chain. In the foreground the call
 * waits as long as its caller does; in the background it returns at once, and its orchestrator is told once it
 * settled. A single Run's result is its Report, whole up to a cap; a Batch's or a Chain's is one bounded aggregate of
 * its members, each failure in one line, pointing to its manifest, which keeps the rest. The calls under way are kept
 * here, for Stop.
 */

import { existsSync } from "node:fs";
import { generationDefinition } from "./generation-state.ts";
import {
	capReport,
	fromRunText,
	NOTHING_TO_CLOSE,
	RUN_PROGRESS,
	type RunReport,
	type RunReports,
	whileRunning,
} from "./messages.ts";
import { type SubagentResultDetails, sanitizeReportText, truncateUtf8Safe } from "./results.ts";
import { sessionFileEntries } from "./rpc-runs.ts";
import { checksSummary, commandsRun } from "./run-evidence.ts";
import { describeWorkspace } from "./run-worktree.ts";
import {
	type AdmittedSubagentHandle,
	formatRunLabel,
	isTerminalSubagentStatus,
	type SubagentRunRecord,
} from "./runs.ts";
import {
	readRunReports,
	type StoredRunReport,
	storedRunReportTextPath,
	subagentReportPath,
	subagentRunDir,
	writeAtomicPrivateFile,
} from "./storage.ts";
import { runStatus } from "./views.ts";

/** How much of the orchestrator's context a settled Batch or Chain takes, whatever its size. */
export const MAX_AGGREGATE_BYTES = 16 * 1024;
/** How much of a member's failure an aggregate lists: one line, the manifest keeping all of it. */
const MAX_REASON_BYTES = 300;
/** A member's Report gets at least this much of the aggregate, or is only pointed to. */
const MIN_INLINE_REPORT_BYTES = 512;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** What a call returns to the model. */
export interface CallResult<D> {
	content: { type: "text"; text: string }[];
	details: D;
	isError?: boolean;
}

type CallKind = "batch" | "chain";

/** The Batches and Chains of this orchestrator under way, by ID: aborting a Chain's stop starts no later step of it. */
export class CallsUnderWay {
	private readonly calls = new Map<string, { kind: CallKind; stop: AbortController }>();

	add(id: string, kind: CallKind, stop = new AbortController()): void {
		this.calls.set(id, { kind, stop });
	}

	settled(id: string): void {
		this.calls.delete(id);
	}

	kind(id: string): CallKind | undefined {
		return this.calls.get(id)?.kind;
	}

	stop(id: string): void {
		this.calls.get(id)?.stop.abort();
	}

	/** The session ends: no later step of its Chains starts, whoever reopens it. */
	stopAll(): void {
		for (const { stop } of this.calls.values()) stop.abort();
	}
}

/** What `settled` settles with, or fails with, while the call waits for it; undefined once `signal` aborts first. */
export function whileCalled<T>(
	settled: Promise<T> | undefined,
	signal: AbortSignal | undefined,
): Promise<T | undefined> {
	return new Promise((resolve, reject) => {
		if (!settled || signal?.aborted) return resolve(undefined);
		signal?.addEventListener("abort", () => resolve(undefined), { once: true });
		settled.then(resolve, reject);
	});
}

/**
 * A Batch's or a Chain's call, once admitted. In the background it returns what `launched` says at once, and its
 * aggregate goes to `notify` once it settled. In the foreground it returns its aggregate, or what `cancelled` says
 * once the call is cancelled first.
 */
export async function settleCall<D>(
	settled: Promise<{ text: string; details: D }>,
	call: { background: boolean; signal?: AbortSignal; notify(notice: { parentText: string; details: D }): void },
	launched: () => CallResult<D>,
	cancelled: () => CallResult<D | undefined>,
): Promise<CallResult<D | undefined>> {
	if (call.background) {
		void settled.then(({ text, details }) => call.notify({ parentText: text, details }));
		return launched();
	}
	const outcome = await whileCalled(settled, call.signal);
	if (outcome) return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
	return cancelled();
}

/** A run's Report as the orchestrator's model is given it, capped, as a tool result or a notice. */
export function reportToParent(
	agentDir: string,
	record: Readonly<SubagentRunRecord>,
	report: { text: string; seq?: number },
): { parentText: string; truncated: boolean } {
	const capped = capReport(report.text, () => {
		const runDir = subagentRunDir(agentDir, record.parentSessionId, record.runId);
		const stored = report.seq === undefined ? undefined : storedRunReportTextPath(runDir, report.seq);
		// An older run stored no text file, and keeps only its latest Report in report.md.
		return stored && existsSync(stored) ? stored : subagentReportPath(agentDir, record.parentSessionId, record.runId);
	});
	return { parentText: fromRunText("Report", formatRunLabel(record), capped.text), truncated: capped.truncated };
}

/** The orchestrator's parts a single Run's call settles with. */
export interface RunSettleDeps {
	agentDir(): string;
	reports: Pick<RunReports, "next">;
	/** Settles with a run's record once its current generation is final; undefined for a run not known here. */
	whenFinal(runId: string): Promise<Readonly<SubagentRunRecord>> | undefined;
	/** A run as it is now. */
	getRun(runId: string): Readonly<SubagentRunRecord> | undefined;
}

/**
 * A single Run's call, once admitted. In the foreground it returns the run's Report, or why it has none: it ended
 * first, or the call was cancelled. In the background it returns at once; its Report arrives as a notice.
 */
export async function settleRun(
	deps: RunSettleDeps,
	handle: AdmittedSubagentHandle,
	call: { background: boolean; signal?: AbortSignal },
): Promise<CallResult<unknown>> {
	const { signal } = call;
	if (!call.background) {
		const name = handle.record.name ?? handle.runId;
		// Waits until the run reports, the call is aborted, or the run ends first.
		const ended = new AbortController();
		void deps.whenFinal(handle.runId)?.then(() => ended.abort());
		const report: RunReport | undefined = await deps.reports.next(
			handle.runId,
			signal ? AbortSignal.any([signal, ended.signal]) : ended.signal,
		);
		const run = deps.getRun(handle.runId);
		const details = { runId: handle.runId, name, pane: run?.pane, agentName: handle.record.agentName };
		if (!report)
			return {
				content: [
					{
						type: "text",
						text:
							run && isTerminalSubagentStatus(run.status)
								? `${name} ended before it reported: ${run.errorMessage ?? run.stopReason ?? run.status}.`
								: `Cancelling ${name}: its work was asked to stop, and it is ${run?.status ?? "stopping"}. Its session and Reports are kept; only subagent_resume continues it.`,
					},
				],
				details,
				isError: true,
			};
		const { parentText, truncated } = reportToParent(deps.agentDir(), handle.record, report);
		return { content: [{ type: "text", text: parentText }], details: { ...details, truncated } };
	}

	// Its Report arrives as a notice once it has finished.
	return {
		content: [
			{
				type: "text",
				text: [
					`Background subagent launched: ${handle.record.name} (${handle.runId})`,
					`Agent: ${handle.record.agentName} (${handle.record.provider}/${handle.record.modelId})`,
					`Status: ${handle.record.status}`,
					`Its report arrives here once it has finished; its process then ends by itself: ${NOTHING_TO_CLOSE}`,
					whileRunning({
						runs: `${handle.record.name} runs`,
						waitingFor: handle.record.name,
						result: "result",
					}),
					RUN_PROGRESS,
				].join("\n"),
			},
		],
		details: {
			runId: handle.runId,
			agentName: handle.record.agentName,
			status: handle.record.status,
			deliveryMode: "background",
			provider: handle.record.provider,
			modelId: handle.record.modelId,
			thinkingLevel: handle.record.thinkingLevel,
			truncated: false,
		} satisfies SubagentResultDetails,
	};
}

/** What a Resume's call returns at once: the run goes on in the background, its Report arriving as a notice. */
export function resumedInBackground(run: Readonly<SubagentRunRecord>, resumed: Readonly<SubagentRunRecord>): string {
	return `Resuming ${formatRunLabel(run)} in the background with its earlier context, as its generation ${resumed.generation} on ${resumed.provider}/${resumed.modelId} at thinking ${resumed.thinkingLevel}. Its report will be delivered when it finishes.\n${whileRunning({ runs: "it runs", result: "result" })}\n${RUN_PROGRESS}`;
}

/**
 * How a member's work settled, as the runtime saw it: a Report's claims and a process's exit are not success. A
 * member not final yet, as when its batch's call was cancelled, is unsettled, with what it was doing.
 */
export type MemberOutcome = { status: "completed" } | { status: "failed" | "cancelled" | "unsettled"; why: string };

/** A member of a batch: its record, final once it settled, and the Report its generation stored, if any. */
export interface BatchMember {
	record: Readonly<SubagentRunRecord>;
	report?: StoredRunReport;
	/** Where the stored Report's full text is, as the run stored it. */
	reportFile?: string;
	/** A member that edits: its worktree, and where it worked and what it changed there, as Git sees it. */
	workspace?: { root: string; lines: string[] };
	/** What its transcript shows of the checks it ran in its generation, in one line. */
	checks?: string;
}

export function memberOutcome({ record, report }: BatchMember): MemberOutcome {
	if (!isTerminalSubagentStatus(record.status)) return { status: "unsettled", why: runStatus(record) };
	if (record.status === "cancelled") return { status: "cancelled", why: record.stopReason ?? "stopped" };
	if (record.status !== "closed") return { status: "failed", why: record.errorMessage ?? record.status };
	const outcome = report?.outcome;
	if (outcome?.status === "completed") return { status: "completed" };
	return { status: "failed", why: outcome?.error ?? record.errorMessage ?? "no outcome was stored" };
}

/** Where a member's full Report is: the text its run stored, else the orchestrator's record of it. */
export const fullReportOf = ({ reportFile, record }: BatchMember): string | undefined =>
	reportFile ?? record.reportPath;

/** Why a member did not complete: in full for its manifest, or `brief`, in one line, for its aggregate. */
export function failureReason(why: string, brief: boolean): string {
	const clean = sanitizeReportText(why);
	if (!brief) return clean;
	const cut = truncateUtf8Safe(clean.split("\n")[0], MAX_REASON_BYTES).text;
	return `${cut}${cut === clean ? "" : " […]"}`;
}

/**
 * Settles once every member of the batch is final, with each member's outcome. Each member's Report is taken here
 * as it arrives, so it goes out with its batch's aggregate, never on its own; the aggregate reads them from disk,
 * since a stopped member's Report never arrives and a member that never started has none.
 */
export async function settleBatch(
	agentDir: string,
	handles: readonly AdmittedSubagentHandle[],
	reports: Pick<RunReports, "next">,
	onSettled?: (index: number, member: BatchMember) => void,
): Promise<BatchMember[]> {
	return Promise.all(
		handles.map(async ({ runId, completion }, i) => {
			const settled = new AbortController();
			void reports.next(runId, settled.signal);
			const record = await completion.finally(() => settled.abort());
			const member = await settledMember(agentDir, record);
			onSettled?.(i, member);
			return member;
		}),
	);
}

/** A final run as a member: its generation's Report, where it worked and what it changed, and the checks it ran. */
export async function settledMember(agentDir: string, record: Readonly<SubagentRunRecord>): Promise<BatchMember> {
	const runDir = subagentRunDir(agentDir, record.parentSessionId, record.runId);
	const report = readRunReports(runDir, 0)
		.filter(({ generation }) => generation === record.generation)
		.at(-1);
	const definition = generationDefinition(runDir, record.generation);
	const isolated = definition?.workspace;
	const workspace = isolated && { root: isolated.root, lines: await describeWorkspace(isolated, runDir) };
	// What its transcript shows of this generation, which started when the scheduler started it.
	const entries = report && record.transcriptPath ? sessionFileEntries(record.transcriptPath) : undefined;
	const checks =
		report &&
		(entries
			? checksSummary(definition?.tools ?? [], commandsRun(entries, record.startedAt ?? 0))
			: "Checks: unknown: its transcript could not be read.");
	return {
		record,
		...(report ? { report, reportFile: storedRunReportTextPath(runDir, report.seq) } : {}),
		...(workspace ? { workspace } : {}),
		...(checks ? { checks } : {}),
	};
}

/** A Report an aggregate may inline: its heading, kept whole, then its text, cut if need be. */
export interface InlinedReport {
	heading: string;
	text: string;
	/** Where its full text is, which a cut one names. */
	full: string | undefined;
}

/**
 * Inlines as many `reports`, in order, as each can have at least {@link MIN_INLINE_REPORT_BYTES} of `room`, or its
 * whole text when shorter; the room short ones leave goes to longer ones. Each cut one says where its full text is.
 */
export function inlineReports(
	reports: readonly InlinedReport[],
	room: number,
): { sections: string[]; truncated: boolean } {
	// Each section is set apart by a blank line.
	const parts = reports.map((report) => {
		const text = sanitizeReportText(report.text).trim();
		return { ...report, text, need: bytes(report.heading) + bytes(text) + 2 };
	});
	let count = 0;
	for (let least = 0; count < parts.length; count++) {
		least += Math.min(parts[count].need, MIN_INLINE_REPORT_BYTES);
		if (least > room) break;
	}
	const shares: number[] = [];
	let left = room;
	const smallestFirst = [...Array(count).keys()].sort((a, b) => parts[a].need - parts[b].need);
	smallestFirst.forEach((k, n) => {
		shares[k] = Math.min(parts[k].need, Math.floor(left / (count - n)));
		left -= shares[k];
	});
	let truncated = count < parts.length;
	const sections = parts.slice(0, count).map(({ heading, text, full, need }, k) => {
		if (need <= shares[k]) return `${heading}${text}`;
		truncated = true;
		const cut = `\n[Cut short; its full Report: ${full ?? "see the manifest"}]`;
		return `${heading}${truncateUtf8Safe(text, shares[k] - 2 - bytes(heading) - bytes(cut)).text}${cut}`;
	});
	return { sections, truncated };
}

/** An aggregate held to `budget` bytes whatever it holds, saying so where it is cut. */
export function capAggregate(
	text: string,
	truncated: boolean,
	manifest: string,
	budget: number,
): { text: string; truncated: boolean } {
	if (bytes(text) <= budget) return { text, truncated };
	const cut = `\n[Cut short here; the rest is in ${manifest}]`;
	return { text: `${truncateUtf8Safe(text, budget - bytes(cut)).text}${cut}`, truncated: true };
}

/** What a member's manifest entry lists below its status: its run, and where its Report and transcript are. */
export function memberLines(member: BatchMember, { workspace }: { workspace: boolean }): string[] {
	const { record } = member;
	return [
		`  Role ${record.agentName}, model ${record.provider}/${record.modelId} at thinking ${record.thinkingLevel}, cwd ${record.cwd}`,
		...(workspace ? (member.workspace?.lines.map((text) => `  ${text}`) ?? []) : []),
		...(member.checks ? [`  ${member.checks}`] : []),
		`  Report: ${(member.report && fullReportOf(member)) ?? "none stored"}`,
		`  Transcript: ${record.transcriptPath ?? "none"}`,
	];
}

/**
 * Stores a manifest at `path`, and says how an aggregate names it: by its path, or, when it could not be stored,
 * why.
 */
export function storeManifest(path: string, text: string): string {
	try {
		writeAtomicPrivateFile(path, text);
		return path;
	} catch (error) {
		return `none, it could not be stored (${error instanceof Error ? error.message : String(error)})`;
	}
}
