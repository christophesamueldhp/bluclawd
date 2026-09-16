/**
 * "A command the model did not run may have changed the working tree." The
 * statusline registers the listener (it owns the git change counts); user `!`
 * commands and bash mode fire it when a command finishes. Tool calls do not need
 * it — the statusline sees their `tool_result` itself. A sharedRef because each
 * top-level extension loads its own module graph (see global-state.ts).
 */
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { sharedRef } from "./global-state.ts";

const listener = sharedRef<(() => void) | undefined>("workingTreeChanged", undefined);

export function onWorkingTreeChanged(callback: (() => void) | undefined): void {
	listener.set(callback);
}

export function workingTreeChanged(): void {
	listener.get()?.();
}

/** `operations`, signalling a working-tree change once each command settles (success or not). */
export function notifyingWhenSettled(operations: BashOperations): BashOperations {
	return {
		exec: async (command, cwd, options) => {
			try {
				return await operations.exec(command, cwd, options);
			} finally {
				workingTreeChanged();
			}
		},
	};
}
