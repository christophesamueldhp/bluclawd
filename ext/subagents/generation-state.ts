import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { processAlive, processGroupAlive, processStarted } from "../../daemon/processes.ts";
import type { PaneChildState, RpcHostSpec, RpcHostState } from "./rpc-host.ts";
import type { RunDefinition } from "./rpc-runs.ts";
import type { IsolatedWorkspace } from "./run-worktree.ts";
import { writeAtomicPrivateFile } from "./storage.ts";

const specPath = (runDir: string) => join(runDir, "rpc-spec.json");
const statePath = (runDir: string) => join(runDir, "rpc-host.json");
const childPath = (runDir: string) => join(runDir, "pane-child.json");
const claimPath = (runDir: string, generation: number) => join(runDir, "hosts", String(generation));

export function runDefinitionPath(runDir: string, generation: number): string {
	return generation ? join(runDir, "generations", `${generation}.json`) : join(runDir, "definition.json");
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

export function generationDefinition(runDir: string, generation: number): RunDefinition | undefined {
	const definition = readJson(runDefinitionPath(runDir, generation)) as RunDefinition | undefined;
	const { tools, deny, cwd, admitted, instructions } = definition ?? {};
	const valid =
		Array.isArray(tools) &&
		Array.isArray(deny) &&
		typeof cwd === "string" &&
		typeof instructions === "string" &&
		typeof admitted?.provider === "string" &&
		typeof admitted.modelId === "string" &&
		typeof admitted.thinkingLevel === "string";
	return valid ? definition : undefined;
}

export function runWorkspace(runDir: string): IsolatedWorkspace | undefined {
	return generationDefinition(runDir, 0)?.workspace;
}

const readState = (runDir: string) => readJson(statePath(runDir)) as RpcHostState | undefined;
const readSpec = (runDir: string) => readJson(specPath(runDir)) as RpcHostSpec | undefined;
const readChild = (runDir: string) => readJson(childPath(runDir)) as PaneChildState | undefined;

function claimedHost(runDir: string, generation: number): number | undefined {
	try {
		const pid = Number(readFileSync(claimPath(runDir, generation), "utf8"));
		return pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * No pid is given out again while a group of that id has members, so once the host is gone, any member left is the
 * run's.
 */
function hostRuns(pid: number, runDir: string): boolean {
	if (!processAlive(pid)) return processGroupAlive(pid, { leaderAliveJustChecked: false });
	return spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.includes(runDir);
}

export function runProcessesLeft(runDir: string): { group: number; host: boolean } | undefined {
	const stored = readState(runDir);
	if (!stored) return undefined;
	const { hostPid: group, hostStarted } = stored;
	if (!processAlive(group))
		return processGroupAlive(group, { leaderAliveJustChecked: false }) ? { group, host: false } : undefined;
	const started = hostStarted && processStarted(group);
	const noStartToCompare = !started;
	if (noStartToCompare) {
		const groupSignalledOrNoExit =
			processGroupAlive(group, { leaderAliveJustChecked: true }) || stored.exit === undefined;
		return groupSignalledOrNoExit ? { group, host: true } : undefined;
	}
	const pidReusedSince = started !== hostStarted;
	return pidReusedSince ? undefined : { group, host: true };
}

export type HostRecord = Pick<
	RpcHostState,
	"childPid" | "sessionFile" | "sessionId" | "outcome" | "reportSeq" | "idle" | "notStarted"
>;

export type GenerationState =
	| { at: "unadmitted" }
	| ({ launch?: RpcHostSpec } & (
			| { at: "admitted" }
			| ({ at: "hosted"; hostPid: number; awaiting: boolean } & HostRecord)
			| ({ at: "ended"; hostPid: number; exit: NonNullable<RpcHostState["exit"]>; gone?: true } & HostRecord)
			| ({ at: "lost"; hostPid: number; gone?: true } & HostRecord)
	  ));

export function generationState(runDir: string, generation: number, launched?: number): GenerationState {
	const spec = readSpec(runDir);
	const launch = spec?.generation === generation ? { launch: spec } : {};
	const hostPid = claimedHost(runDir, generation) ?? launched;
	if (hostPid === undefined) {
		return generationDefinition(runDir, generation) ? { at: "admitted", ...launch } : { at: "unadmitted" };
	}
	const stored = readState(runDir);
	const thisHostsState = stored?.hostPid === hostPid ? stored : undefined;
	const { childPid, sessionFile, sessionId, outcome, reportSeq, idle, notStarted } = thisHostsState ?? {};
	const record: HostRecord = { childPid, sessionFile, sessionId, outcome, reportSeq, idle, notStarted };
	const followedHostPid = launched !== undefined;
	if (thisHostsState?.exit) {
		const gone = !followedHostPid && !hostRuns(hostPid, runDir);
		return { at: "ended", ...launch, hostPid, exit: thisHostsState.exit, ...record, ...(gone ? { gone } : {}) };
	}
	if (followedHostPid ? processAlive(hostPid) : hostRuns(hostPid, runDir)) {
		const awaiting = paneChildAwaiting(runDir, launch.launch);
		return { at: "hosted", ...launch, hostPid, awaiting, ...record };
	}
	return { at: "lost", ...launch, hostPid, ...record, ...(followedHostPid ? {} : { gone: true as const }) };
}

const paneChildAwaiting = (runDir: string, latestLaunch: RpcHostSpec | undefined): boolean =>
	latestLaunch?.pane !== undefined && readChild(runDir)?.awaiting === true;

/**
 * Stores the definition generation `generation` of the run is held to. The launch's is written over; a Resume's is
 * stored only if no other Resume stored one first. pi does not lock a session, so this is what keeps it to one pi at a
 * time, across orchestrator processes too.
 */
export function admitGeneration(runDir: string, generation: number, definition: RunDefinition): boolean {
	const path = runDefinitionPath(runDir, generation);
	const stored = JSON.stringify({ ...definition, admittedAt: Date.now() }, null, 2);
	if (!generation) {
		writeAtomicPrivateFile(path, stored);
		return true;
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const draft = `${path}.${randomUUID()}.tmp`;
	writeFileSync(draft, stored, { mode: 0o600 });
	try {
		// A link fails where a file exists, and gives it whole, so a reader never sees one half written.
		linkSync(draft, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		rmSync(draft, { force: true });
	}
}

export function narrowGeneration(runDir: string, generation: number, definition: RunDefinition): void {
	writeAtomicPrivateFile(runDefinitionPath(runDir, generation), JSON.stringify(definition, null, 2));
}

export function storeLaunch(runDir: string, spec: RpcHostSpec): void {
	writeAtomicPrivateFile(specPath(runDir), JSON.stringify(spec));
}

export function movePane(runDir: string, generation: number, parent: string): boolean {
	const spec = readSpec(runDir);
	if (spec?.generation !== generation || !spec.pane) return false;
	storeLaunch(runDir, { ...spec, pane: { ...spec.pane, parent } });
	return true;
}

function validateUntrustedRpcHostSpec(value: unknown): value is RpcHostSpec {
	const spec = value as Partial<RpcHostSpec> | null;
	const text = (field: unknown) => typeof field === "string";
	return (
		typeof spec === "object" &&
		spec !== null &&
		Array.isArray(spec.args) &&
		spec.args.every(text) &&
		text(spec.cwd) &&
		text(spec.agentDir) &&
		text(spec.prompt) &&
		text(spec.model?.provider) &&
		text(spec.model?.id) &&
		text(spec.model?.thinkingLevel) &&
		Number.isInteger(spec.generation) &&
		(spec.generation ?? -1) >= 0 &&
		(spec.sessionFile === undefined || text(spec.sessionFile)) &&
		(spec.pane === undefined || (text(spec.pane?.session) && text(spec.pane?.parent)))
	);
}

type ChildRecord = Pick<RpcHostState, "sessionFile" | "sessionId" | "outcome" | "reportSeq" | "idle">;

export interface HostSeat {
	readonly spec: RpcHostSpec;
	save(patch: Partial<Omit<RpcHostState, "hostPid" | "generation">>): void;
	saveChild(patch: PaneChildState): void;
	takeChild(): ChildRecord;
	paneParent(): string | undefined;
}

const dropEarlierPaneChildState = (runDir: string) => rmSync(childPath(runDir), { force: true });

export function claimGeneration(runDir: string, hostPid = process.pid): HostSeat | undefined {
	const spec: unknown = JSON.parse(readFileSync(specPath(runDir), "utf8"));
	if (!validateUntrustedRpcHostSpec(spec)) throw new Error(`${specPath(runDir)} is not a run's spec`);
	const { generation } = spec;
	const claim = claimPath(runDir, generation);
	mkdirSync(dirname(claim), { recursive: true, mode: 0o700 });
	let taken = true;
	try {
		writeFileSync(claim, String(hostPid), { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (claimedHost(runDir, generation) !== hostPid) return undefined;
		taken = false;
	}
	const stored = taken ? undefined : readState(runDir);
	const state: RpcHostState =
		stored?.hostPid === hostPid ? stored : { hostPid, generation, hostStarted: processStarted(hostPid) };
	const child: PaneChildState = {};
	const save = () => writeAtomicPrivateFile(statePath(runDir), JSON.stringify(state));
	if (taken) {
		save();
		if (spec.pane) dropEarlierPaneChildState(runDir);
	}
	return {
		spec,
		save: (patch) => {
			Object.assign(state, patch);
			save();
		},
		saveChild: (patch) => {
			Object.assign(child, patch);
			writeAtomicPrivateFile(childPath(runDir), JSON.stringify(child));
		},
		takeChild: () => {
			const { sessionFile, sessionId, outcome, reportSeq, idle } = readChild(runDir) ?? {};
			const record = { sessionFile, sessionId, outcome, reportSeq, idle };
			Object.assign(state, record);
			return record;
		},
		paneParent: () => {
			const now = readSpec(runDir);
			return (now?.generation === generation && now.pane?.parent) || spec.pane?.parent;
		},
	};
}
