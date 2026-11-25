import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runMachMarker } from "./run-members.ts";

const END_WAIT_MS = 10_000;

interface Listed {
	pid: number;
	parent: number;
	zombie: boolean;
}

function listed(): Listed[] {
	return readdirSync("/proc").flatMap((entry) => {
		if (!/^\d+$/.test(entry)) return [];
		try {
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
			const [state, parent] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			return [{ pid: Number(entry), parent: Number(parent), zombie: state === "Z" }];
		} catch {
			return [];
		}
	});
}

/**
 * The bubblewrap srt started for one of the run's commands: in this process's PID namespace, which no sandboxed
 * process is, and binding the run's own temp directory, which only a run's shell names.
 */
function startsRunSandbox(pid: number, namespace: string, runTmp: string): boolean {
	try {
		if (readlinkSync(`/proc/${pid}/ns/pid`) !== namespace) return false;
		if (basename(readlinkSync(`/proc/${pid}/exe`)) !== "bwrap") return false;
		const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
		return args.some((arg, i) => arg === "--bind" && args[i + 1]?.endsWith(runTmp));
	} catch {
		return false;
	}
}

/**
 * Every live process of the run `marker` names: its commands' bubblewraps and all under them. A command runs in
 * PID namespaces of their own, whose orphans stay under them however they detach. Throws when /proc cannot be read.
 */
export function linuxRunMembers(marker: string): number[] {
	const prefix = runMachMarker("");
	if (!marker.startsWith(prefix)) throw new Error(`${marker} names no run`);
	const runTmp = `/bluclawd/run-tmp/${marker.slice(prefix.length)}`;
	const namespace = readlinkSync("/proc/self/ns/pid");
	const all = listed();
	const children = new Map<number, Listed[]>();
	for (const item of all) children.set(item.parent, [...(children.get(item.parent) ?? []), item]);
	const found = all.filter((item) => startsRunSandbox(item.pid, namespace, runTmp));
	for (let i = 0; i < found.length; i++) found.push(...(children.get(found[i].pid) ?? []));
	return found.filter((item) => !item.zombie).map((item) => item.pid);
}

export async function endLinuxRun(marker: string): Promise<boolean> {
	const deadline = Date.now() + END_WAIT_MS;
	for (;;) {
		let members: number[];
		try {
			members = linuxRunMembers(marker);
		} catch {
			return false;
		}
		if (members.length === 0) return true;
		if (Date.now() > deadline) return false;
		for (const pid of members) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		await sleep(50);
	}
}
