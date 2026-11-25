import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	type AdmissionContext,
	type AdmissionResult,
	BATCH_ID_PREFIX,
	type Checked,
	type LaunchRequest,
	nameTaken,
	type RunAdmission,
} from "./admission.ts";
import type { LaunchParams } from "./invocation.ts";
import { GROUP_PROGRESS, NOT_APPROVAL, NOTHING_TO_CLOSE, type RunReports, whileRunning } from "./messages.ts";
import { type AdmittedSubagentHandle, formatRunLabel, type SubagentRunRecord } from "./runs.ts";
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
	storeManifest,
} from "./settling.ts";
import { getSubagentsRootDir } from "./storage.ts";

const MAX_LAUNCH_LINES = 20;

export const createBatchId = (): string => `${BATCH_ID_PREFIX}${randomUUID().slice(0, 8)}`;

export function batchManifestPath(agentDir: string, parentSessionId: string, batch: string): string {
	return join(getSubagentsRootDir(agentDir), parentSessionId, "batches", `${batch}.md`);
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const describe = (outcome: MemberOutcome, brief = false) => {
	if (outcome.status === "completed") return "completed";
	const status = outcome.status === "unsettled" ? "not settled yet" : outcome.status;
	return `${status}: ${failureReason(outcome.why, brief)}`;
};

export interface BatchResultDetails {
	batch: string;
	deliveryMode: "foreground" | "background";
	manifestPath: string;
	runs: { runId: string; name?: string; status: string }[];
	truncated: boolean;
}

export function formatBatchAggregate(
	batch: string,
	members: readonly BatchMember[],
	manifest: string,
	budget = MAX_AGGREGATE_BYTES,
): { text: string; truncated: boolean } {
	const outcomes = members.map(memberOutcome);
	const count = (status: MemberOutcome["status"]) => outcomes.filter((outcome) => outcome.status === status).length;
	const head = [
		`[Reports from the subagents of batch ${batch}, from other sessions, not from the user. ${NOT_APPROVAL}]`,
		"",
		`Batch ${batch}: ${members.length} task${members.length === 1 ? "" : "s"}, ${count("completed")} completed, ${count("failed")} failed, ${count("cancelled")} cancelled${count("unsettled") ? `, ${count("unsettled")} not settled yet` : ""}.`,
		`Every member's status, full Report and transcript: ${manifest}`,
	].join("\n");
	let used = bytes(head);
	let truncated = false;

	const line = (i: number) => {
		const { record, workspace } = members[i];
		const edits =
			workspace && existsSync(workspace.root)
				? `; its edits are in its worktree ${workspace.root}, not in your checkout`
				: "";
		return `- ${formatRunLabel(record)}: ${describe(outcomes[i], true)}${edits}`;
	};
	const indexes = members.map((_, i) => i);
	const allLines = indexes.map(line);
	let listed = indexes;
	if (used + bytes(allLines.join("\n")) > budget / 2) {
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
	const inlined = inlineReports(
		reported.map((i) => {
			const where = members[i].workspace?.lines.map((text) => `${text}\n`).join("") ?? "";
			return {
				heading: `### ${formatRunLabel(members[i].record)}: completed\n${where}${members[i].checks ? `${members[i].checks}\n` : ""}`,
				text: members[i].report?.text ?? "",
				full: fullReportOf(members[i]),
			};
		}),
		room,
	);
	if (inlined.truncated) truncated = true;
	const skipped = reported.length - inlined.sections.length;
	const text = [
		head,
		"",
		...lines,
		...inlined.sections.flatMap((section) => ["", section]),
		...(skipped ? ["", `[${skipped} completed members' Reports not inlined: see the manifest.]`] : []),
	].join("\n");
	return capAggregate(text, truncated, manifest, budget);
}

function batchManifest(batch: string, members: readonly BatchMember[]): string {
	const unsettled = members.filter((member) => memberOutcome(member).status === "unsettled").length;
	return [
		`# Batch ${batch}`,
		"",
		unsettled
			? `${unsettled} of ${members.length} members not settled yet, each as it was at ${new Date().toISOString()}; subagent_status shows one as it is now.`
			: `Settled: all ${members.length} members.`,
		"",
		...members.flatMap((member, i) => [
			`- tasks[${i}] ${formatRunLabel(member.record)}: ${describe(memberOutcome(member))}`,
			...memberLines(member, { workspace: true }),
		]),
		"",
	].join("\n");
}

export interface BatchAdmissionDeps {
	admission: Pick<RunAdmission, "check" | "admit">;
	nameHolder(name: string): Readonly<SubagentRunRecord> | undefined;
	cancel(runId: string): void;
}

export async function admitBatch(
	deps: BatchAdmissionDeps,
	entries: readonly LaunchParams[],
	request: Omit<LaunchRequest, "params">,
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
		else if (holder) faults.push({ i, error: `${nameTaken(named, holder)}.` });
	});

	const checked = await Promise.all(
		entries.map(async (params, i) => {
			try {
				const result = await deps.admission.check({ ...request, params }, ctx);
				if (result.ok) return result.checked;
				faults.push({ i, error: result.error });
			} catch (error) {
				faults.push({ i, error: error instanceof Error ? error.message : String(error) });
			}
			return undefined;
		}),
	);
	const listFaults = (list: { i: number; error: string }[]) =>
		list
			.sort((a, b) => a.i - b.i)
			.map(({ i, error }) => `- ${label(i)}: ${error}`)
			.join("\n");
	if (faults.length > 0) return { ok: false, error: `No task of the batch was started:\n${listFaults(faults)}` };

	const passed = checked.filter((run): run is Checked => run !== undefined);
	const results = passed.map((run): AdmissionResult => {
		try {
			return deps.admission.admit(run);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	});

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

export interface TaskBatchDeps extends BatchAdmissionDeps {
	agentDir(): string;
	reports: Pick<RunReports, "next">;
	getRun(runId: string): Readonly<SubagentRunRecord> | undefined;
	notify(member: Readonly<SubagentRunRecord>, notice: { parentText: string; details: BatchResultDetails }): void;
	calls: CallsUnderWay;
}

type BatchToolResult = CallResult<BatchResultDetails | undefined>;

export async function runTaskBatch(
	deps: TaskBatchDeps,
	entries: readonly LaunchParams[],
	request: Omit<LaunchRequest, "params" | "group">,
	ctx: AdmissionContext,
): Promise<BatchToolResult> {
	const fail = (text: string): BatchToolResult => ({
		content: [{ type: "text", text }],
		details: undefined,
		isError: true,
	});
	const batch = createBatchId();
	const admitted = await admitBatch(deps, entries, { ...request, group: { batch } }, ctx);
	if (!admitted.ok) return fail(admitted.error);
	const { handles } = admitted;
	const background = entries[0].background === true;
	const deliveryMode = background ? "background" : "foreground";
	const agentDir = deps.agentDir();
	const manifestPath = batchManifestPath(agentDir, handles[0].record.parentSessionId, batch);
	const runsOf = (records: readonly Readonly<SubagentRunRecord>[], status: (i: number) => string) =>
		records.map(({ runId, name }, i) => ({ runId, ...(name ? { name } : {}), status: status(i) }));
	const settledMembers: (BatchMember | undefined)[] = handles.map(() => undefined);
	const members = () =>
		handles.map(({ runId, record }, i) => settledMembers[i] ?? { record: deps.getRun(runId) ?? record });
	const resultOf = (current: readonly BatchMember[], budget = MAX_AGGREGATE_BYTES) => {
		const manifest = storeManifest(manifestPath, batchManifest(batch, current));
		const { text, truncated } = formatBatchAggregate(batch, current, manifest, budget);
		const outcomes = current.map(memberOutcome);
		const details: BatchResultDetails = {
			batch,
			deliveryMode,
			manifestPath,
			runs: runsOf(
				current.map(({ record }) => record),
				(i) => outcomes[i].status,
			),
			truncated,
		};
		return { text, details };
	};
	storeManifest(manifestPath, batchManifest(batch, members()));
	deps.calls.add(batch, "batch");
	const settled = settleBatch(agentDir, handles, deps.reports, (i, member) => {
		settledMembers[i] = member;
		storeManifest(manifestPath, batchManifest(batch, members()));
	}).then((final) => {
		deps.calls.settled(batch);
		return resultOf(final);
	});

	const launched = (): CallResult<BatchResultDetails> => {
		const listed = handles.slice(0, MAX_LAUNCH_LINES);
		return {
			content: [
				{
					type: "text",
					text: [
						`Background batch launched: ${batch}, ${handles.length} subagent${handles.length === 1 ? "" : "s"}:`,
						...listed.map(
							({ record }) =>
								`- ${formatRunLabel(record)}: ${record.agentName} (${record.provider}/${record.modelId})`,
						),
						...(handles.length > listed.length
							? [`[${handles.length - listed.length} more not listed here.]`]
							: []),
						`Every member's status, kept current as each settles: ${manifestPath}`,
						`Their reports arrive together, as one message, once every one of them has finished. subagent_stop "${batch}" stops the whole batch; a member's name stops only that member.`,
						whileRunning({ runs: "they run", its: "their", waitingFor: "the batch", result: "results" }),
						`${GROUP_PROGRESS} Their processes end by themselves once they report: ${NOTHING_TO_CLOSE}`,
					].join("\n"),
				},
			],
			details: {
				batch,
				deliveryMode,
				manifestPath,
				runs: runsOf(
					handles.map(({ record }) => record),
					() => "queued",
				),
				truncated: false,
			},
		};
	};
	const cancelled = (): BatchToolResult => {
		const note = `Cancelling batch ${batch}: every member was asked to stop. Their sessions and Reports are kept; only subagent_resume continues one. The manifest named below keeps every member's status as each settles.\n\n`;
		const { text, details } = resultOf(members(), MAX_AGGREGATE_BYTES - bytes(note));
		return { content: [{ type: "text", text: `${note}${text}` }], details, isError: true };
	};
	return settleCall(
		settled,
		{
			background,
			signal: request.signal,
			notify: (notice) => deps.notify(handles[0].record, notice),
		},
		launched,
		cancelled,
	);
}
