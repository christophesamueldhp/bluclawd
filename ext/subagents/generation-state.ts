/**
 * A Generation's state on disk (ADR-0010): what it was admitted to do (`definition.json` for the launch,
 * `generations/<n>.json` for each Resume), what its host was launched with (`rpc-spec.json`, the latest Generation's
 * only), which host took it (`hosts/<n>`), what that host stored (`rpc-host.json`), and what its pi in a pane stored
 * (`pane-child.json`). Every reader and writer of these files goes through here. A run's record and Reports are
 * storage.ts's, its inbox and outbox run-mailbox.ts's, its approvals run-approvals.ts's and its worktree
 * run-worktree.ts's.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { processAlive, processGroupAlive } from "../../daemon/processes.ts";
import type { PaneChildState, RpcHostSpec, RpcHostState } from "./rpc-host.ts";
import type { RunDefinition } from "./rpc-runs.ts";
import type { IsolatedWorkspace } from "./run-worktree.ts";
import { writeAtomicPrivateFile } from "./storage.ts";

const specPath = (runDir: string) => join(runDir, "rpc-spec.json");
const statePath = (runDir: string) => join(runDir, "rpc-host.json");
const childPath = (runDir: string) => join(runDir, "pane-child.json");
/** Holds the pid of the one host that runs the generation: whichever started first, however often it was launched. */
const claimPath = (runDir: string, generation: number) => join(runDir, "hosts", String(generation));

/**
 * Where the definition of a run's generation is: the launch's in definition.json, each Resume's beside it. The run's
 * pi is given it by this path (rpc-child.ts).
 */
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

/** What generation `generation` of the run is held to, as stored for it. */
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

/** The worktree of a run that edits: its launch's, which no later generation changes. */
export function runWorkspace(runDir: string): IsolatedWorkspace | undefined {
	return generationDefinition(runDir, 0)?.workspace;
}

const readState = (runDir: string) => readJson(statePath(runDir)) as RpcHostState | undefined;
const readSpec = (runDir: string) => readJson(specPath(runDir)) as RpcHostSpec | undefined;
const readChild = (runDir: string) => readJson(childPath(runDir)) as PaneChildState | undefined;

