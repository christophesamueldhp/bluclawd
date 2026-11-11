import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDeletedPath, getInstancesPath, getWakeupsPath } from "./config.ts";
import { ensureServerDir } from "./paths.ts";
import type { ActiveRun } from "./run-queue.ts";
import type { InstanceRecord } from "./types.ts";
import type { HeldWakeups } from "./wakeups.ts";

/** A deleted row, kept so it does not come back by itself. `paneId`: the pane it was listed as (its
 *  registration id, its tmux session's name), ended should it beat again. `sessionFile`: a session of
 *  it, which a quit's hand-off save lists nothing of. `goneAt`: when tmux was first seen without that
 *  pane (at once, with none). */
export interface DeletedRow {
	paneId?: string;
	sessionFile?: string;
	goneAt?: number;
}

/** Write-then-rename, so a crash mid-write cannot leave a half-written file behind. */
function writeJson(path: string, value: unknown): void {
	const tmpPath = `${path}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(value, null, 2));
	renameSync(tmpPath, path);
}

export function loadInstances(dir: string): InstanceRecord[] {
	const instancesPath = getInstancesPath(dir);
	if (!existsSync(instancesPath)) {
		return [];
	}

	try {
		const data = readFileSync(instancesPath, "utf-8");
		const parsed = JSON.parse(data) as InstanceRecord[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		// A corrupt/half-written instances.json must not throw out of every daemon op (list/save/
		// delete) or brick recoverAfterRestart at startup. Treat it as empty and let it be rewritten.
		return [];
	}
}

export function saveInstances(dir: string, instances: InstanceRecord[]): void {
	ensureServerDir(dir);
	writeJson(getInstancesPath(dir), instances);
}

export function loadDeleted(dir: string): DeletedRow[] {
	try {
		const parsed = JSON.parse(readFileSync(getDeletedPath(dir), "utf-8")) as DeletedRow[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function saveDeleted(dir: string, deleted: DeletedRow[]): void {
	ensureServerDir(dir);
	writeJson(getDeletedPath(dir), deleted);
}

/** Each session's pending wake-ups its pi handed over (daemon/wakeups.ts). */
export function loadWakeups(dir: string): HeldWakeups[] {
	try {
		const parsed = JSON.parse(readFileSync(getWakeupsPath(dir), "utf-8")) as HeldWakeups[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function saveWakeups(dir: string, held: HeldWakeups[]): void {
	ensureServerDir(dir);
	writeJson(getWakeupsPath(dir), held);
}

export function getInstance(dir: string, instanceId: string): InstanceRecord | undefined {
	return loadInstances(dir).find((instance) => instance.id === instanceId);
}

export function upsertInstance(dir: string, instance: InstanceRecord): void {
	const instances = loadInstances(dir);
	const index = instances.findIndex((existing) => existing.id === instance.id);
	if (index === -1) {
		instances.push(instance);
		saveInstances(dir, instances);
		return;
	}

	instances[index] = instance;
	saveInstances(dir, instances);
}

export function removeInstance(dir: string, instanceId: string): void {
	const instances = loadInstances(dir).filter((instance) => instance.id !== instanceId);
	saveInstances(dir, instances);
}

const activeRunsPath = (dir: string) => join(dir, "run-slots.json");

/** The runs a daemon launched whose slots it held as it last stored them: hosts outlive their daemon. */
export function loadActiveRuns(dir: string): ActiveRun[] {
	try {
		const parsed = JSON.parse(readFileSync(activeRunsPath(dir), "utf-8")) as ActiveRun[];
		return Array.isArray(parsed) ? parsed.filter((run) => typeof run?.run === "string" && run.pid > 0) : [];
	} catch {
		return [];
	}
}

export function saveActiveRuns(dir: string, runs: ActiveRun[]): void {
	ensureServerDir();
	writeJson(activeRunsPath(dir), runs);
}
