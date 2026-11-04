import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatTaskDuration } from "../background-bash/bash-limits.ts";
import type { RunEntry } from "./directory.ts";

export const SUBAGENT_PANEL_WIDGET = "subagents:panel";
const MAX_ROWS = 5;
/** How long a run that succeeded stays in the panel after it ends. */
export const SUCCEEDED_RUN_LINGER_MS = 30_000;

/** Whether the panel still shows a run: one that succeeded leaves after a while, any other final run stays. */
export function shownInPanel({ record }: RunEntry, now: number): boolean {
	return record.status !== "completed" || now - (record.endedAt ?? now) < SUCCEEDED_RUN_LINGER_MS;
}

/** The panel's lines: a title, then one row per run up to five, then how many more `/tasks` has. */
export function renderPanel(options: {
	runs: readonly RunEntry[];
	/** How many background runs the orchestrator is Waiting for; zero while it is not Waiting. */
	waitingFor: number;
	now: number;
	width: number;
	theme: Theme;
}): string[] {
	const { runs, waitingFor, now, width, theme } = options;
	if (runs.length === 0) return [];
	const title =
		waitingFor > 0
			? `Subagents · ${theme.fg("warning", `waiting for ${waitingFor} subagent${waitingFor === 1 ? "" : "s"}`)}`
			: "Subagents";
	const rows = runs.slice(0, MAX_ROWS).map(({ record: run, state }) => {
		const status = state === "finishing" ? state : run.status;
		const progress = run.lastProgressText?.replace(/\s+/g, " ").trim();
		return [
			`  ${theme.bold(run.name ?? run.runId)}`,
			run.agentName,
			theme.fg("dim", `${run.provider}/${run.modelId}`),
			theme.fg(statusColor(status), status),
			formatTaskDuration(Math.max(0, (run.endedAt ?? now) - (run.startedAt ?? run.admittedAt))),
			...(progress ? [theme.fg("dim", progress)] : []),
		].join("  ");
	});
	const more = runs.length > MAX_ROWS ? [theme.fg("dim", `  +${runs.length - MAX_ROWS} more · /tasks`)] : [];
	return [theme.fg("accent", title), ...rows, ...more].map((line) => truncateToWidth(line, width));
}

function statusColor(status: string) {
	if (status === "completed") return "success";
	if (status === "failed" || status === "interrupted" || status === "cancelled") return "error";
	return "muted";
}
