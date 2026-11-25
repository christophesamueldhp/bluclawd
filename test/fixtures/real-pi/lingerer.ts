import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default function lingerer(): void {
	const pidFile = join(process.cwd(), "lingerer.pid");
	const child = spawn(
		process.execPath,
		["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);", pidFile],
		{ stdio: "ignore" },
	);
	child.unref();
	writeFileSync(pidFile, String(child.pid));
}