/** The pid of the host that took generation `generation` of the run, once one did. */
function claimedHost(runDir: string, generation: number): number | undefined {
	try {
		const pid = Number(readFileSync(claimPath(runDir, generation), "utf8"));
		return pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether anything of the run still runs in the process group its host `pid` led, a pid read from disk: one given to
 * another process since is not the host, whose command names the run's directory. No pid is given out again while a
 * group of that id has members, so once the host is gone, any member left is the run's.
 */
function hostRuns(pid: number, runDir: string): boolean {
	if (!processAlive(pid)) return processGroupAlive(pid, { leaderRuns: false });
	return spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.includes(runDir);
}

/**
 * Whether processes of the run's latest host may still run, and in which process group: its group has members, or
 * its host lives and stored no exit. A Generation whose group was not confirmed gone still ends, so a finished run may
 * leave some. A live host is not asked whether it is the run's, unlike a host followed: a `ps` that fails would say
 * not.
 */
export function runProcessesLeft(runDir: string): { group: number } | undefined {
	const host = readState(runDir);
	if (!host) return undefined;
	const leaderRuns = processAlive(host.hostPid);
	const left = processGroupAlive(host.hostPid, { leaderRuns }) || (host.exit === undefined && leaderRuns);
	return left ? { group: host.hostPid } : undefined;
}

/** What a host stored of its generation's work so far. */
export type HostRecord = Pick<
	RpcHostState,
	"childPid" | "sessionFile" | "sessionId" | "outcome" | "reportSeq" | "idle" | "notStarted"
>;

/**
 * Where a Generation is, as its files say now: a snapshot, polled by whoever follows or recovers it. `launch` is the
 * spec it was launched with, while it is the run's latest. `gone`, asked only of a host not `launched` by the caller,
 * says its process group holds nothing of the run any more, or its pid is another process's by now: it is neither
 * signalled nor waited for.
 */
export type GenerationState =
	| { at: "unadmitted" }
	| ({ launch?: RpcHostSpec } & (
			| { at: "admitted" }
			| ({ at: "hosted"; hostPid: number; awaiting: boolean } & HostRecord)
			| ({ at: "ended"; hostPid: number; exit: NonNullable<RpcHostState["exit"]>; gone?: true } & HostRecord)
			| ({ at: "lost"; hostPid: number; gone?: true } & HostRecord)
	  ));

/**
 * Where generation `generation` of the run is: admitted, its definition stored and no host took it; hosted, its host
 * runs; ended, its host stored how its pi exited; lost, its host took it and is gone with no exit stored. `launched`
 * is the host the caller launched or already followed, its host until one takes the generation, and known to be the
 * run's while it lives; any other pid, read from disk, may have been given to another process since.
 */
export function generationState(runDir: string, generation: number, launched?: number): GenerationState {
	const spec = readSpec(runDir);
	const launch = spec?.generation === generation ? { launch: spec } : {};
	const hostPid = claimedHost(runDir, generation) ?? launched;
	if (hostPid === undefined) {
		return generationDefinition(runDir, generation) ? { at: "admitted", ...launch } : { at: "unadmitted" };
	}
	// The run's directory keeps the state of its earlier generation's host until this one stores its own.
	const stored = readState(runDir);
	const own = stored?.hostPid === hostPid ? stored : undefined;
	const { childPid, sessionFile, sessionId, outcome, reportSeq, idle, notStarted } = own ?? {};
	const record: HostRecord = { childPid, sessionFile, sessionId, outcome, reportSeq, idle, notStarted };
	const followed = launched !== undefined;
	if (own?.exit) {
		const gone = !followed && !hostRuns(hostPid, runDir);
		return { at: "ended", ...launch, hostPid, exit: own.exit, ...record, ...(gone ? { gone } : {}) };
	}
	if (followed ? processAlive(hostPid) : hostRuns(hostPid, runDir)) {
		// What a pi in a pane stored is only its own generation's: one on RPC since leaves it as it was.
		const awaiting = launch.launch?.pane !== undefined && readChild(runDir)?.awaiting === true;
		return { at: "hosted", ...launch, hostPid, awaiting, ...record };
	}
	return { at: "lost", ...launch, hostPid, ...record, ...(followed ? {} : { gone: true as const }) };
}

/**
 * Stores the definition generation `generation` of the run is held to. The launch's is written over; a Resume's is
 * stored only if no other Resume stored one first: pi does not lock a session, so this is what keeps it to one pi at a
 * time, across orchestrator processes too. False when another Resume holds it; throws when it cannot be stored.
 */
export function admitGeneration(runDir: string, generation: number, definition: RunDefinition): boolean {
	const path = runDefinitionPath(runDir, generation);
	if (!generation) {
		writeAtomicPrivateFile(path, JSON.stringify(definition, null, 2));
		return true;
	}
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const draft = `${path}.${randomUUID()}.tmp`;
	writeFileSync(draft, JSON.stringify(definition, null, 2), { mode: 0o600 });
	try {
		// A link fails where a file exists, and gives it whole: a reader never sees one half written.
		linkSync(draft, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		rmSync(draft, { force: true });
	}
}

/** Stores what generation `generation` is held to now, narrowed since it was admitted; throws when it cannot. */
export function narrowGeneration(runDir: string, generation: number, definition: RunDefinition): void {
	writeAtomicPrivateFile(runDefinitionPath(runDir, generation), JSON.stringify(definition, null, 2));
}

/** Stores the spec the run's host starts its generation with, before the generation queues: the latest only. */
export function storeLaunch(runDir: string, spec: RpcHostSpec): void {
	writeAtomicPrivateFile(specPath(runDir), JSON.stringify(spec));
}

/**
 * Stores `parent` as the orchestrator pane of generation `generation`, in a pane: a session that took the run over
 * runs in another pane. False when the spec stored is another generation's, or of none in a pane.
 */
export function movePane(runDir: string, generation: number, parent: string): boolean {
	const spec = readSpec(runDir);
	if (spec?.generation !== generation || !spec.pane) return false;
	storeLaunch(runDir, { ...spec, pane: { ...spec.pane, parent } });
	return true;
}

/**
 * Whether `value` is a spec a host runs: the daemon starts a host for any run directory a client names, so what the
 * spec there holds is checked before anything of it starts.
 */
function isRpcHostSpec(value: unknown): value is RpcHostSpec {
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

/** What a run's pi in a pane stores of its work, which its host takes once the pi exits. */
type ChildRecord = Pick<RpcHostState, "sessionFile" | "sessionId" | "outcome" | "reportSeq" | "idle">;

/** The run's latest generation, held by host `hostPid`. */
export interface HostSeat {
	/** The spec it was launched with, as checked when the seat was taken. */
	readonly spec: RpcHostSpec;
	/** Stores `patch` in the host's state. */
	save(patch: Partial<Omit<RpcHostState, "hostPid" | "generation">>): void;
	/** Stores `patch` in what its pi in a pane stores of its work. */
	saveChild(patch: PaneChildState): void;
	/** Takes what its pi in a pane stored into the host's state, stored with the next {@link save}, and returns it. */
	takeChild(): ChildRecord;
	/** The orchestrator pane of its generation in a pane now: another once a session took the run over. */
	paneParent(): string | undefined;
}

/**
 * Takes the run's latest generation, as stored in its spec, for host `hostPid`: only if no other host took it first,
 * so a host launched for it again, after a lost reply or a recovery, leaves it to the first. The host that took it
 * gets it back, its state as it stored it; its pi in a pane is given it this way, by its host's pid. Undefined when
 * another host has it; throws when the spec cannot be read or is not a run's.
 */
export function hostGeneration(runDir: string, hostPid = process.pid): HostSeat | undefined {
	const spec: unknown = JSON.parse(readFileSync(specPath(runDir), "utf8"));
	if (!isRpcHostSpec(spec)) throw new Error(`${specPath(runDir)} is not a run's spec`);
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
	const state: RpcHostState = stored?.hostPid === hostPid ? stored : { hostPid, generation };
	const child: PaneChildState = {};
	const save = () => writeAtomicPrivateFile(statePath(runDir), JSON.stringify(state));
	if (taken) {
		save();
		// What an earlier generation's pi in a pane stored is not this one's.
		if (spec.pane) rmSync(childPath(runDir), { force: true });
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
