import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { getInstancesPath, getMachinePath, getServerDir } from "./config.ts";
import type { InstanceRecord, MachineRecord } from "./types.ts";

function ensureServerDir(): void {
	const serverDir = getServerDir();
	if (!existsSync(serverDir)) {
		// 0700: the socket here is an unauthenticated control channel that can spawn agents and
		// drive tool-running RPCs — keep it owner-only. (Local-trust model; see the socket server.)
		mkdirSync(serverDir, { recursive: true, mode: 0o700 });
	}
}

export function loadMachine(): MachineRecord | undefined {
	const machinePath = getMachinePath();
	if (!existsSync(machinePath)) {
		return undefined;
	}

	const data = readFileSync(machinePath, "utf-8");
	return JSON.parse(data) as MachineRecord;
}

export function saveMachine(machine: MachineRecord): void {
	ensureServerDir();
	writeFileSync(getMachinePath(), JSON.stringify(machine, null, 2));
}

export function deleteMachine(): void {
	const machinePath = getMachinePath();
	if (!existsSync(machinePath)) {
		return;
	}
	rmSync(machinePath);
}

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
		// A corrupt/half-written instances.json must not throw out of every daemon op (list/spawn/
		// stop) or brick recoverAfterRestart at startup. Treat it as empty and let it be rewritten.
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
