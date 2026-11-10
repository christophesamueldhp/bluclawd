import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, matchesKey, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { focusedComponent } from "../_shared/focus.ts";
import { formatTaskDuration } from "../background-bash/bash-limits.ts";
import type { RunEntry } from "./directory.ts";
import { canClose, runStatus } from "./views.ts";

export const SUBAGENT_PANEL_WIDGET = "subagents:panel";
/** How many idle runs keep a row of their own; the rest are counted in one row, as in Claude Code. */
const IDLE_ROWS = 3;
/** The row of the orchestrator's own session, at the top of the panel. */
const MAIN = "main";

/** How long a run has been going, or went on for once it ended. */
export function formatRunElapsed(run: RunEntry["record"], now: number): string {
	return formatTaskDuration(Math.max(0, (run.endedAt ?? now) - (run.startedAt ?? run.admittedAt)));
}

/** The runs with a row of their own: every open one not idle and the first idle ones, then those that ended badly. */
function runRows(runs: readonly RunEntry[], ended: readonly RunEntry[]): { shown: RunEntry[]; idle: number } {
	let idle = 0;
	const shown = runs.filter(({ record }) => runStatus(record) !== "idle" || ++idle <= IDLE_ROWS);
	return { shown: [...shown, ...ended], idle: Math.max(0, idle - IDLE_ROWS) };
}

/**
 * The panel's lines, as Claude Code's agent panel: a row for the orchestrator's own session, `main`, then one per
 * run. Idle runs past the first three are counted in one row. Once no run has a row, a run closed lately leaves
 * a hint to `/tasks` instead.
 */
export function renderPanel(options: {
	runs: readonly RunEntry[];
	/** Runs that failed or were interrupted lately: their rows stay a while. */
	ended?: readonly RunEntry[];
	/** Whether a run was closed lately. */
	closedLately?: boolean;
	/** How many background runs the orchestrator is Waiting for; zero while it is not Waiting. */
	waitingFor: number;
	now: number;
	width: number;
	theme: Theme;
	/** The selectable row the keyboard is on, while the panel has focus: 0 is `main`, then each run's. */
	selected?: number;
}): string[] {
	const { waitingFor, now, width, theme, selected } = options;
	const { shown, idle } = runRows(options.runs, options.ended ?? []);
	if (shown.length === 0) {
		return options.closedLately ? [truncateToWidth(theme.fg("dim", "/tasks to see subagents"), width)] : [];
	}
	const mark = (index: number) => (index === selected ? theme.fg("accent", "❯") : " ");
	const main = [
		`${mark(0)} ${theme.bold(MAIN)}`,
		...(waitingFor > 0
			? [theme.fg("warning", `waiting for ${waitingFor} subagent${waitingFor === 1 ? "" : "s"}`)]
			: []),
	].join("  ");
	const rows = shown.map(({ record: run }, index) => {
		const status = runStatus(run);
		const progress = run.lastProgressText?.replace(/\s+/g, " ").trim();
		return [
			`${mark(index + 1)} ${theme.bold(run.name ?? run.runId)}`,
			run.agentName,
			theme.fg("dim", `${run.provider}/${run.modelId}`),
			theme.fg(statusColor(status), status),
			formatRunElapsed(run, now),
			...(progress ? [theme.fg("dim", progress)] : []),
		].join("  ");
	});
	const collapsed = idle > 0 ? [theme.fg("dim", `  ${idle} idle agent${idle === 1 ? "" : "s"}`)] : [];
	const hint =
		selected === undefined ? [] : [theme.fg("dim", "  ↑/↓ to select · Enter to open · x to close · Esc to go back")];
	return [main, ...rows, ...collapsed, ...hint].map((line) => truncateToWidth(line, width));
}

/** What the keys on a focused panel row do. */
export interface PanelActions {
	/** `x` on an open run. */
	close(run: RunEntry): void;
	/** `x` on a run that ended: its row goes. */
	dismiss?(run: RunEntry): void;
	/** Enter on a run's row. */
	open?(run: RunEntry): void;
}

