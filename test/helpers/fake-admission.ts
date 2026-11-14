import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdmissionContext, AdmissionResult, RunAdmission } from "../../ext/subagents/admission.ts";
import type { SubagentRunRecord } from "../../ext/subagents/runs.ts";
import { storeRunReport, subagentRunDir } from "../../ext/subagents/storage.ts";

export const SESSION = "session-1";

/** How a run named in a fake Admission's plan goes. */
export interface RunPlan {
	/** Its Report's text; none is stored without one. */
	report?: string;
	/** Its Report's outcome: failed with `error`, else completed. */
	error?: string;
	/** Refused by Admission, before or after it passed its checks. */
	refuse?: string;
	refuseLate?: string;
	/** Admission throws, after its checks. */
	throwLate?: string;
	/** Works until released. */
	hold?: true;
	/** How its next generation goes, once resumed. */
	resumed?: RunPlan;
}

/**
 * A fake Admission, with the parts of the orchestrator a call admitted through it settles with: each run it admits
 * goes as `plans` has it, by its name, and settles at once unless held. Its run directories are real, in a temp dir.
 */
export function fakeAdmission(plans: Record<string, RunPlan>) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "bc-settling-")));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const cwd = join(root, "repo");
	mkdirSync(cwd);
	const runs = new Map<string, SubagentRunRecord>();
	const finals = new Map<string, (record: SubagentRunRecord) => void>();
	const held = new Map<string, () => void>();
	/** Each admitted generation's name and task, in order. */
	const admitted: { name: string; task: string; generation: number }[] = [];
	let seq = 0;

	const finish = (runId: string, extra: Partial<SubagentRunRecord>) => {
		const current = runs.get(runId);
		if (!current || current.status === "closed" || current.status === "cancelled") return;
		const record = { ...current, ...extra, endedAt: Date.now() } as SubagentRunRecord;
		runs.set(runId, record);
		finals.get(runId)?.(record);
	};
	const complete = (runId: string, plan: RunPlan) => {
		const record = runs.get(runId);
		if (!record || record.status !== "running") return;
		if (plan.report !== undefined) {
			storeRunReport(subagentRunDir(agentDir, SESSION, runId), {
				text: plan.report,
				outcome: plan.error ? { status: "failed", error: plan.error } : { status: "completed" },
				generation: record.generation,
			});
		}
		finish(runId, { status: "closed" });
	};
	const start = (record: SubagentRunRecord, plan: RunPlan): AdmissionResult => {
		runs.set(record.runId, record);
		const completion = new Promise<Readonly<SubagentRunRecord>>((resolve) => finals.set(record.runId, resolve));
		const go = () => complete(record.runId, plan);
		if (plan.hold) held.set(`${record.name}#${record.generation}`, go);
		else setTimeout(go, 0);
		return { ok: true, handle: { runId: record.runId, record, completion } };
	};

	const admission: Pick<RunAdmission, "launch" | "resume"> = {
		launch: async (request, ctx) => {
			const { params } = request;
			const name = params.name ?? String(params.agent);
			const plan = plans[name] ?? {};
			if (plan.refuse) return { ok: false, error: plan.refuse };
			if (request.ready && !(await request.ready({ cwd: ctx.cwd, root: ctx.cwd, writes: false }))) {
				return { ok: false, error: "not admitted: its call was not admitted whole" };
			}
			if (plan.refuseLate) return { ok: false, error: plan.refuseLate };
			if (plan.throwLate) throw new Error(plan.throwLate);
			admitted.push({ name, task: params.task, generation: 0 });
			const runId = request.chain?.runId ?? `sub_${++seq}`;
			return start(
				{
					runId,
					parentSessionId: SESSION,
					sessionEpoch: 1,
					parentTurnId: request.parentTurnId,
					originToolCallId: request.toolCallId,
					name,
					generation: 0,
					backend: "rpc",
					agentName: String(params.agent),
					provider: "faux",
					modelId: "faux-1",
					thinkingLevel: "off",
					cwd: ctx.cwd,
					taskSummary: params.task,
					admittedAt: Date.now(),
					startedAt: Date.now(),
					deliveryMode: params.background ? "background" : "foreground",
					...(request.batch ? { batch: request.batch } : {}),
					...(request.chain ? { chain: request.chain.id } : {}),
					status: "running",
					backgroundDeliveryAttempted: false,
				} as SubagentRunRecord,
				plan,
			);
		},
		resume: async (run, buildPrompt) => {
			const plan = plans[run.name ?? ""]?.resumed ?? {};
			if (plan.refuse || !buildPrompt) return { ok: false, error: plan.refuse ?? "no instruction" };
			const generation = run.generation + 1;
			admitted.push({ name: run.name ?? "", task: buildPrompt(), generation });
			return start({ ...run, generation, status: "running", startedAt: Date.now() } as SubagentRunRecord, plan);
		},
	};

	const ctx = {
		cwd,
		mode: "tui",
		sessionManager: { getSessionId: () => SESSION, getLeafId: () => "leaf", getBranch: () => [] },
	} as unknown as AdmissionContext;

	return {
		agentDir,
		ctx,
		admission,
		admitted,
		getRun: (runId: string): Readonly<SubagentRunRecord> | undefined => runs.get(runId),
		/** Lets the held run named `name`, in its generation `generation`, settle. */
		release: (name: string, generation = 0) => held.get(`${name}#${generation}`)?.(),
		/** Whether the run named `name` is working, in its generation `generation`. */
		working: (name: string, generation = 0) =>
			[...runs.values()].some(
				(run) => run.name === name && run.generation === generation && run.status === "running",
			),
		cancel: (runId: string, reason = "Cancelled by its call") =>
			finish(runId, { status: "cancelled", stopSource: "caller", stopReason: reason }),
		whenFinal: (runId: string): Promise<Readonly<SubagentRunRecord>> | undefined => {
			const run = runs.get(runId);
			if (!run) return undefined;
			if (run.status === "closed" || run.status === "cancelled") return Promise.resolve(run);
			return new Promise((resolve) => {
				const earlier = finals.get(runId);
				finals.set(runId, (record) => {
					earlier?.(record);
					resolve(record);
				});
			});
		},
		/** `text` with the IDs and paths that differ per run made stable. */
		stable: (text: string) =>
			[...runs.values()]
				.reduce((stable, run) => stable.replaceAll(run.runId, `sub_${run.name}`), text.replaceAll(root, "<root>"))
				.replace(/(chain|batch)_[0-9a-f]{8}/g, "$1_ID"),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}
