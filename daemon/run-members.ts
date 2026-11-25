import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const runMachMarker = (runId: string): string => `bluclawd.run.${runId}`;

export function nativeHelperPath(name: string, agentDir: string): { source: string; path: string } {
	const source = fileURLToPath(new URL(`../ext/sandbox/native/${name}.c`, import.meta.url));
	const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 16);
	return { source, path: join(agentDir, "bluclawd", "reaper", `${name}-${hash}`) };
}