/**
 * The panel as a TUI component that can take the keyboard from the prompt: ↑/↓ pick a row, `x` closes an open run
 * or dismisses one that ended, Enter opens it, Esc gives the keyboard back, as do Enter and `x` on `main`, which
 * hands the `x` to the prompt. Any other key goes back to the prompt with it.
 * Under pistatusline it renders nothing itself: its `lines` go out as a status, which pistatusline draws below
 * the status line, and `changed` republishes them whenever the selection or the focus moves.
 */
export function createPanel(options: {
	tui: TUI;
	theme: Theme;
	runs: () => RunEntry[];
	/** Runs that failed or were interrupted lately. */
	ended?: () => RunEntry[];
	/** Whether a run was closed lately. */
	closedLately?: () => boolean;
	waitingFor: () => number;
	now: () => number;
	actions: PanelActions;
	/** Whether the panel draws its lines below the prompt itself, as under pi's own footer. */
	belowPrompt: boolean;
	/** Called after the selection or the focus moved. */
	changed: () => void;
}) {
	const { tui, theme, actions } = options;
	// The selection follows its row (a run ID, or `main`); `at` is where it last was, for the nearest row once
	// that run leaves.
	let selectedId: string | undefined;
	let at = 0;
	let returnTo: Component | null = null;
	/** The runs with a row of their own, below `main`. */
	const rows = () => runRows(options.runs(), options.ended?.() ?? []).shown;
	const ids = (shown: readonly RunEntry[]) => [MAIN, ...shown.map(({ record }) => record.runId)];
	/** The selected row's index, `main` being 0, moved to the nearest row when the selected run has left. */
	const selectedIn = (shown: readonly RunEntry[]) => {
		const all = ids(shown);
		const index = selectedId === undefined ? -1 : all.indexOf(selectedId);
		at = index >= 0 ? index : Math.max(0, Math.min(at, all.length - 1));
		selectedId = all[at];
		return at;
	};
	const select = (shown: readonly RunEntry[], index: number) => {
		at = index;
		selectedId = ids(shown)[index];
	};
	const release = () => {
		if (panel.focused) tui.setFocus(returnTo);
	};
	const toPrompt = (data: string) => {
		release();
		returnTo?.handleInput?.(data);
	};
	const panel: Component &
		Focusable & {
			/** Takes the keyboard on the first run's row; false when there is no run to take it to. */
			focus(): boolean;
			/** Gives the keyboard back once the panel has no run left. */
			sync(): void;
			/** What the panel shows, the focused row marked. */
			lines(width: number): string[];
		} = {
		focused: false,
		focus() {
			const shown = rows();
			if (shown.length === 0) return false;
			returnTo = focusedComponent(tui) ?? null;
			select(shown, 1);
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
			const run = shown[selected - 1];
			if (shown.length === 0) toPrompt(data);
			else if (matchesKey(data, "up")) select(shown, Math.max(0, selected - 1));
			else if (matchesKey(data, "down")) select(shown, Math.min(shown.length, selected + 1));
			else if (matchesKey(data, "escape")) release();
			else if (matchesKey(data, "enter")) {
				if (run) actions.open?.(run);
				else release();
			} else if (data === "x") {
				if (!run) toPrompt(data);
				else if (canClose(run)) actions.close(run);
				else actions.dismiss?.(run);
				panel.sync();
			} else toPrompt(data);
			options.changed();
		},
		render: (width) => (options.belowPrompt ? panel.lines(width) : []),
		lines: (width) => {
			const runs = options.runs();
			const ended = options.ended?.() ?? [];
			return renderPanel({
				runs,
				ended,
				closedLately: options.closedLately?.(),
				waitingFor: options.waitingFor(),
				now: options.now(),
				width,
				theme,
				selected: panel.focused ? selectedIn(runRows(runs, ended).shown) : undefined,
			});
		},
		invalidate: () => {},
	};
	return panel;
}

function statusColor(status: string) {
	if (status === "needs input") return "warning";
	return status === "failed" || status === "interrupted" ? "error" : "muted";
}
