import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentDaemonBuildId, OrchestratorClient, piPackageRoot } from "../../daemon/orchestrator-client.ts";

export interface BackgroundableSession {
	cwd: string;
	label?: string;
	sessionFile: string;
	sessionId?: string;
	parent?: string;
}

const EXIT_WAIT_MS = 60_000;

export function spawnDetachedRowSaver(outgoing: BackgroundableSession, pid: number = process.pid): void {
	const root = piPackageRoot();
	spawn(process.execPath, [fileURLToPath(import.meta.url), String(pid), JSON.stringify(outgoing)], {
		detached: true,
		stdio: "ignore",
		env: root ? { ...process.env, PI_PACKAGE_ROOT: root } : process.env,
	}).unref();
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function main(pid: number, outgoing: BackgroundableSession): Promise<void> {
	const deadline = Date.now() + EXIT_WAIT_MS;
	while (isAlive(pid)) {
		if (Date.now() > deadline) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	const client = new OrchestratorClient();
	if (!(await client.ensureDaemon())) return;
	const info = await client.getDaemonInfo();
	if (info.buildId !== currentDaemonBuildId()) await client.restartDaemon();
	await client.save(outgoing).catch(() => undefined);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	void main(Number(process.argv[2]), JSON.parse(process.argv[3] ?? "{}") as BackgroundableSession);
}
