/**
 * Probes of processes by pid: signal 0 is never delivered, only checked, so the probe ends nothing. A zombie, which
 * has ended but which its parent has not reaped yet, answers signal 0 too: its state tells it apart, and it counts as
 * ended. Linux gives the state in /proc, cheaply. Elsewhere `ps` gives it, and since callers poll every 100 ms, it is
 * asked at most once a second about a process or group it found running.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const PROC = process.platform === "linux";
/** How long `ps` finding a process or group running stands. */
const PS_ANSWER_MS = 1000;
/** When `ps` last found each pid, or each group by its negated id, running. */
const foundRunning = new Map<number, number>();

/** Whether signal 0 reaches `target`, a pid or a negated group id. EPERM says it does, to another user's. */
function signalled(target: number): boolean {
	try {
		process.kill(target, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const live = (state: string) => !state.startsWith("Z");

/** The state and group of process `pid`, from /proc; none once it is gone, or when it cannot be read. */
function procStat(pid: number | string): { state: string; group: number } | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// After the command name, in parentheses it may itself hold: the state, the parent's pid, then the group.
		const [state, , group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return { state, group: Number(group) };
	} catch {
		return undefined;
	}
}

/** The states `ps` lists for id `id`, given `args` that list an id and a state each; unknown on no clean answer. */
function psStates(args: string[], id: number): string[] | undefined {
	// Bounded: a `ps` stuck on a process would block the daemon or pi.
	const listed = spawnSync("ps", args, { encoding: "utf8", timeout: 2000 });
	if (listed.error || listed.signal || listed.stderr) return undefined;
	return listed.stdout.split("\n").flatMap((line) => {
		const [listedId, state] = line.trim().split(/\s+/);
		return state && Number(listedId) === id ? [state] : [];
	});
}

/** The state of process `pid`, as a list of it or of none. */
function processStates(pid: number): string[] | undefined {
	if (!PROC) return psStates(["-o", "pid=,stat=", "-p", String(pid)], pid);
	const stat = procStat(pid);
	return stat ? [stat.state] : [];
}

/** The states of the members of group `pid`, read from every process. */
function memberStates(pid: number): string[] | undefined {
	if (!PROC) return psStates(["-A", "-o", "pgid=,stat="], pid);
	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return undefined;
	}
	return entries.flatMap((entry) => {
		if (!/^\d+$/.test(entry)) return [];
		const stat = procStat(entry);
		return stat?.group === pid ? [stat.state] : [];
	});
}

/**
 * Whether `target`, a pid or a negated group id, runs, as the states `read` gives say once signal 0 reaches it. No
 * states known counts as running: taking it for ended would free what may still run.
 */
function runs(target: number, fresh: boolean, read: () => string[] | undefined): boolean {
	if (!signalled(target)) {
		foundRunning.delete(target);
		return false;
	}
	if (!PROC && !fresh && Date.now() - (foundRunning.get(target) ?? Number.NEGATIVE_INFINITY) < PS_ANSWER_MS)
		return true;
	const states = read();
	if (states === undefined || states.some(live)) {
		if (!PROC) foundRunning.set(target, Date.now());
		return true;
	}
	foundRunning.delete(target);
	// Only zombies seen: ended. None seen though signal 0 reached it, as of a process gone meanwhile or hidden from this
	// user: ended only once signal 0 no longer reaches it.
	return states.length === 0 && signalled(target);
}

/** Whether process `pid` runs: it exists, maybe another user's, and is no zombie. */
export function processAlive(pid: number): boolean {
	return runs(pid, false, () => processStates(pid));
}

/**
 * Whether any process of the group `pid` leads still runs. The daemon starts a run's host leading a group of its own,
 * which its pi and what the pi starts join. `fresh` asks `ps` again even within the second; `leaderRuns` is what
 * {@link processAlive} just said of `pid`, so it is not asked again.
 */
export function processGroupAlive(
	pid: number,
	{ fresh = false, leaderRuns }: { fresh?: boolean; leaderRuns?: boolean } = {},
): boolean {
	// No pid is given out while a group of that id exists, so a process `pid` that runs is its leader, and it runs.
	if (leaderRuns) return signalled(-pid);
	return runs(-pid, fresh, () => {
		if (leaderRuns === undefined) {
			const leader = processStates(pid);
			// Only once the leader is gone or a zombie is every process read, which costs more.
			if (!leader || leader.some(live)) return leader;
		}
		return memberStates(pid);
	});
}
