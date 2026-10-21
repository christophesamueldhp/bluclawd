import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { getInstancesPath } from "./config.ts";
import { ensureServerDir } from "./paths.ts";
import type { InstanceRecord } from "./types.ts";

export function loadInstances(): InstanceRecord[] {
	const instancesPath = getInstancesPath();
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

export function saveInstances(instances: InstanceRecord[]): void {
	ensureServerDir();
	// Write-then-rename so a crash mid-write can't leave a half-written instances.json behind.
	const instancesPath = getInstancesPath();
	const tmpPath = `${instancesPath}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(instances, null, 2));
	renameSync(tmpPath, instancesPath);
}

export function getInstance(instanceId: string): InstanceRecord | undefined {
	return loadInstances().find((instance) => instance.id === instanceId);
}

export function upsertInstance(instance: InstanceRecord): void {
	const instances = loadInstances();
	const index = instances.findIndex((existing) => existing.id === instance.id);
	if (index === -1) {
		instances.push(instance);
		saveInstances(instances);
		return;
	}

	instances[index] = instance;
	saveInstances(instances);
}

export function removeInstance(instanceId: string): void {
	const instances = loadInstances().filter((instance) => instance.id !== instanceId);
	saveInstances(instances);
}
