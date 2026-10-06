/**
 * Handing a foreground session to the daemon so it keeps running in the background.
 *
 * Also a script: pi's exit runs this file detached (`handOffAfterExit`), and once that pi process
 * is gone it keeps the session in agent view — running on if it was working, else as a stopped row. It runs outside pi because pi killed by SIGHUP (terminal
 * closed) dies as soon as anything repaints, so it cannot wait on the daemon itself. Imports only
 * node builtins and plain modules, so node runs it without pi's package resolution.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { currentDaemonBuildId, OrchestratorClient, piPackageRoot } from "./orchestrator-client.ts";
import { CONTINUE_ENV, Tmux } from "./tmux.ts";

/** What the daemon needs to keep a session running in the background. */
export interface BackgroundableSession {
	cwd: string;
	label?: string;
	sessionFile: string;
	model?: { provider: string; id: string };
	/** A turn was in progress: leaving cuts it off, so wherever it goes next carries on. */
	working: boolean;
	/** It ran in a pane (tmux.ts): it carries on in a new pane, not in the daemon. */
	pane?: boolean;
	/** The pi that pane runs ({@link piCommand}): this helper's own argv is not pi's. */
	command?: string[];
}

/** The worker command that carries on a turn cut off by a move (window switch, pi exit). */
export const CONTINUE_COMMAND = "agent-view-continue";

/** What a session whose turn was cut off resumes with: the command, so no prompt shows. */
export const CONTINUE_PROMPT = `/${CONTINUE_COMMAND}`;

/** What the model is told, as a hidden message, when the command runs. */
export const CONTINUE_TEXT =
	"This session moved to the background while your turn was in progress. Continue where you left off; do not repeat work that is already done.";

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
	if (outgoing.pane && outgoing.working) {
		new Tmux().newSession({
			cwd: outgoing.cwd,
			args: ["--session", outgoing.sessionFile],
			env: { [CONTINUE_ENV]: "1" },
			command: outgoing.command,
		});
		return;
	}
	const client = new OrchestratorClient();
	if (!(await client.ensureDaemon())) return;
	// As agent view does on open: an older daemon may not know `save`. Refused while it runs sessions.
	const info = await client.getDaemonInfo();
	if (info.buildId !== currentDaemonBuildId()) await client.restartDaemon();
	if (outgoing.working) await handOff(outgoing, client);
	else await client.save(outgoing).catch(() => undefined);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	void main(Number(process.argv[2]), JSON.parse(process.argv[3] ?? "{}") as BackgroundableSession);
}
