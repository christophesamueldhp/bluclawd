import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const prefsPath = (agentDir: string) => join(agentDir, "bluclawd", "memory.json");

export function loadMemoryEnabled(agentDir: string): boolean {
	try {
		return JSON.parse(readFileSync(prefsPath(agentDir), "utf8"))?.enabled !== false;
	} catch {
		return true;
	}
}

export function saveMemoryEnabled(agentDir: string, enabled: boolean): void {
	mkdirSync(join(agentDir, "bluclawd"), { recursive: true });
	writeFileSync(prefsPath(agentDir), `${JSON.stringify({ enabled })}\n`, "utf8");
}
