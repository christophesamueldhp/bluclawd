/**
 * Keeping a session in agent view after its pi quits (`/quit`, an exit word), as a stopped row.
 *
 * A script: pi's exit runs this file detached (`handOffAfterExit`), and once that pi process is
 * gone it saves the row — the .jsonl must have its final writes first. It runs outside pi because pi killed by SIGHUP (terminal
 * closed) dies as soon as anything repaints, so it cannot wait on the daemon itself. Imports only
 * node builtins and plain modules, so node runs it without pi's package resolution.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentDaemonBuildId, OrchestratorClient, piPackageRoot } from "./orchestrator-client.ts";

/** What it takes to keep a session in agent view once its pi has quit. */
export interface BackgroundableSession {
	cwd: string;
	label?: string;
	sessionFile: string;
}

/** How long the helper waits for pi to exit; past this it gives up rather than add a second writer. */
const EXIT_WAIT_MS = 60_000;

/** Start the detached helper that keeps `outgoing` in agent view once process `pid` has exited. */
export function handOffAfterExit(outgoing: BackgroundableSession, pid: number = process.pid): void {
	// The helper's argv[1] is this file, not pi's entry, so pi's package root is resolved here.
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
	// As agent view does on open: an older daemon may not know `save`. Refused while it runs sessions.
	const info = await client.getDaemonInfo();
	if (info.buildId !== currentDaemonBuildId()) await client.restartDaemon();
	await client.save(outgoing).catch(() => undefined);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	void main(Number(process.argv[2]), JSON.parse(process.argv[3] ?? "{}") as BackgroundableSession);
}
