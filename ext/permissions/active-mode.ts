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
 * answer. `edits` is deliberately NOT inherited by children today; that
 * predates this module and changing it is its own decision.
 *
 * Backed by {@link sharedRef}, not a plain module-level `let`: `subagent-gate.ts`
 * is loaded twice — once inside `permissions`'s own module graph, once inside
 * `subagents`'s (via `engine.ts`'s import) — each a separate instance under pi's
 * loader (`moduleCache: false`). A plain `let` would leave the subagents-side
 * copy always reading the initial "ask", never the mode `permissions/index.ts`
 * actually sets — so a child under `never` would silently fall back to the
 * permissive deny-only posture instead of the restrictive allow-list this module
 * exists to enforce, reopening exactly the delegation hole described above.
 */

import { sharedRef } from "../_shared/global-state.ts";
import { type PermissionMode, SAFEST_MODE } from "./modes.ts";

const ref = sharedRef<PermissionMode>("permissions.activeMode", SAFEST_MODE);

export function setActivePermissionMode(mode: PermissionMode): void {
	ref.set(mode);
}

export function getActivePermissionMode(): PermissionMode {
	return ref.get();
}
