/**
 * Process-wide sandbox activation state, shared with the permissions core
 * extension (auto-mode/ask pairing: sandboxed bash needs fewer prompts because
 * the OS caps the blast radius). Kept in a tiny module so permissions never
 * imports the sandbox runtime.
 *
 * Backed by {@link sharedRef} rather than a plain module-level `let`: `sandbox`
 * and `permissions` are separate top-level extensions, each loaded with its own
 * module graph, so a plain `let` here would give permissions its own copy that
 * never saw what sandbox's copy set — confirmed live, `isSandboxActive()` from
 * permissions always read `false`, silently dropping the fewer-prompts pairing.
 */

import { sharedRef } from "../_shared/global-state.ts";

const ref = sharedRef<boolean>("sandbox.active", false);

export function setSandboxActive(active: boolean): void {
	ref.set(active);
}

export function isSandboxActive(): boolean {
	return ref.get();
}
