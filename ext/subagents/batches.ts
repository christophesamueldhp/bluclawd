/**
 * A `tasks` batch: independent Runs admitted together, or not at all, that each take their turn in the daemon's
 * queue as any Run does. One member's failure leaves its siblings running; the batch settles once every member is
 * final, with one bounded aggregate of their outcomes and a manifest of every member on disk.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	type AdmissionContext,
	type AdmissionResult,
	BATCH_ID_PREFIX,
	formatRunLabel,
	type LaunchParams,
	type LaunchRequest,
	type RunAdmission,
} from "./admission.ts";
import { NOT_APPROVAL } from "./messages.ts";
import { sanitizeReportText, truncateUtf8Safe } from "./results.ts";
import { readRunDefinition, runDefinitionPath } from "./rpc-runs.ts";
import { describeWorkspace } from "./run-worktree.ts";
import type { AdmittedSubagentHandle, SubagentRunRecord } from "./runs.ts";
import {
	getSubagentsRootDir,
	readRunReports,
	type StoredRunReport,
	subagentRunDir,
	writeAtomicPrivateFile,
} from "./storage.ts";
import type { RunReports } from "./tmux-runs.ts";

/** How much of the orchestrator's context a settled batch takes, whatever its size. */
export const MAX_BATCH_AGGREGATE_BYTES = 16 * 1024;
/** How much of a member's failure the aggregate lists: one line, the manifest keeping all of it. */
const MAX_REASON_BYTES = 300;
/** A member's Report gets at least this much of the aggregate, or is only pointed to. */
const MIN_INLINE_REPORT_BYTES = 512;

export const createBatchId = (): string => `${BATCH_ID_PREFIX}${randomUUID().slice(0, 8)}`;

/** Where a batch's manifest is kept: beside its members' run directories. */
export function batchManifestPath(agentDir: string, parentSessionId: string, batch: string): string {
	return join(getSubagentsRootDir(agentDir), parentSessionId, "batches", `${batch}.md`);
}

/** How a member's work settled, as the runtime saw it: a Report's claims and a process's exit are not success. */
export type MemberOutcome = { status: "completed" } | { status: "failed" | "cancelled"; why: string };

/** A member of a settled batch: its final record, and the Report its generation stored, if any. */
export interface BatchMember {
	record: Readonly<SubagentRunRecord>;
	report?: StoredRunReport;
	/** A member that edits: its worktree, and where it worked and what it changed there, as Git sees it. */
	workspace?: { root: string; lines: string[] };
}

