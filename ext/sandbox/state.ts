/**
 * Process-wide sandbox activation state, shared with the permissions core
 * extension (auto-mode/ask pairing: sandboxed bash needs fewer prompts because
 * the OS caps the blast radius). Kept in a tiny module so permissions never
 * imports the sandbox runtime.
 */

let sandboxActive = false;

export function setSandboxActive(active: boolean): void {
	sandboxActive = active;
}

export function isSandboxActive(): boolean {
	return sandboxActive;
}
