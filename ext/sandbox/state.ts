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

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { sharedRef } from "../_shared/global-state.ts";

const ref = sharedRef<boolean>("sandbox.active", false);

export function setSandboxActive(active: boolean): void {
	ref.set(active);
}

export function isSandboxActive(): boolean {
	return ref.get();
}

/**
 * What a subagent child needs to run bash the way the parent does. Children load
 * no extensions (subagents/engine.ts, Trap 2), so the sandbox extension is not
 * there to replace their bash tool; the parent publishes its operations here and
 * `child-bash.ts` builds the child's tool on top of them. Operations, not a tool:
 * a child has its own cwd (a worktree, say), and the tool is bound to one.
 */
export interface ChildBashProvider {
	/** The operations this command runs through: the sandbox unless something takes it out. */
	operations(command: string, disableSandbox?: boolean): BashOperations;
	/** The strict-mode refusal, when the sandbox was wanted but is not running. */
	refusal(): string | undefined;
	shellPath?: string;
	commandPrefix?: string;
}

const provider = sharedRef<ChildBashProvider | undefined>("sandbox.childBash", undefined);

export function publishChildBash(value: ChildBashProvider | undefined): void {
	provider.set(value);
}

export function childBashProvider(): ChildBashProvider | undefined {
	return provider.get();
}

/**
 * What the permission layer needs to know about the sandbox: whether a bash
 * command will actually run inside it (auto-allow applies), and whether the
 * model's unsandboxed retry is honoured (so the user is asked about it).
 */
export interface SandboxPosture {
	active: boolean;
	autoAllowBashIfSandboxed: boolean;
	allowUnsandboxedCommands: boolean;
	isExcluded(command: string): boolean;
}

const posture = sharedRef<SandboxPosture | undefined>("sandbox.posture", undefined);

export function publishSandboxPosture(value: SandboxPosture | undefined): void {
	posture.set(value);
}

export function sandboxPosture(): SandboxPosture | undefined {
	return posture.get();
}
