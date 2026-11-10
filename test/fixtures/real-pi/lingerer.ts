/**
 * A run's pi that leaves a process behind in its process group (test/subagent-rpc-stop.test.ts): started as the pi
 * starts, it ignores SIGTERM and outlives the pi, its pid in `lingerer.pid` in the pi's directory.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default function lingerer(): void {
	const pidFile = join(process.cwd(), "lingerer.pid");
	// The pid file on its command line: the test's sweep of its own processes finds it by its directory.
	const child = spawn(
		process.execPath,
		["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", pidFile],
		{ stdio: "ignore" },
	);
	child.unref();
	writeFileSync(pidFile, String(child.pid));
}
