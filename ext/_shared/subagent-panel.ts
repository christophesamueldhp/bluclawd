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
