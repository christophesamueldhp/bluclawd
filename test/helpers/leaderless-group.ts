import { spawn } from "node:child_process";
import { onTestFinished } from "vitest";

/**
 * A process group as a Generation whose processes did not all end leaves it: its leader, the host, ended and was
 * reaped, and a process it started still runs. Returns the group's id, the host's pid; the group is killed after the
 * test.
 */
export async function leaderlessGroup(): Promise<number> {
	const leader = spawn("/bin/sh", ["-c", "sleep 60 & exit 0"], { detached: true, stdio: "ignore" });
	const pid = leader.pid;
	if (pid === undefined) throw new Error("the host did not start");
	onTestFinished(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Gone already.
		}
	});
	await new Promise((resolve) => leader.once("exit", resolve));
	return pid;
}
