/**
 * Starting a pane, for agent view and the phone alike: the order of the daemon's claim, the spawn
 * and the rollback. The caller passes its own spawner, so agent view keeps its terminal's size and
 * environment and the phone keeps the daemon's.
 */
import type { NewPaneSpec, ResumeSpec, StartSpec } from "./ipc/protocol.ts";

/** The daemon's half of a start (see StartRequest): over IPC, or ServerSupervisor's directly. */
export interface StartClaims {
	/** The row a start is listed as, starting; throws or rejects with why it was refused. */
	start(spec: StartSpec): string | Promise<string>;
	/** The pane a start was claimed for could not be started. */
	startFailed(id: string): unknown;
}

/** A pane on a session file: claimed first, so no other start runs the same session, and given back
 *  if its pane cannot be started. Resolves with the row it is listed as, and its pane. */
export async function resumePane(
	claims: StartClaims,
	spec: ResumeSpec,
	spawn: () => string,
): Promise<{ id: string; pane: string }> {
	const id = await claims.start(spec);
	try {
		return { id, pane: spawn() };
	} catch (error) {
		try {
			await claims.startFailed(id);
		} catch {
			// The claim expires on its own.
		}
		throw error;
	}
}

/** A new session's pane: started first, then listed as starting under its own name, which its row
 *  registers as. The pane is returned at once, without waiting on the daemon; `claimed` settles once
 *  the daemon has answered, and a refusal is let go, as the pane lists itself when it registers. */
export function startNewPane(
	claims: StartClaims,
	spec: Omit<NewPaneSpec, "pane">,
	spawn: () => string,
): { pane: string; claimed: Promise<void> } {
	const pane = spawn();
	// Called before the first await: a claim answered synchronously is made before this returns.
	const claimed = (async () => {
		await claims.start({ ...spec, pane });
	})().catch(() => undefined);
	return { pane, claimed };
}
