/**
 * Handing a foreground session to the daemon so it keeps running in the background.
 *
 * Also a script: pi's exit runs this file detached (`handOffAfterExit`), and it hands the session
 * over once that pi process is gone. It runs outside pi because pi killed by SIGHUP (terminal
 * closed) dies as soon as anything repaints, so it cannot wait on the daemon itself. Imports only
 * node builtins and plain modules, so node runs it without pi's package resolution.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OrchestratorClient, piPackageRoot } from "./orchestrator-client.ts";

/** What the daemon needs to keep a session running in the background. */
export interface BackgroundableSession {
	cwd: string;
	label?: string;
	sessionFile: string;
	model?: { provider: string; id: string };
	/** A turn was in progress: leaving cuts it off, so wherever it goes next carries on. */
	working: boolean;
}

/** What a session whose turn was cut off by a move (window switch, pi exit) resumes with. */
export const CONTINUE_PROMPT =
	"Your previous turn was interrupted when this session was moved or its window closed. Continue where you left off.";

/** How long the helper waits for pi to exit; past this it gives up rather than add a second writer. */
const EXIT_WAIT_MS = 60_000;

/**
 * Hand a session to the daemon, which resumes it from its `.jsonl`: one that was working
 * resumes with {@link CONTINUE_PROMPT} rather than sitting idle.
 */
export async function handOff(
	outgoing: BackgroundableSession | undefined,
	client: Pick<OrchestratorClient, "spawn"> = new OrchestratorClient(),
): Promise<void> {
	if (!outgoing) return;
	try {
		await client.spawn({ ...outgoing, prompt: outgoing.working ? CONTINUE_PROMPT : undefined });
	} catch {
		// Best-effort: with no daemon the outgoing session is still on disk and
		// resumable with /resume; it just is not running in parallel.
	}
}

/** Start the detached helper that hands `outgoing` to the daemon once process `pid` has exited. */
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
	if (await client.ensureDaemon()) await handOff(outgoing, client);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	void main(Number(process.argv[2]), JSON.parse(process.argv[3] ?? "{}") as BackgroundableSession);
}