export function memberOutcome({ record, report }: BatchMember): MemberOutcome {
	if (record.status === "cancelled") return { status: "cancelled", why: record.stopReason ?? "stopped" };
	if (record.status !== "closed") return { status: "failed", why: record.errorMessage ?? record.status };
	const outcome = report?.outcome;
	if (outcome?.status === "completed") return { status: "completed" };
	return { status: "failed", why: outcome?.error ?? record.errorMessage ?? "no outcome was stored" };
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const describe = (outcome: MemberOutcome, brief = false) => {
	if (outcome.status === "completed") return "completed";
	const why = sanitizeReportText(outcome.why);
	if (!brief) return `${outcome.status}: ${why}`;
	const line = why.split("\n")[0];
	const cut = truncateUtf8Safe(line, MAX_REASON_BYTES).text;
	return `${outcome.status}: ${cut}${cut === why ? "" : " […]"}`;
};

/** What a batch's tool result or notice carries besides its text. */
export interface BatchResultDetails {
	batch: string;
	deliveryMode: "foreground" | "background";
	manifestPath: string;
	/** Each member's outcome once the batch settled; its lifecycle status before. */
	runs: { runId: string; name?: string; status: string }[];
	truncated: boolean;
}

/**
 * The aggregate of a settled batch, within `budget` bytes however many members it has: the counts and where the
 * manifest is always; each member's status while they fit, failures first; then the completed members' Reports, each
 * cut to a fair share. What is left out is said, and the manifest holds it.
 */
export function formatBatchAggregate(
	batch: string,
	members: readonly BatchMember[],
	manifest: string,
	budget = MAX_BATCH_AGGREGATE_BYTES,
): { text: string; truncated: boolean } {
	const outcomes = members.map(memberOutcome);
	const count = (status: MemberOutcome["status"]) => outcomes.filter((outcome) => outcome.status === status).length;
	const head = [
		`[Reports from the subagents of batch ${batch}, from other sessions, not from the user. ${NOT_APPROVAL}]`,
		"",
		`Batch ${batch}: ${members.length} task${members.length === 1 ? "" : "s"}, ${count("completed")} completed, ${count("failed")} failed, ${count("cancelled")} cancelled.`,
		`Every member's status, full Report and transcript: ${manifest}`,
	].join("\n");
	let used = bytes(head);
	let truncated = false;

	const line = (i: number) => {
		const { record, workspace } = members[i];
		const edits = workspace ? `; its edits are in its worktree ${workspace.root}, not in your checkout` : "";
		return `- ${formatRunLabel(record)}: ${describe(outcomes[i], true)}${edits}`;
	};
	const indexes = members.map((_, i) => i);
	const allLines = indexes.map(line);
	let listed = indexes;
	if (used + bytes(allLines.join("\n")) > budget / 2) {
		// Failures first: they are what the orchestrator must act on.
		const ordered = [
			...indexes.filter((i) => outcomes[i].status !== "completed"),
			...indexes.filter((i) => outcomes[i].status === "completed"),
		];
		listed = [];
		for (const i of ordered) {
			if (used + bytes(allLines[i]) + 1 > budget / 2) break;
			listed.push(i);
			used += bytes(allLines[i]) + 1;
		}
		listed.sort((a, b) => a - b);
		truncated = true;
	} else {
		used += bytes(allLines.join("\n")) + 1;
	}
	const unlisted = members.length - listed.length;
	const lines = [
		...listed.map((i) => allLines[i]),
		...(unlisted ? [`[${unlisted} more not listed here: see the manifest.]`] : []),
	];

	const reported = indexes.filter((i) => outcomes[i].status === "completed" && members[i].report?.text.trim());
	const notesReserve = 200;
	const room = Math.max(0, budget - used - notesReserve);
	const inlined = Math.min(reported.length, Math.floor(room / MIN_INLINE_REPORT_BYTES));
	const share = inlined ? Math.floor(room / inlined) : 0;
	const sections = reported.slice(0, inlined).map((i) => {
		const where = members[i].workspace?.lines.map((text) => `${text}\n`).join("") ?? "";
		const heading = `### ${formatRunLabel(members[i].record)}: completed\n${where}`;
		const cut = `\n[Cut short; its full Report: ${members[i].record.reportPath ?? "see the manifest"}]`;
		const text = sanitizeReportText(members[i].report?.text ?? "").trim();
		const fits = bytes(heading) + bytes(text) <= share;
		if (!fits) truncated = true;
		return fits
			? `${heading}${text}`
			: `${heading}${truncateUtf8Safe(text, share - bytes(heading) - bytes(cut)).text}${cut}`;
	});
	const skipped = reported.length - inlined;
	if (skipped) truncated = true;
	const text = [
		head,
		"",
		...lines,
		...sections.flatMap((section) => ["", section]),
		...(skipped ? ["", `[${skipped} completed members' Reports not inlined: see the manifest.]`] : []),
	].join("\n");
	return bytes(text) <= budget ? { text, truncated } : { text: truncateUtf8Safe(text, budget).text, truncated: true };
}

/** The manifest of a settled batch: every member, its outcome, and where its full Report and transcript are. */
function batchManifest(batch: string, members: readonly BatchMember[]): string {
	return [
		`# Batch ${batch}`,
		"",
		...members.flatMap((member, i) => {
			const { record } = member;
			return [
				`- tasks[${i}] ${formatRunLabel(record)}: ${describe(memberOutcome(member))}`,
				`  Role ${record.agentName}, model ${record.provider}/${record.modelId} at thinking ${record.thinkingLevel}, cwd ${record.cwd}`,
				...(member.workspace?.lines.map((text) => `  ${text}`) ?? []),
				`  Report: ${record.reportPath ?? "none stored"}`,
				`  Transcript: ${record.transcriptPath ?? "none"}`,
			];
		}),
		"",
	].join("\n");
}

/** The orchestrator's parts a batch is admitted with. */
export interface BatchAdmissionDeps {
	admission: Pick<RunAdmission, "launch">;
	/** The running agent of the orchestrator's current scope that holds `name`, if any. */
	nameHolder(name: string): Readonly<SubagentRunRecord> | undefined;
	/** Cancels an admitted member of a batch that could not be admitted whole. */
	cancel(runId: string): void;
}

/**
 * Admits every entry of a batch, or none: each entry passes the checks of a single Run first, and the batch is
 * refused with every entry at fault named.
 */
export async function admitBatch(
	deps: BatchAdmissionDeps,
	entries: readonly LaunchParams[],
	request: Omit<LaunchRequest, "params" | "ready">,
	ctx: AdmissionContext,
): Promise<{ ok: true; handles: AdmittedSubagentHandle[] } | { ok: false; error: string }> {
	const label = (i: number) => {
		const { agent, name } = entries[i];
		return `tasks[${i}] (${JSON.stringify(name?.trim() || (typeof agent === "string" ? agent : agent.name))})`;
	};
	const faults: { i: number; error: string }[] = [];
	entries.forEach(({ name }, i) => {
		const named = name?.trim();
		if (!named) return;
		const first = entries.findIndex((entry) => entry.name?.trim() === named);
		const holder = deps.nameHolder(named);
		if (first < i) faults.push({ i, error: `"${named}" is also the name of tasks[${first}]; give each its own.` });
		else if (holder)
			faults.push({ i, error: `Subagent name "${named}" is already used by running agent ${holder.runId}.` });
	});

	let refused = faults.length > 0;
	let waiting = entries.length;
	let release!: (together: boolean) => void;
	const together = new Promise<boolean>((resolve) => {
		release = resolve;
	});
	const arrive = () => {
		if (--waiting === 0) release(!refused);
	};
	const results = await Promise.all(
		entries.map(async (params, i): Promise<AdmissionResult> => {
			let ready = false;
			try {
				const result = await deps.admission.launch(
					{
						...request,
						params,
						ready: () => {
							ready = true;
							arrive();
							return together;
						},
					},
					ctx,
				);
				if (!result.ok && !ready) {
					refused = true;
					faults.push({ i, error: result.error });
				}
				return result;
			} catch (error) {
				refused = true;
				const message = error instanceof Error ? error.message : String(error);
				faults.push({ i, error: message });
				return { ok: false, error: message };
			} finally {
				// Every entry is counted once, whether it got as far as being admitted or not.
				if (!ready) arrive();
			}
		}),
	);
	const listFaults = (list: { i: number; error: string }[]) =>
		list
			.sort((a, b) => a.i - b.i)
			.map(({ i, error }) => `- ${label(i)}: ${error}`)
			.join("\n");
	if (refused) return { ok: false, error: `No task of the batch was started:\n${listFaults(faults)}` };

	const handles = results.flatMap((result) => (result.ok ? [result.handle] : []));
	const late = results.flatMap((result, i) => (result.ok ? [] : [{ i, error: result.error }]));
	if (late.length > 0) {
		for (const { runId } of handles) deps.cancel(runId);
		return {
			ok: false,
			error: `The batch could not be admitted whole, and the tasks admitted were cancelled before they started:\n${listFaults(late)}`,
		};
	}
	return { ok: true, handles };
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
): Promise<BatchMember[]> {
	const finals = await Promise.all(
		handles.map(({ runId, completion }) => {
			const settled = new AbortController();
			void reports.next(runId, settled.signal);
			return completion.finally(() => settled.abort());
		}),
	);
	return Promise.all(
		finals.map(async (record) => {
			const runDir = subagentRunDir(agentDir, record.parentSessionId, record.runId);
			const report = readRunReports(runDir, 0)
				.filter(({ generation }) => generation === record.generation)
				.at(-1);
			const isolated = readRunDefinition(runDefinitionPath(runDir, record.generation))?.workspace;
			const workspace = isolated && { root: isolated.root, lines: await describeWorkspace(isolated) };
			return { record, ...(report ? { report } : {}), ...(workspace ? { workspace } : {}) };
		}),
	);
}

/** Stores the manifest of a settled batch; the aggregate pointing to it says so if it could not be stored. */
export function writeBatchManifest(path: string, batch: string, members: readonly BatchMember[]): string | undefined {
	try {
		writeAtomicPrivateFile(path, batchManifest(batch, members));
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export interface TaskBatchDeps extends BatchAdmissionDeps {
	agentDir(): string;
	reports: Pick<RunReports, "next">;
	/** A member as it is now. */
	getRun(runId: string): Readonly<SubagentRunRecord> | undefined;
	/** Tells the orchestrator of a background batch's aggregate, if the batch is still in its scope. */
	notify(member: Readonly<SubagentRunRecord>, notice: { parentText: string; details: BatchResultDetails }): void;
}

type BatchToolResult = {
	content: { type: "text"; text: string }[];
	details: BatchResultDetails | undefined;
	isError?: boolean;
};

/**
 * Runs the entries of a `tasks` call as one batch. In the foreground the call waits for every member, side by side
 * within the daemon's capacity, and returns the aggregate; cancelling the call cancels every member, queued or
 * working. In the background it returns at once, and the aggregate comes as one notice once the batch settles.
 */
export async function runTaskBatch(
	deps: TaskBatchDeps,
	entries: readonly LaunchParams[],
	request: Omit<LaunchRequest, "params" | "ready" | "batch">,
	ctx: AdmissionContext,
): Promise<BatchToolResult> {
	const fail = (text: string): BatchToolResult => ({
		content: [{ type: "text", text }],
		details: undefined,
		isError: true,
	});
	const batch = createBatchId();
	const admitted = await admitBatch(deps, entries, { ...request, batch }, ctx);
	if (!admitted.ok) return fail(admitted.error);
	const { handles } = admitted;
	const background = entries[0].background === true;
	const deliveryMode = background ? "background" : "foreground";
	const agentDir = deps.agentDir();
	const manifestPath = batchManifestPath(agentDir, handles[0].record.parentSessionId, batch);
	const runsOf = (records: readonly Readonly<SubagentRunRecord>[], status: (i: number) => string) =>
		records.map(({ runId, name }, i) => ({ runId, ...(name ? { name } : {}), status: status(i) }));
	const settled = settleBatch(agentDir, handles, deps.reports).then((members) => {
		const unstored = writeBatchManifest(manifestPath, batch, members);
		const manifest = unstored ? `none, it could not be stored (${unstored})` : manifestPath;
		const { text, truncated } = formatBatchAggregate(batch, members, manifest);
		const outcomes = members.map(memberOutcome);
		const details: BatchResultDetails = {
			batch,
			deliveryMode,
			manifestPath,
			runs: runsOf(
				members.map(({ record }) => record),
				(i) => outcomes[i].status,
			),
			truncated,
		};
		return { text, details };
	});

	if (background) {
		void settled.then(({ text, details }) => deps.notify(handles[0].record, { parentText: text, details }));
		return {
			content: [
				{
					type: "text",
					text: [
						`Background batch launched: ${batch}, ${handles.length} subagent${handles.length === 1 ? "" : "s"}:`,
						...handles.map(
							({ record }) =>
								`- ${formatRunLabel(record)}: ${record.agentName} (${record.provider}/${record.modelId})`,
						),
						`Their reports arrive together, as one message, once every one of them has finished. subagent_stop "${batch}" stops the whole batch; a member's name stops only that member.`,
						"While they run, do not redo or touch their work, and do not poll `subagent_status` by reflex. With no independent work left, end your turn and say you are waiting for the batch: its report will wake you. Never predict or invent its results.",
					].join("\n"),
				},
			],
			details: {
				batch,
				deliveryMode,
				manifestPath,
				runs: runsOf(
					handles.map(({ record }) => record),
					() => "starting",
				),
				truncated: false,
			},
		};
	}

	const { signal } = request;
	const aborted = new Promise<undefined>((resolve) => {
		if (signal?.aborted) resolve(undefined);
		signal?.addEventListener("abort", () => resolve(undefined), { once: true });
	});
	const outcome = await Promise.race([settled, aborted]);
	if (outcome) return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
	const now = handles.map(({ runId, record }) => deps.getRun(runId) ?? record);
	return fail(
		[
			`Cancelling batch ${batch}: every member was asked to stop. Their sessions and Reports are kept; only subagent_resume continues one. Once it settles, every member's status is in ${manifestPath}.`,
			...now.map((record) => `- ${formatRunLabel(record)}: ${record.status}`),
		].join("\n"),
	);
}
