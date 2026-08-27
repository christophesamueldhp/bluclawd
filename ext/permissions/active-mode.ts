/**
 * Process-wide record of the session's permission mode, shared with the subagent
 * gate (subagent-gate.ts). Same shape and reasoning as sandbox/state.ts.
 *
 * WHY a module and not the store: subagent children are built by the subagents
 * engine with a minimal resource loader and their own ExtensionContext, so there
 * is no context field, no settings key and no event through which a child could
 * learn the parent's mode. Both run in one process, which is exactly this
 * module's scope.
 *
 * The child gate reads it to answer one question — "is the parent refusing
 * everything unlisted?" — because delegation must not be a way around that
 * answer. `acceptEdits` is deliberately NOT inherited by children today; that
 * predates this module and changing it is its own decision.
 */

import type { PermissionMode } from "./modes.ts";

let activeMode: PermissionMode = "default";

export function setActivePermissionMode(mode: PermissionMode): void {
	activeMode = mode;
}

export function getActivePermissionMode(): PermissionMode {
	return activeMode;
}
