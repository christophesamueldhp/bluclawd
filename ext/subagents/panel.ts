import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { formatTaskDuration } from "../background-bash/bash-limits.ts";
import type { RunEntry } from "./directory.ts";
import { isTerminalSubagentStatus } from "./runs.ts";

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
	/** The row the keyboard is on, while the panel has focus. */
	selected?: number;
}): string[] {
	const { runs, waitingFor, now, width, theme, selected } = options;
	if (runs.length === 0) return [];
	const title =
		waitingFor > 0
			? `Subagents · ${theme.fg("warning", `waiting for ${waitingFor} subagent${waitingFor === 1 ? "" : "s"}`)}`
			: "Subagents";
	const rows = runs.slice(0, MAX_ROWS).map(({ record: run, state }, index) => {
		const status = state === "finishing" ? state : run.status;
		const progress = run.lastProgressText?.replace(/\s+/g, " ").trim();
		return [
			`${index === selected ? theme.fg("accent", "❯") : " "} ${theme.bold(run.name ?? run.runId)}`,
			run.agentName,
			theme.fg("dim", `${run.provider}/${run.modelId}`),
			theme.fg(statusColor(status), status),
			formatTaskDuration(Math.max(0, (run.endedAt ?? now) - (run.startedAt ?? run.admittedAt))),
			...(progress ? [theme.fg("dim", progress)] : []),
		].join("  ");
	});
	const more = runs.length > MAX_ROWS ? [theme.fg("dim", `  +${runs.length - MAX_ROWS} more · /tasks`)] : [];
	const current = selected === undefined ? undefined : runs[selected];
	const hint = current
		? [
				theme.fg(
					"dim",
					`  ↑/↓ to select · x to ${isTerminalSubagentStatus(current.record.status) ? "dismiss" : "stop"} · Esc to go back`,
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
	/** Enter on a row; nothing until the run transcript view exists. */
	open?(run: RunEntry): void;
}

/**
 * The panel as a TUI component that can take the keyboard from the prompt: ↑/↓ pick a row, `x` stops or
 * dismisses it, Enter opens it, Esc gives the keyboard back. Any other key goes back to the prompt with it.
 */
export function createPanel(options: {
	tui: TUI;
	theme: Theme;
	runs: () => RunEntry[];
	waitingFor: () => number;
	now: () => number;
	actions: PanelActions;
}) {
	const { tui, theme, actions } = options;
	let selected = 0;
	let returnTo: Component | null = null;
	const rows = () => options.runs().slice(0, MAX_ROWS);
	const release = () => {
		if (panel.focused) tui.setFocus(returnTo);
	};
	const panel: Component &
		Focusable & {
			/** Takes the keyboard on the first row; false when there is no row to take it to. */
			focus(): boolean;
			/** Gives the keyboard back once the panel has no rows left. */
			sync(): void;
		} = {
		focused: false,
		focus() {
			if (rows().length === 0) return false;
			// getFocusedComponent is on pi-tui's TUI class, not its TUI interface.
			returnTo = (tui as { getFocusedComponent?: () => Component | null }).getFocusedComponent?.() ?? null;
			selected = 0;
			tui.setFocus(panel);
			tui.requestRender();
			return true;
		},
		sync() {
			if (panel.focused && rows().length === 0) release();
		},
		handleInput(data) {
			const shown = rows();
			selected = Math.min(selected, shown.length - 1);
			const run = shown[selected];
			if (!run) {
				release();
				returnTo?.handleInput?.(data);
			} else if (matchesKey(data, "up")) selected = Math.max(0, selected - 1);
			else if (matchesKey(data, "down")) selected = Math.min(shown.length - 1, selected + 1);
			else if (matchesKey(data, "escape")) release();
			else if (matchesKey(data, "enter")) actions.open?.(run);
			else if (data === "x") {
				if (isTerminalSubagentStatus(run.record.status)) actions.dismiss(run);
				else if (run.state !== "finishing") actions.stop(run);
				panel.sync();
			} else {
				release();
				returnTo?.handleInput?.(data);
			}
			tui.requestRender();
		},
		render: (width) => {
			const runs = options.runs();
			return renderPanel({
				runs,
				waitingFor: options.waitingFor(),
				now: options.now(),
				width,
				theme,
				selected: panel.focused ? Math.min(selected, MAX_ROWS - 1, runs.length - 1) : undefined,
			});
		},
		invalidate: () => {},
	};
	return panel;
}

function statusColor(status: string) {
	if (status === "completed") return "success";
	if (status === "failed" || status === "interrupted" || status === "cancelled") return "error";
	return "muted";
}
