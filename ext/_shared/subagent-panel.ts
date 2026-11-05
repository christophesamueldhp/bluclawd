/**
 * Whether the subagent panel shows rows: it then takes ↓ from an empty prompt, so the
 * tasks pill does not. Subagents and background-bash load in separate module graphs, so the answer
 * crosses over through sharedRef. Its changes go out with the agent tasks' change signal.
 */

import { sharedRef } from "./global-state.ts";

const state = sharedRef("subagentPanel", { hasRows: undefined as (() => boolean) | undefined }).get();

export function publishSubagentPanel(hasRows: () => boolean): () => void {
	state.hasRows = hasRows;
	return () => {
		if (state.hasRows === hasRows) state.hasRows = undefined;
	};
}

export function subagentPanelHasRows(): boolean {
	return state.hasRows?.() ?? false;
}
