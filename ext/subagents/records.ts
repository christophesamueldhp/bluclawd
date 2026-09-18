/**
 * Durable run records: one line per finished subagent child, in
 * `<agentDir>/subagents/runs.jsonl` — pi-subagents' missions, reduced to what lets
 * delegated work be recovered later.
 *
 * - A child can be resumed from another process: the in-memory registry only knows
 *   children this process ran; the record knows where the transcript is.
 * - A `mission` label groups runs toward one goal; the roster shows this project's
 *   recent missions so a later session can pick the work up.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface RunRecord {
	agentId: string;
	agent: string;
	sessionFile: string;
	cwd: string;
	task: string;
	status: string;
	stopReason?: string;
	mission?: string;
	forkedAt?: number;
	endedAt: number;
}

/** Records read back; older lines are ignored rather than parsed on every call. */
const READ_LIMIT = 1000;
const TASK_CHARS = 200;

export const recordsPath = (): string => join(getAgentDir(), "subagents", "runs.jsonl");

export function appendRecord(record: RunRecord): void {
	try {
		const path = recordsPath();
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify({ ...record, task: record.task.slice(0, TASK_CHARS) })}\n`);
	} catch {
		// A record that cannot be written costs only cross-process resume.
	}
}

export function readRecords(): RunRecord[] {
	const path = recordsPath();
	if (!existsSync(path)) return [];
	const out: RunRecord[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n").slice(-READ_LIMIT)) {
		try {
			if (line.trim()) out.push(JSON.parse(line) as RunRecord);
		} catch {
			// A torn line is skipped.
		}
	}
	return out;
}

/** The latest record of a child. */
export function findRecord(agentId: string): RunRecord | undefined {
	return readRecords()
		.reverse()
		.find((r) => r.agentId === agentId);
}

/** How far back the roster looks for a project's missions. */
const MISSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MISSIONS = 5;

/** This project's recent missions, for the roster; empty when there are none. */
export function missionsSection(cwd: string, now = Date.now()): string[] {
	const byMission = new Map<string, RunRecord[]>();
	for (const r of readRecords()) {
		if (!r.mission || r.cwd !== cwd || now - r.endedAt > MISSION_WINDOW_MS) continue;
		byMission.set(r.mission, [...(byMission.get(r.mission) ?? []), r]);
	}
	const missions = Array.from(byMission.entries())
		.sort((a, b) => (b[1].at(-1)?.endedAt ?? 0) - (a[1].at(-1)?.endedAt ?? 0))
		.slice(0, MAX_MISSIONS);
	if (missions.length === 0) return [];
	return [
		"Recent missions in this project (task's `mission` label) — resume a child by its agent id:",
		...missions.map(([name, runs]) => {
			const last = runs[runs.length - 1];
			return `- ${name}: ${runs.length} run${runs.length === 1 ? "" : "s"}; latest ${last.agent} ${last.status}, agent id ${last.agentId}`;
		}),
	];
}
