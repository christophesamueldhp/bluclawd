import type { RunEntry } from "../../ext/subagents/directory.ts";
import { isTerminalSubagentStatus, type SubagentRunRecord, type SubagentStopSource } from "../../ext/subagents/runs.ts";
import { createEmptySubagentUsage } from "../../ext/subagents/usage.ts";

export const SESSION = "session-1";

/** A run of session `SESSION`, an RPC run working unless `overrides` say otherwise. */
export function runRecord(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
	const runId = overrides.runId ?? `sub_${overrides.name ?? "run"}`;
	return {
		runId,
		parentSessionId: SESSION,
		sessionEpoch: 1,
		parentTurnId: "turn_1",
		originToolCallId: "call_1",
		generation: 0,
		backend: "rpc",
		kind: "rpc",
		agentName: "general-purpose",
		definitionSource: "bundled",
		provider: "faux",
		modelId: "faux-1",
		thinkingLevel: "off",
		cwd: "/repo",
		startSnapshot: { headCommit: "1234567", dirty: false, statusDigest: "" },
		taskSummary: "work",
		admittedAt: 1000,
		startedAt: 1050,
		deliveryMode: "background",
		status: "running",
		usage: createEmptySubagentUsage(),
		backgroundDeliveryAttempted: false,
		...overrides,
	};
}

/**
 * A fake scheduler, holding `runs` as it follows them. A cancelled run ends as `onCancel` has it: cancelled at once,
 * unless a test sets it to end otherwise or not at all.
 */
export function fakeScheduler(runs: SubagentRunRecord[] = []) {
	const records = new Map(runs.map((run) => [run.runId, run]));
	const finals = new Map<string, { promise: Promise<SubagentRunRecord>; resolve: (run: SubagentRunRecord) => void }>();
	const final = (runId: string) => {
		let entry = finals.get(runId);
		if (!entry) {
			let resolve!: (run: SubagentRunRecord) => void;
			const promise = new Promise<SubagentRunRecord>((res) => {
				resolve = res;
			});
			entry = { promise, resolve };
			finals.set(runId, entry);
		}
		return entry;
	};
	const cancelled: { runId: string; source: SubagentStopSource; reason: string }[] = [];
	const reopened: { runId: string; sessionEpoch: number }[] = [];
	const scheduler = {
		cancelled,
		reopened,
		onCancel: (_run: SubagentRunRecord): Partial<SubagentRunRecord> | undefined => ({
			status: "cancelled",
			stopSource: "model",
		}),
		/** Follows `run`, as a takeover of it does. */
		put(run: SubagentRunRecord) {
			records.set(run.runId, run);
		},
		/** Ends `runId` as `extra` has it. */
		end(runId: string, extra: Partial<SubagentRunRecord>) {
			const run = { ...records.get(runId)!, ...extra };
			records.set(runId, run);
			if (isTerminalSubagentStatus(run.status)) final(runId).resolve(run);
		},
		getRun: (runId: string) => records.get(runId),
		listRuns: () => [...records.values()],
		listActiveRuns: (parentSessionId?: string) =>
			[...records.values()].filter(
				(run) =>
					(!parentSessionId || run.parentSessionId === parentSessionId) && !isTerminalSubagentStatus(run.status),
			),
		whenFinal: (runId: string) => (records.has(runId) ? final(runId).promise : undefined),
		cancelRun(runId: string, source: SubagentStopSource = "user", reason = "Subagent run cancelled") {
			const run = records.get(runId);
			if (!run || isTerminalSubagentStatus(run.status)) return false;
			cancelled.push({ runId, source, reason });
			const ended = scheduler.onCancel(run);
			if (ended) scheduler.end(runId, ended);
			return true;
		},
		reopen(run: Readonly<SubagentRunRecord>, sessionEpoch: number) {
			reopened.push({ runId: run.runId, sessionEpoch });
			const known = records.get(run.runId);
			if (!known || isTerminalSubagentStatus(known.status)) records.set(run.runId, { ...run, sessionEpoch });
		},
		/** The open runs, as the current parent scope's views list them. */
		views: {
			open: (): RunEntry[] =>
				scheduler.listActiveRuns().map((record) => ({
					record,
					state: record.status === "stopping" ? "stopping" : record.status === "starting" ? "starting" : "live",
				})),
			findOpen: (target: string): RunEntry | undefined =>
				scheduler.views.open().find(({ record }) => record.runId === target || record.name === target),
		},
	};
	return scheduler;
}
