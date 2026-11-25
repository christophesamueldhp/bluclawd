import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDeletedPath, getInstancesPath, getWakeupsPath } from "./config.ts";
import { ensureOwnerOnlyServerDir } from "./paths.ts";
import type { ActiveRun } from "./run-queue.ts";
import { type StoredRow, storedRow } from "./types.ts";
import type { HeldWakeups } from "./wakeups.ts";

type TmuxSessionName = string;
type SessionFilePath = string;
type EpochMs = number;

export interface DeletedRow {
	paneId?: TmuxSessionName;
	sessionFile?: SessionFilePath;
	goneAt?: EpochMs;
}

function writeJsonAtomically(path: string, value: unknown): void {
	const tmpPath = `${path}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(value, null, 2));
	renameSync(tmpPath, path);
}

export function loadInstances(dir: string): StoredRow[] {
	const instancesPath = getInstancesPath(dir);
	if (!existsSync(instancesPath)) {
		return [];
	}

	try {
		const data = readFileSync(instancesPath, "utf-8");
		const parsed = JSON.parse(data) as StoredRow[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function saveInstances(dir: string, instances: StoredRow[]): void {
	ensureOwnerOnlyServerDir(dir);
	writeJsonAtomically(getInstancesPath(dir), instances.map(storedRow));
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
	ensureOwnerOnlyServerDir(dir);
	writeJsonAtomically(getDeletedPath(dir), deleted);
}

export function loadWakeups(dir: string): HeldWakeups[] {
	try {
		const parsed = JSON.parse(readFileSync(getWakeupsPath(dir), "utf-8")) as HeldWakeups[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function saveWakeups(dir: string, held: HeldWakeups[]): void {
	ensureOwnerOnlyServerDir(dir);
	writeJsonAtomically(getWakeupsPath(dir), held);
}

export function getInstance(dir: string, instanceId: string): StoredRow | undefined {
	return loadInstances(dir).find((instance) => instance.id === instanceId);
}

export function upsertInstance(dir: string, instance: StoredRow): void {
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

export function loadActiveRuns(dir: string): ActiveRun[] {
	try {
		const parsed = JSON.parse(readFileSync(activeRunsPath(dir), "utf-8")) as ActiveRun[];
		return Array.isArray(parsed) ? parsed.filter((run) => typeof run?.run === "string" && run.pid > 0) : [];
	} catch {
		return [];
	}
}

export function saveActiveRuns(dir: string, runs: ActiveRun[]): void {
	ensureOwnerOnlyServerDir(dir);
	writeJsonAtomically(activeRunsPath(dir), runs);
}
