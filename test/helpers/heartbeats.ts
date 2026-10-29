import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Heartbeat = { identity: string; pid: number; ppid: number; sequence: number };

const descendants = fileURLToPath(new URL("../fixtures/subagent-writer/descendants.mjs", import.meta.url));
const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

/** How long a test waits for a fixture descendant's first beat: under parallel load, its startup takes 20s and more (#76). */
export const readinessMs = 30_000;

/** The heartbeats `fixtures/subagent-writer/descendants.mjs` has written so far, skipping a half-written line. */
export function readHeartbeats(path: string): Heartbeat[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Heartbeat];
			} catch {
				return [];
			}
		});
}

/** The shell command running the fixture in `mode`, its descendants beating into `path` for `lifetimeMs`. */
export function descendantCommand(mode: string, path: string, identity: string, lifetimeMs: number): string {
	return [process.execPath, descendants, mode, path, identity, String(lifetimeMs)].map(quote).join(" ");
}

/** `command` in the background, the shell returning once its descendant beats: leaving the descendant behind. */
export function leavingBehind(command: string, path: string): string {
	return `${command} & for _ in {1..${readinessMs / 10}}; do [ -s ${quote(path)} ] && break; sleep 0.01; done`;
}

/** Whether anything had beaten into `path` by now, and the beats written over the next 150ms. */
export async function beatsFromNow(path: string): Promise<{ started: boolean; stillWriting: Heartbeat[] }> {
	const atNow = readHeartbeats(path).at(-1)?.sequence ?? 0;
	await new Promise((resolve) => setTimeout(resolve, 150));
	return { started: atNow > 0, stillWriting: readHeartbeats(path).filter((beat) => beat.sequence > atNow) };
}
