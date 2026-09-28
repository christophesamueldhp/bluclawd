/**
 * Process-wide record of the session's permission mode, published by
 * `permissions/index.ts` and read by `diagnostics` for `/status`.
 *
 * Backed by {@link sharedRef}, not a module-level `let`: each `pi.extensions` entry
 * gets its own copy of this module, so a plain `let` would never see the mode the
 * permissions extension set.
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
