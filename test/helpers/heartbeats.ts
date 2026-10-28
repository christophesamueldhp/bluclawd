import { existsSync, readFileSync } from "node:fs";

export type Heartbeat = { identity: string; pid: number; ppid: number; sequence: number };

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
