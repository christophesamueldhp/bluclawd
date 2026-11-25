import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Heartbeat = { identity: string; pid: number; ppid: number; sequence: number };

const descendants = fileURLToPath(new URL("../fixtures/subagent-writer/descendants.mjs", import.meta.url));
const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;

export const readinessMs = Number(process.env.READINESS_MS) || 30_000;

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

export function descendantCommand(mode: string, path: string, identity: string, lifetimeMs: number): string {
	return [process.execPath, descendants, mode, path, identity, String(lifetimeMs)].map(quote).join(" ");
}

export function leavingBehind(command: string, path: string): string {
	return `${command} & for _ in {1..${Math.ceil(readinessMs / 10)}}; do [ -s ${quote(path)} ] && break; sleep 0.01; done`;
}

export async function beatsFromNow(path: string): Promise<{ started: boolean; stillWriting: Heartbeat[] }> {
	const atNow = readHeartbeats(path).at(-1)?.sequence ?? 0;
	await new Promise((resolve) => setTimeout(resolve, 150));
	return { started: atNow > 0, stillWriting: readHeartbeats(path).filter((beat) => beat.sequence > atNow) };
}
