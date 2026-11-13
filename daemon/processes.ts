/**
 * Probes of processes by pid: signal 0 is never delivered, only checked, so the probe ends nothing. A zombie, which
 * has ended but which its parent has not reaped yet, answers signal 0 too: `ps` tells it apart, and it counts as ended.
 */

import { spawnSync } from "node:child_process";

/** Whether signal 0 reaches `target`, a pid or a negated group id. EPERM says it does, to another user's. */
function signalled(target: number): boolean {
	try {
		process.kill(target, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Whether `ps`, given `args` that list an id and a state per process, lists one of id `id` that is no zombie. */
function listsLive(args: string[], id: number): boolean {
	const listed = spawnSync("ps", args, { encoding: "utf8" });
	// No clean answer says nothing ended, and taking it for ended would free what may still run.
	if (listed.error || listed.signal || listed.stderr) return true;
	return listed.stdout.split("\n").some((line) => {
		const [listedId, state] = line.trim().split(/\s+/);
		return state !== undefined && Number(listedId) === id && !state.startsWith("Z");
	});
}

/** Whether process `pid` runs: it exists, maybe another user's, and is no zombie. */
export function processAlive(pid: number): boolean {
	return signalled(pid) && listsLive(["-o", "pid=,stat=", "-p", String(pid)], pid);
}

/**
 * Whether any process of the group `pid` leads still runs. The daemon starts a run's host leading a group of its own,
 * which its pi and what the pi starts join.
 */
export function processGroupAlive(pid: number): boolean {
	if (!signalled(-pid)) return false;
	// No pid is given out while a group of that id exists, so a process `pid` is its leader. Only once the leader is
	// gone or a zombie is every process listed, which costs more.
	return processAlive(pid) || listsLive(["-A", "-o", "pgid=,stat="], pid);
}
