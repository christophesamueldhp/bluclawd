import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const PROC = process.platform === "linux";
const PS_RUNNING_ANSWER_TTL_MS = 1000;
export const PS_TIMEOUT_MS = 2000;
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

const notZombie = (state: string) => !state.startsWith("Z");

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

function psStates(args: string[], id: number): string[] | undefined {
	const listed = spawnSync("ps", args, { encoding: "utf8", timeout: PS_TIMEOUT_MS });
	if (listed.error || listed.signal || listed.stderr) return undefined;
	return listed.stdout.split("\n").flatMap((line) => {
		const [listedId, state] = line.trim().split(/\s+/);
		return state && Number(listedId) === id ? [state] : [];
	});
}

function processStates(pid: number): string[] | undefined {
	if (!PROC) return psStates(["-o", "pid=,stat=", "-p", String(pid)], pid);
	const stat = procStat(pid);
	return stat ? [stat.state] : [];
}

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

function runs(target: number, fresh: boolean, read: () => string[] | undefined): boolean {
	if (!signalled(target)) {
		foundRunning.delete(target);
		return false;
	}
	if (
		!PROC &&
		!fresh &&
		Date.now() - (foundRunning.get(target) ?? Number.NEGATIVE_INFINITY) < PS_RUNNING_ANSWER_TTL_MS
	)
		return true;
	const states = read();
	const unknownCountsAsRunning = states === undefined;
	if (unknownCountsAsRunning || states.some(notZombie)) {
		if (!PROC) foundRunning.set(target, Date.now());
		return true;
	}
	foundRunning.delete(target);
	const onlyZombiesListed = states.length > 0;
	return !onlyZombiesListed && !vanishedMeanwhile(target);
}

const vanishedMeanwhile = (target: number) => !signalled(target);

/**
 * Linux gives it in /proc, in clock ticks since boot. `ps` gives it to the second, in a
 * locale and zone fixed so that a token stored by one process compares with another's reading.
 */
export function processStarted(pid: number): string | undefined {
	if (PROC) {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || undefined;
		} catch {
			return undefined;
		}
	}
	const listed = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf8",
		timeout: PS_TIMEOUT_MS,
		env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
	});
	if (listed.error || listed.signal || listed.status !== 0 || listed.stderr) return undefined;
	return listed.stdout.trim() || undefined;
}

export function processAlive(pid: number): boolean {
	return runs(pid, false, () => processStates(pid));
}

export function processGroupAlive(
	pid: number,
	{ fresh = false, leaderAliveJustChecked }: { fresh?: boolean; leaderAliveJustChecked?: boolean } = {},
): boolean {
	// No pid is given out while a group of that id exists, so a process `pid` that runs is its leader, and it runs.
	if (leaderAliveJustChecked) return signalled(-pid);
	return runs(-pid, fresh, () => {
		if (leaderAliveJustChecked === undefined) {
			const leader = processStates(pid);
			if (!leader || leader.some(notZombie)) return leader;
		}
		return memberStates(pid);
	});
}
