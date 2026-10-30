import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getInstancesPath } from "./config.ts";
import { ensureServerDir } from "./paths.ts";
import type { InstanceRecord } from "./types.ts";

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
	// Write-then-rename so a crash mid-write can't leave a half-written instances.json behind.
	const instancesPath = getInstancesPath(dir);
	const tmpPath = `${instancesPath}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(instances, null, 2));
	renameSync(tmpPath, instancesPath);
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
