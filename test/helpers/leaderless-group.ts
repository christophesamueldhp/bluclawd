import { spawn } from "node:child_process";
import { onTestFinished } from "vitest";

export function sigkillIfAlive(pid: number): boolean {
	try {
		process.kill(pid, "SIGKILL");
		return true;
	} catch {
		return false;
	}
}

export async function leaderlessGroup(): Promise<number> {
	const leader = spawn("/bin/sh", ["-c", "sleep 60 & exit 0"], { detached: true, stdio: "ignore" });
	const pid = leader.pid;
	if (pid === undefined) throw new Error("the host did not start");
	onTestFinished(() => {
		sigkillIfAlive(-pid);
	});
	await new Promise((resolve) => leader.once("exit", resolve));
	return pid;
}
