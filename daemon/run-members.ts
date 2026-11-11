/**
 * What finds the processes of a run with a shell (ext/sandbox/run-containment.ts), as the orchestrator and the daemon
 * both name it: the daemon, which loads none of pi, ends what a run's commands left running once its host is gone,
 * with the helper built in its own agent dir, never one a client names.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The Mach name a run's profile allows; nothing registers it, so allowing it reaches nothing. */
export const runMarker = (runId: string): string => `bluclawd.run.${runId}`;

/** `ext/sandbox/native/<name>.c`, and where it is built in `agentDir`: named by its source's hash, so an edit builds anew. */
export function nativeHelperPath(name: string, agentDir: string): { source: string; path: string } {
	const source = fileURLToPath(new URL(`../ext/sandbox/native/${name}.c`, import.meta.url));
	const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
	return { source, path: join(agentDir, "bluclawd", "reaper", `${name}-${hash}`) };
}
