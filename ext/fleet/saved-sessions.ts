import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstanceSummary } from "./orchestrator-client.ts";

/** The subset of SessionManager.SessionInfo we need — structural, so SessionInfo satisfies it
 *  without importing the heavy session-manager module into this file. */
export interface SavedSessionInfo {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
}

/** Render a persisted (on-disk) session as a FleetView row. `saved:` id namespace keeps it distinct
 *  from live daemon instance ids; status "stopped" makes it render as a resumable/Done row. */
export function sessionInfoToSummary(info: SavedSessionInfo): InstanceSummary {
	return {
		id: `saved:${info.id}`,
		status: "stopped",
		cwd: info.cwd,
		label: info.name || info.firstMessage.slice(0, 60) || info.id,
		sessionId: info.id,
		sessionFile: info.path,
		createdAt: info.created.toISOString(),
		lastSeenAt: info.modified.toISOString(),
	};
}

const HIDDEN_FILE = "fleet-hidden-sessions.json";

/** Session files the user has "deleted" from FleetView. The .jsonl stays on disk (recoverable via
 *  /resume) — delete only hides it from the agent view. */
export function loadHiddenSessions(agentDir: string): Set<string> {
	try {
		const parsed = JSON.parse(readFileSync(join(agentDir, HIDDEN_FILE), "utf8")) as unknown;
		return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === "string")) : new Set();
	} catch {
		return new Set();
	}
}

export function hideSession(agentDir: string, sessionFile: string): void {
	const hidden = loadHiddenSessions(agentDir);
	hidden.add(sessionFile);
	try {
		writeFileSync(join(agentDir, HIDDEN_FILE), JSON.stringify([...hidden]), "utf8");
	} catch {
		// best-effort; a failed hide just means the row reappears next open
	}
}

/** Map persisted sessions into FleetView rows: drop empty + hidden (and, when a `keepCwd` predicate
 *  is given, sessions whose working dir shouldn't be listed — gone or ephemeral temp dirs), newest
 *  first, capped. */
export function toSavedSummaries(
	infos: SavedSessionInfo[],
	hidden: Set<string>,
	cap = 40,
	keepCwd?: (cwd: string) => boolean,
): InstanceSummary[] {
	return infos
		.filter((info) => {
			if (info.messageCount === 0 || hidden.has(info.path)) return false;
			// Drop sessions the caller says not to keep — dead dirs (deleted temp/projects) and
			// ephemeral temp roots (old test/runtime sessions) that would otherwise flood the list.
			if (keepCwd && (info.cwd === "" || !keepCwd(info.cwd))) return false;
			return true;
		})
		.sort((a, b) => b.modified.getTime() - a.modified.getTime())
		.slice(0, cap)
		.map(sessionInfoToSummary);
}
