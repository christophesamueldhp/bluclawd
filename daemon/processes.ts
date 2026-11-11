/** Probes of processes by pid: signal 0 is never delivered, only checked, so the probe ends nothing. */

/** Whether process `pid` exists. EPERM says one does, of another user. */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Whether any process of the group `pid` leads still runs. The daemon starts a run's host leading a group of its own,
 * which its pi and what the pi starts join.
 */
export function processGroupAlive(pid: number): boolean {
	return processAlive(-pid);
}
