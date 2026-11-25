import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
	claimGeneration,
	type GenerationState,
	generationDefinition,
	generationState,
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

export interface StoredRun {
	record: SubagentRunRecord;
	runDir: string;
}

export function storedRuns(agentDir: string): StoredRun[] {
	const root = getSubagentsRootDir(agentDir);
	return (existsSync(root) ? readdirSync(root) : []).flatMap((session) =>
		listPersistedRunRecords(agentDir, session).map((record) => ({
			record,
			runDir: subagentRunDir(agentDir, session, record.runId),
		})),
	);
}

export function findRun(agentDir: string, name: string): StoredRun | undefined {
	return storedRuns(agentDir).find(({ record }) => record.name === name);
}

export function runNamed(agentDir: string, name: string): StoredRun {
	const run = findRun(agentDir, name);
	if (!run) throw new Error(`no run named ${name}`);
	return run;
}

export const runDirOf = (agentDir: string, name: string): string => runNamed(agentDir, name).runDir;

export type HostView = Extract<GenerationState, { hostPid: number }> & {
	exit?: Extract<GenerationState, { at: "ended" }>["exit"];
};

export function hostedGenerations(runDir: string): number[] {
	const hosted: number[] = [];
	while ("hostPid" in generationState(runDir, hosted.length)) hosted.push(hosted.length);
	return hosted;
}

export function hostState(runDir: string): HostView | undefined {
	const latest = hostedGenerations(runDir).at(-1);
	const state = latest === undefined ? undefined : generationState(runDir, latest);
	return state && "hostPid" in state ? state : undefined;
}

export function reportOf(runDir: string, seq: number): StoredRunReport | undefined {
	return readRunReports(runDir, seq - 1).find((report) => report.seq === seq);
}

export const reportText = (runDir: string, seq: number): string =>
	readFileSync(storedRunReportTextPath(runDir, seq), "utf8");

export const reportSeqs = (runDir: string): number[] =>
	readRunReports(runDir, 0)
		.filter(({ seq }) => existsSync(storedRunReportTextPath(runDir, seq)))
		.map(({ seq }) => seq);

export function storedHost(runDir: string): HostView {
	const host = hostState(runDir);
	if (!host) throw new Error(`no host took a generation of the run in ${runDir}`);
	return host;
}

export function definitionOf(runDir: string, generation = 0): RunDefinition {
	const definition = generationDefinition(runDir, generation);
	if (!definition) throw new Error(`no definition of generation ${generation} is stored in ${runDir}`);
	return definition;
}

export function hostEnded(runDir: string, hostPid: number): void {
	storeLaunch(runDir, {
		args: [],
		cwd: runDir,
		agentDir: runDir,
		prompt: "",
		model: { provider: "faux", id: "faux-1", thinkingLevel: "off" },
		generation: 0,
	});
	const seat = claimGeneration(runDir, hostPid);
	if (!seat) throw new Error(`another host took the run in ${runDir}`);
	seat.save({ exit: { code: 0, signal: null } });
}
