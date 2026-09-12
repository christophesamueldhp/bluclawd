import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How the roster is grouped: by project path (default) or by Running / Saved status. */
export type Grouping = "path" | "status";

const PREFS_FILE = "fleet-prefs.json";

/** The saved grouping choice, or undefined when none has been saved (or the file is unreadable). */
export function loadGrouping(agentDir: string): Grouping | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(agentDir, PREFS_FILE), "utf8")) as { grouping?: unknown };
		return parsed.grouping === "path" || parsed.grouping === "status" ? parsed.grouping : undefined;
	} catch {
		return undefined;
	}
}

export function saveGrouping(agentDir: string, grouping: Grouping): void {
	try {
		writeFileSync(join(agentDir, PREFS_FILE), JSON.stringify({ grouping }), "utf8");
	} catch {
		// best-effort; the choice just does not survive this session
	}
}
