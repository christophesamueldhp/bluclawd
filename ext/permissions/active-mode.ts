/**
 * Process-wide record of the session's permission mode, published by
 * `permissions/index.ts` and read by `diagnostics` for `/status`.
 *
 * Backed by {@link sharedRef}, not a plain module-level `let`: `diagnostics` is its
 * own `pi.extensions` entry, so pi's loader (`moduleCache: false`) gives it a separate
 * copy of this module. A plain `let` would leave that copy always reading the initial
 * "ask", never the mode the permissions extension actually set. Same shape and
 * reasoning as sandbox/state.ts.
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
