import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RunAdmission } from "./admission.ts";
import type { createGenerations } from "./generations.ts";
import { inParentScope, type ParentScope } from "./parent-scope.ts";
import type { SubagentRunScheduler } from "./runs.ts";
import { createTranscriptView } from "./transcript-view.ts";
import type { TranscriptSource } from "./transcripts.ts";

export interface TranscriptActionDeps {
	scope: { current(): ParentScope | undefined; context(): ExtensionContext | undefined };
	scheduler: Pick<SubagentRunScheduler, "getRun">;
	transcripts: { source(runId: string): TranscriptSource };
	messageFromUser: ReturnType<typeof createGenerations>["messageFromUser"];
	admission: Pick<RunAdmission, "resume">;
}

/** Opening a run's transcript, where what the user types goes to the run. */
export function createTranscriptActions(deps: TranscriptActionDeps) {
	const { scope: parentScope, scheduler, transcripts, messageFromUser, admission } = deps;

	/**
	 * Opens a run's transcript over the orchestrator's screen and resolves once it closes. Only a run of the
	 * current parent scope opens; any other is refused with a notice and undefined.
	 */
	const openTranscript = (runId: string, owner?: string): Promise<void> | undefined => {
		const ctx = parentScope.context();
		if (ctx?.mode !== "tui") return undefined;
		const scope = parentScope.current();
		const run = scheduler.getRun(runId);
		if (!run) {
			ctx.ui.notify(`No run ${runId} is known to this session, so it cannot be opened.`, "warning");
			return undefined;
		}
		if (!scope || !inParentScope(run, scope) || (owner !== undefined && owner !== run.parentSessionId)) {
			ctx.ui.notify("That run belongs to an earlier session and can no longer be opened.", "warning");
			return undefined;
		}
		return ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) =>
				createTranscriptView({
					tui,
					theme,
					cwd: ctx.cwd,
					title: () => {
						const current = scheduler.getRun(runId) ?? run;
						return `${current.name ?? runId} · ${current.agentName} · ${current.provider}/${current.modelId} · ${current.status}`;
					},
					source: transcripts.source(runId),
					expanded: ctx.ui.getToolsExpanded(),
					send: (text) => messageFromUser(runId, text, admission),
					close: () => done(),
				}),
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } },
		);
	};

	return { openTranscript };
}
