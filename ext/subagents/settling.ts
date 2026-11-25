import { existsSync } from "node:fs";
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
import { checksSummary, generationEvidence } from "./run-evidence.ts";
import {
	type AdmittedSubagentHandle,
	formatRunLabel,
	isTerminalSubagentStatus,
	type SubagentRunRecord,
	settledWithoutError,
} from "./runs.ts";
import {
	type StoredRunReport,
	storedRunReportTextPath,
	subagentReportPath,
	subagentRunDir,
	writeAtomicPrivateFile,
} from "./storage.ts";
import { runStatus } from "./views.ts";

export const MAX_AGGREGATE_BYTES = 16 * 1024;
const MAX_REASON_BYTES = 300;
const MIN_INLINE_REPORT_BYTES = 512;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

export interface CallResult<D> {
	content: { type: "text"; text: string }[];
	details: D;
	isError?: boolean;
}

type CallKind = "batch" | "chain";

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

	stopAll(): void {
		for (const { stop } of this.calls.values()) stop.abort();
	}
}

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

export function reportToParent(
	agentDir: string,
	record: Readonly<SubagentRunRecord>,
	report: { text: string; seq?: number },
): { parentText: string; truncated: boolean } {
	const capped = capReport(report.text, () => {
		const runDir = subagentRunDir(agentDir, record.parentSessionId, record.runId);
		const stored = report.seq === undefined ? undefined : storedRunReportTextPath(runDir, report.seq);
		const olderRunsLatestReport = subagentReportPath(agentDir, record.parentSessionId, record.runId);
		return stored && existsSync(stored) ? stored : olderRunsLatestReport;
	});
	return { parentText: fromRunText("Report", formatRunLabel(record), capped.text), truncated: capped.truncated };
}

export interface RunSettleDeps {
	agentDir(): string;
	reports: Pick<RunReports, "next">;
	whenFinal(runId: string): Promise<Readonly<SubagentRunRecord>> | undefined;
	getRun(runId: string): Readonly<SubagentRunRecord> | undefined;
}

export async function settleRun(
	deps: RunSettleDeps,
	handle: AdmittedSubagentHandle,
	call: { background: boolean; signal?: AbortSignal },
): Promise<CallResult<unknown>> {
	const { signal } = call;
	if (!call.background) {
		const name = handle.record.name ?? handle.runId;
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

export function resumedInBackground(run: Readonly<SubagentRunRecord>, resumed: Readonly<SubagentRunRecord>): string {
	return `Resuming ${formatRunLabel(run)} in the background with its earlier context, as its generation ${resumed.generation} on ${resumed.provider}/${resumed.modelId} at thinking ${resumed.thinkingLevel}. Its report will be delivered when it finishes.\n${whileRunning({ runs: "it runs", result: "result" })}\n${RUN_PROGRESS}`;
}

export type MemberOutcome = { status: "completed" } | { status: "failed" | "cancelled" | "unsettled"; why: string };

export interface BatchMember {
	record: Readonly<SubagentRunRecord>;
	report?: StoredRunReport;
	reportFile?: string;
	workspace?: { root: string; lines: string[] };
	checks?: string;
}

export function memberOutcome({ record, report }: BatchMember): MemberOutcome {
	if (!isTerminalSubagentStatus(record.status)) return { status: "unsettled", why: runStatus(record) };
	if (record.status === "cancelled") return { status: "cancelled", why: record.stopReason ?? "stopped" };
	if (record.status !== "closed") return { status: "failed", why: record.errorMessage ?? record.status };
	const outcome = report?.outcome;
	if (outcome && settledWithoutError(outcome)) return { status: "completed" };
	return { status: "failed", why: outcome?.error ?? record.errorMessage ?? "no outcome was stored" };
}

export const fullReportOf = ({ reportFile, record }: BatchMember): string | undefined =>
	reportFile ?? record.reportPath;

export function failureReason(why: string, brief: boolean): string {
	const clean = sanitizeReportText(why);
	if (!brief) return clean;
	const cut = truncateUtf8Safe(clean.split("\n")[0], MAX_REASON_BYTES).text;
	return `${cut}${cut === clean ? "" : " […]"}`;
}

export async function settleBatch(
	agentDir: string,
	handles: readonly AdmittedSubagentHandle[],
	reports: Pick<RunReports, "next">,
	onSettled?: (index: number, member: BatchMember) => void,
): Promise<BatchMember[]> {
	return Promise.all(
		handles.map(async ({ runId, completion }, i) => {
			const releaseReport = holdMemberReportForAggregate(reports, runId);
			const record = await completion.finally(releaseReport);
			const member = await settledMember(agentDir, record);
			onSettled?.(i, member);
			return member;
		}),
	);
}

function holdMemberReportForAggregate(reports: Pick<RunReports, "next">, runId: string): () => void {
	const settled = new AbortController();
	void reports.next(runId, settled.signal);
	return () => settled.abort();
}

export async function settledMember(agentDir: string, record: Readonly<SubagentRunRecord>): Promise<BatchMember> {
	const runDir = subagentRunDir(agentDir, record.parentSessionId, record.runId);
	const evidence = await generationEvidence(agentDir, runDir, record.generation, {
		transcript: record.transcriptPath,
		startForPreAdmittedAtGenerations: record.startedAt,
	});
	const { report, reportFile, workspace } = evidence;
	return {
		record,
		...(report ? { report, reportFile, checks: checksSummary(evidence) } : {}),
		...(workspace ? { workspace } : {}),
	};
}

export interface InlinedReport {
	heading: string;
	text: string;
	full: string | undefined;
}

export function inlineReports(
	reports: readonly InlinedReport[],
	room: number,
): { sections: string[]; truncated: boolean } {
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

export function storeManifest(path: string, text: string): string {
	try {
		writeAtomicPrivateFile(path, text);
		return path;
	} catch (error) {
		return `none, it could not be stored (${error instanceof Error ? error.message : String(error)})`;
	}
}
