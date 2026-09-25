/**
 * Claude Code's resume scan for background shells (2.1.281, `qr`): a shell the
 * conversation started but never heard the end of did not finish before the
 * previous session ended, and the model is told so without a turn being started
 * for it. The session log is where the start and the end are recorded: job state
 * itself is never persisted (a dead process must not be resurrected).
 */

import {
	escapeXml,
	notificationContent,
	type OutgoingMessage,
	TASK_EXIT_MESSAGE_TYPE,
	type TaskExitDetails,
	taskNotification,
} from "./monitor-events.ts";

export const SHELL_START_ENTRY = "bluclawd:bg-shell";
export const SHELL_END_ENTRY = "bluclawd:bg-shell-end";

export interface ShellStartRecord {
	taskId: string;
	toolUseId?: string;
	description: string;
	command: string;
	outputFile?: string;
}

export interface ShellEndRecord {
	taskId: string;
}

/** The aggregate notice names at most this many ids (`Le`). */
const MAX_LISTED = 20;
/** Prefix of the aggregate's marker ids, which are not tasks (`Ne`). */
const MARKER = "__orphan_summary";

type Entry = { type: string; customType?: string; data?: unknown };

/** Shells started in `entries` with no end recorded; `alive` ones are still running here and are not orphans. */
export function findOrphanShells(
	entries: readonly Entry[],
	alive: (taskId: string) => boolean,
): { orphans: ShellStartRecord[]; live: string[] } {
	const ended = new Set<string>();
	const started: ShellStartRecord[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		if (entry.customType === SHELL_END_ENTRY) ended.add((entry.data as ShellEndRecord).taskId);
		else if (entry.customType === SHELL_START_ENTRY) started.push(entry.data as ShellStartRecord);
	}
	const orphans: ShellStartRecord[] = [];
	const live: string[] = [];
	for (const record of started) {
		if (ended.has(record.taskId)) continue;
		if (alive(record.taskId)) live.push(record.taskId);
		else orphans.push(record);
	}
	return { orphans, live };
}

const SINGLE_NOTE =
	"No completion record was found for it in the previous session. It may have been stopped (via the UI, Monitor timeout, or agent teardown — these leave no transcript marker), or it may have been running when the previous Claude Code process exited. Check the output file for partial results before assuming it completed.";

/** The notice for the orphans: one of its own for a single shell, one aggregate for more. */
export function orphanShellMessage(
	orphans: readonly ShellStartRecord[],
	live: readonly string[],
): OutgoingMessage<TaskExitDetails> | undefined {
	if (orphans.length === 0) return undefined;
	const first = orphans[0];
	if (orphans.length === 1) {
		const summary = "Background shell command didn't finish before the previous session ended";
		return {
			customType: TASK_EXIT_MESSAGE_TYPE,
			content: notificationContent(
				taskNotification({
					taskId: first.taskId,
					toolUseId: first.toolUseId,
					status: "stopped",
					summary,
					body: `\n<note>${SINGLE_NOTE}</note>`,
				}),
			),
			display: true,
			details: {
				id: first.taskId,
				description: first.description,
				command: first.command,
				end: summary,
				outputFile: first.outputFile,
				state: "stopped",
			},
		};
	}
	const listed = orphans.slice(0, MAX_LISTED).map((o) => escapeXml(o.taskId));
	const ids = [...listed, `${MARKER}__:shell`, ...live.map((id) => `${MARKER}_live__:${escapeXml(id)}`)]
		.map((id) => `<task-id>${id}</task-id>`)
		.join("\n");
	const which =
		listed.length === orphans.length
			? `Task ids: ${listed.join(", ")}.`
			: `First ${MAX_LISTED} task ids: ${listed.join(", ")}.`;
	const summary = `${orphans.length} background shell command tasks didn't finish before the previous session ended`;
	const note = `No completion record was found for them in the previous session. They may have been stopped (via the UI, Monitor timeout, or agent teardown — these leave no transcript marker), or they may have been running when the previous Claude Code process exited. They have been marked stopped. Task ids in this notification beginning with "${MARKER}" are internal scan markers, not tasks.`;
	return {
		customType: TASK_EXIT_MESSAGE_TYPE,
		content: notificationContent(
			`<task-notification>\n${ids}\n<status>stopped</status>\n<summary>${summary}. ${which}</summary>\n<note>${note}</note>\n</task-notification>`,
		),
		display: true,
		details: {
			id: first.taskId,
			description: `${orphans.length} background shell commands`,
			command: "",
			end: summary,
			state: "stopped",
		},
	};
}
