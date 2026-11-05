import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentActivity } from "../../daemon/activity.ts";
import { focusedComponent } from "../_shared/focus.ts";
import { formatTaskDuration } from "../background-bash/bash-limits.ts";
import type { RunEntry } from "./directory.ts";
import { isTerminalSubagentStatus } from "./runs.ts";
import { canStop } from "./views.ts";

export const SUBAGENT_PANEL_WIDGET = "subagents:panel";
const MAX_ROWS = 5;

/** How long a run has been going, or went on for once it ended. */
export function formatRunElapsed(run: RunEntry["record"], now: number): string {
	return formatTaskDuration(Math.max(0, (run.endedAt ?? now) - (run.startedAt ?? run.admittedAt)));
}

/** The panel's lines: a title, then one row per run up to five, then how many more `/tasks` has. */
export function renderPanel(options: {
	runs: readonly RunEntry[];
	/** How many background runs the orchestrator is Waiting for; zero while it is not Waiting. */
	waitingFor: number;
	now: number;
	width: number;
	theme: Theme;
	/** The row the keyboard is on, while the panel has focus. */
	selected?: number;
}): string[] {
	const { runs, waitingFor, now, width, theme, selected } = options;
	if (runs.length === 0) return [];
	const title =
		waitingFor > 0
			? `Subagents · ${theme.fg("warning", `waiting for ${waitingFor} subagent${waitingFor === 1 ? "" : "s"}`)}`
			: "Subagents";
	const rows = runs.slice(0, MAX_ROWS).map(({ record: run }, index) => {
		// A run in a pi of its own says what it is doing while it is open.
		const status = run.pane && run.status === "running" ? ACTIVITY_LABEL[run.activity ?? "working"] : run.status;
		const progress = run.lastProgressText?.replace(/\s+/g, " ").trim();
		return [
			`${index === selected ? theme.fg("accent", "❯") : " "} ${theme.bold(run.name ?? run.runId)}`,
			run.agentName,
			theme.fg("dim", `${run.provider}/${run.modelId}`),
			theme.fg(statusColor(status), status),
			formatRunElapsed(run, now),
			...(progress ? [theme.fg("dim", progress)] : []),
		].join("  ");
	});
	const more = runs.length > MAX_ROWS ? [theme.fg("dim", `  +${runs.length - MAX_ROWS} more · /tasks`)] : [];
	const current = selected === undefined ? undefined : runs[selected];
	const hint = current
		? [
				theme.fg(
					"dim",
					`  ↑/↓ to select · x to ${isTerminalSubagentStatus(current.record.status) ? "dismiss" : current.record.pane ? "close" : "stop"} · Esc to go back`,
				),
			]
		: [];
	return [theme.fg("accent", title), ...rows, ...more, ...hint].map((line) => truncateToWidth(line, width));
}

/** What the keys on a focused panel row do. */
export interface PanelActions {
	/** `x` on a run that has not ended. */
	stop(run: RunEntry): void;
	/** `x` on a run that has ended. */
	dismiss(run: RunEntry): void;
	/** Enter on a row. */
	open?(run: RunEntry): void;
}

/**
 * The panel as a TUI component that can take the keyboard from the prompt: ↑/↓ pick a row, `x` stops or
 * dismisses it, Enter opens it, Esc gives the keyboard back. Any other key goes back to the prompt with it.
 * Under pistatusline it renders nothing itself: its `lines` go out as a status, which pistatusline draws below
 * the status line, and `changed` republishes them whenever the selection or the focus moves.
 */
export function createPanel(options: {
	tui: TUI;
	theme: Theme;
	runs: () => RunEntry[];
	waitingFor: () => number;
	now: () => number;
	actions: PanelActions;
	/** Whether the panel draws its lines below the prompt itself, as under pi's own footer. */
	belowPrompt: boolean;
	/** Called after the selection or the focus moved. */
	changed: () => void;
}) {
	const { tui, theme, actions } = options;
	// The selection follows its run; `at` is where it last was, for the nearest row once that run leaves.
	let selectedId: string | undefined;
	let at = 0;
	let returnTo: Component | null = null;
	const rows = () => options.runs().slice(0, MAX_ROWS);
	/** The selected row's index in `shown`, moved to the nearest row when the selected run has left. */
	const selectedIn = (shown: readonly RunEntry[]) => {
		const index = shown.findIndex((run) => run.record.runId === selectedId);
		at = index >= 0 ? index : Math.max(0, Math.min(at, shown.length - 1));
		selectedId = shown[at]?.record.runId;
		return at;
	};
	const select = (shown: readonly RunEntry[], index: number) => {
		at = index;
		selectedId = shown[index]?.record.runId;
	};
	const release = () => {
		if (panel.focused) tui.setFocus(returnTo);
	};
	const panel: Component &
		Focusable & {
			/** Takes the keyboard on the first row; false when there is no row to take it to. */
			focus(): boolean;
			/** Gives the keyboard back once the panel has no rows left. */
			sync(): void;
			/** What the panel shows, the focused row marked; none while it has no rows. */
			lines(width: number): string[];
		} = {
		focused: false,
		focus() {
			const shown = rows();
			if (shown.length === 0) return false;
			returnTo = focusedComponent(tui) ?? null;
			select(shown, 0);
			tui.setFocus(panel);
			options.changed();
			return true;
		},
		sync() {
			if (panel.focused && rows().length === 0) release();
		},
		handleInput(data) {
			const shown = rows();
			const selected = selectedIn(shown);
			const run = shown[selected];
			if (!run) {
				release();
				returnTo?.handleInput?.(data);
			} else if (matchesKey(data, "up")) select(shown, Math.max(0, selected - 1));
			else if (matchesKey(data, "down")) select(shown, Math.min(shown.length - 1, selected + 1));
			else if (matchesKey(data, "escape")) release();
			else if (matchesKey(data, "enter")) actions.open?.(run);
			else if (data === "x") {
				if (isTerminalSubagentStatus(run.record.status)) actions.dismiss(run);
				else if (canStop(run)) actions.stop(run);
				panel.sync();
			} else {
				release();
				returnTo?.handleInput?.(data);
			}
			options.changed();
		},
		render: (width) => (options.belowPrompt ? panel.lines(width) : []),
		lines: (width) => {
			const runs = options.runs();
			return renderPanel({
				runs,
				waitingFor: options.waitingFor(),
				now: options.now(),
				width,
				theme,
				selected: panel.focused ? selectedIn(runs.slice(0, MAX_ROWS)) : undefined,
			});
		},
		invalidate: () => {},
	};
	return panel;
}

const ACTIVITY_LABEL: Record<AgentActivity, string> = {
	working: "working",
	idle: "idle",
	awaiting_input: "needs input",
};

function statusColor(status: string) {
	if (status === "completed") return "success";
	if (status === "needs input") return "warning";
	if (status === "failed" || status === "interrupted" || status === "cancelled") return "error";
	return "muted";
}
