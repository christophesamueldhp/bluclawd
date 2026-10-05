import { existsSync } from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ManagedDraft, SessionTarget } from "../../daemon/view-types.ts";
import { sharedRef } from "../_shared/global-state.ts";
export type ReplacedSessionContext = Parameters<
	NonNullable<NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>["withSession"]>
>[0];
export interface ManagedUiState {
	phase: "native" | "waiting" | "replacing" | "managed";
	selectedId?: string;
	drafts: Record<string, ManagedDraft>;
	pendingInput: ManagedDraft[];
}
export const managedUiRef = sharedRef<ManagedUiState>("agentViewManagedUi", {
	phase: "native",
	drafts: {},
	pendingInput: [],
});
export async function bootstrapManagedSession(
	ctx: ExtensionCommandContext,
	state: ManagedUiState,
	start: (fresh: ReplacedSessionContext, initial?: SessionTarget) => Promise<void>,
): Promise<{ cancelled: boolean }> {
	state.phase = "waiting";
	if (!ctx.isIdle()) await ctx.waitForIdle();
	if (state.phase !== "waiting") return { cancelled: true };
	const file = ctx.sessionManager.getSessionFile();
	const meaningful = ctx.sessionManager.getEntries().some((entry) => entry.type === "message");
	const initial: SessionTarget | undefined =
		file && existsSync(file) && meaningful
			? {
					sessionFile: file,
					cwd: ctx.sessionManager.getCwd(),
					...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
				}
			: undefined;
	state.phase = "replacing";
	try {
		const result = await ctx.newSession({
			withSession: async (fresh) => {
				state.phase = "managed";
				await start(fresh, initial);
			},
		});
		if (result.cancelled) state.phase = "native";
		return result;
	} catch (error) {
		if (state.phase === "replacing") state.phase = "native";
		throw error;
	}
}
