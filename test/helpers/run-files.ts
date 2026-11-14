/**
 * What a test reads of the runs an orchestrator stored, through the module that owns each file: a run's record, by
 * which its directory is found, and its Reports are storage.ts's; its host and Generation state generation-state.ts's;
 * its inbox and outbox run-mailbox.ts's.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
	type GenerationState,
	generationDefinition,
	generationState,
	hostGeneration,
	storeLaunch,
} from "../../ext/subagents/generation-state.ts";
import type { RunDefinition } from "../../ext/subagents/rpc-runs.ts";
import type { SubagentRunRecord } from "../../ext/subagents/runs.ts";
import {
	getSubagentsRootDir,
	listPersistedRunRecords,
	readRunReports,
	type StoredRunReport,
	storedRunReportTextPath,
	subagentRunDir,
} from "../../ext/subagents/storage.ts";

/** A run as its orchestrator stored it: its record, and the directory it keeps it in. */
export interface StoredRun {
	record: SubagentRunRecord;
	runDir: string;
}

/** Every run stored under `agentDir`, with its directory. */
export function storedRuns(agentDir: string): StoredRun[] {
	const root = getSubagentsRootDir(agentDir);
	return (existsSync(root) ? readdirSync(root) : []).flatMap((session) =>
		listPersistedRunRecords(agentDir, session).map((record) => ({
			record,
			runDir: subagentRunDir(agentDir, session, record.runId),
		})),
	);
}

/** The run named `name`, once its record is stored. */
export function findRun(agentDir: string, name: string): StoredRun | undefined {
	return storedRuns(agentDir).find(({ record }) => record.name === name);
}

/** The run named `name`; throws while none is stored. */
export function runNamed(agentDir: string, name: string): StoredRun {
	const run = findRun(agentDir, name);
	if (!run) throw new Error(`no run named ${name}`);
	return run;
}

/** The directory of the run named `name`; throws while none is stored. */
export const runDirOf = (agentDir: string, name: string): string => runNamed(agentDir, name).runDir;

/** A Generation a host took, as its files say now, with how its pi exited once its host stored it. */
export type HostView = Extract<GenerationState, { hostPid: number }> & {
	exit?: Extract<GenerationState, { at: "ended" }>["exit"];
};

/** The generations of the run in `runDir` a host took, in order. */
export function hostedGenerations(runDir: string): number[] {
	const hosted: number[] = [];
	while ("hostPid" in generationState(runDir, hosted.length)) hosted.push(hosted.length);
	return hosted;
}

/** The latest generation of the run in `runDir` a host took; undefined before one did. */
export function hostState(runDir: string): HostView | undefined {
	const latest = hostedGenerations(runDir).at(-1);
	const state = latest === undefined ? undefined : generationState(runDir, latest);
	return state && "hostPid" in state ? state : undefined;
}

/** The run's Report `seq`, once stored. */
export function reportOf(runDir: string, seq: number): StoredRunReport | undefined {
	return readRunReports(runDir, seq - 1).find((report) => report.seq === seq);
}

/** The full text of the run's Report `seq`. */
export const reportText = (runDir: string, seq: number): string =>
	readFileSync(storedRunReportTextPath(runDir, seq), "utf8");

/** The numbers of the Reports the run stored whole, its text beside it, in order. */
export const reportSeqs = (runDir: string): number[] =>
	readRunReports(runDir, 0)
		.filter(({ seq }) => existsSync(storedRunReportTextPath(runDir, seq)))
		.map(({ seq }) => seq);

/** As {@link hostState}, once a host took a generation of the run: throws before. */
export function storedHost(runDir: string): HostView {
	const host = hostState(runDir);
	if (!host) throw new Error(`no host took a generation of the run in ${runDir}`);
	return host;
}

/** What generation `generation` of the run in `runDir` is held to; throws while none is stored whole. */
export function definitionOf(runDir: string, generation = 0): RunDefinition {
	const definition = generationDefinition(runDir, generation);
	if (!definition) throw new Error(`no definition of generation ${generation} is stored in ${runDir}`);
	return definition;
}

/** Stores what host `hostPid` stores once it took the run's launch and its pi exited cleanly. */
export function hostEnded(runDir: string, hostPid: number): void {
	storeLaunch(runDir, {
		args: [],
		cwd: runDir,
		agentDir: runDir,
		prompt: "",
		model: { provider: "faux", id: "faux-1", thinkingLevel: "off" },
		generation: 0,
	});
	const seat = hostGeneration(runDir, hostPid);
	if (!seat) throw new Error(`another host took the run in ${runDir}`);
	seat.save({ exit: { code: 0, signal: null } });
}
