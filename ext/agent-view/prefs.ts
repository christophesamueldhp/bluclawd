import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ViewMode } from "./rows.ts";

const PREFS_FILE = "agent-view-prefs.json";

/** The saved ctrl+s view (Claude Code's `fleetViewGroupMode`), or undefined when none is saved. */
export function loadViewMode(agentDir: string): ViewMode | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(agentDir, PREFS_FILE), "utf8")) as { view?: unknown };
		return parsed.view === "state" || parsed.view === "directory" ? parsed.view : undefined;
	} catch {
		return undefined;
	}
}

export function saveViewMode(agentDir: string, view: ViewMode): void {
	try {
		writeFileSync(join(agentDir, PREFS_FILE), JSON.stringify({ view }), "utf8");
	} catch {
		// best-effort; the choice just does not survive this session
	}
}
