import type { NewPaneSpec, ResumeSpec, StartSpec } from "./ipc/protocol.ts";

export interface StartClaims {
	start(spec: StartSpec): string | Promise<string>;
	startFailed(id: string): unknown;
}

export async function resumePane(
	claims: StartClaims,
	spec: ResumeSpec,
	spawn: () => string,
): Promise<{ id: string; pane: string }> {
	const id = await claims.start(spec);
	try {
		return { id, pane: spawn() };
	} catch (error) {
		await (async () => claims.startFailed(id))().catch(claimExpiresOnItsOwn);
		throw error;
	}
}

const claimExpiresOnItsOwn = (): void => undefined;

const ignoreRefusalPaneRegistersItself = (): void => undefined;

export function startNewPane(
	claims: StartClaims,
	spec: Omit<NewPaneSpec, "pane">,
	spawn: () => string,
): { pane: string; claimed: Promise<void> } {
	const pane = spawn();
	const claimed = (async () => {
		await claims.start({ ...spec, pane });
	})().catch(ignoreRefusalPaneRegistersItself);
	return { pane, claimed };
}
