import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatRunLabel, type RunAdmission } from "./admission.ts";
import type { RunDirectory } from "./directory.ts";
import type { createGenerations } from "./generations.ts";
import { SUBAGENT_MESSAGE_CUSTOM_TYPE, type SubagentMessage, USER_MESSAGE_ADDRESS } from "./messages.ts";
import { inParentScope, type ParentScope } from "./parent-scope.ts";
import type { SubagentRunScheduler } from "./runs.ts";
import { createTranscriptView } from "./transcript-view.ts";
import type { TranscriptSource } from "./transcripts.ts";

export interface TranscriptActionDeps {
	pi: Pick<ExtensionAPI, "sendMessage">;
	scope: { current(): ParentScope | undefined; context(): ExtensionContext | undefined };
	scheduler: Pick<SubagentRunScheduler, "getRun">;
	directory: Pick<RunDirectory, "get">;
	transcripts: { source(runId: string): TranscriptSource };
	messageFromUser: ReturnType<typeof createGenerations>["messageFromUser"];
	admission: Pick<RunAdmission, "resume">;
}

/** Opening a run's transcript, and sending what the user types there to the run. */
export function createTranscriptActions(deps: TranscriptActionDeps) {
	const { pi, scope: parentScope, scheduler, directory, transcripts, messageFromUser, admission } = deps;

	/** Sends what the user typed in a run's transcript to the run, as the orchestrator's `subagent_message` would. */
	const messageRunAsUser = async (runId: string, text: string) => {
		const scope = parentScope.current();
		const ctx = parentScope.context();
		const run = scheduler.getRun(runId);
		const earlier = {
			queued: false,
			status: "That run belongs to an earlier session and can no longer take messages.",
		};
		if (!run) {
			return { queued: false, status: `No run ${runId} is known to this session, so it cannot take messages.` };
		}
		if (!scope || !ctx || !inParentScope(run, scope)) return earlier;
		const receipt = await messageFromUser(scope, runId, text, admission, ctx);
		if (receipt.status !== "accepted") return { queued: false, status: receipt.reason ?? receipt.status };
		// The session can change while a finishing run is waited for; the note belongs to the one the user wrote in.
		const after = parentScope.current();
		if (!after || !inParentScope(scope, after)) return earlier;
		// The orchestrator still owns the work, so it is told, but not woken: the note is in its next turn's context.
		try {
			pi.sendMessage(
				{
					customType: SUBAGENT_MESSAGE_CUSTOM_TYPE,
					content: [{ type: "text", text: `The user messaged run ${formatRunLabel(run)}: ${text}` }],
					display: true,
					details: {
						seq: receipt.seq,
						from: USER_MESSAGE_ADDRESS,
						to: runId,
						toName: run.name,
						content: text,
					} satisfies SubagentMessage,
				},
				{ deliverAs: "steer", triggerTurn: false },
			);
		} catch {
			// The session was disposed; nobody is left to tell.
		}
		return {
			queued: true,
			status: receipt.resumed
				? `Resuming ${run.name ?? runId} with its earlier context; its report goes to the orchestrator.`
				: `Queued for ${run.name ?? runId}: it reads your message at its next step.`,
		};
	};

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
						const state = directory.get(runId)?.state === "finishing" ? "finishing" : current.status;
						return `${current.name ?? runId} · ${current.agentName} · ${current.provider}/${current.modelId} · ${state}`;
					},
					source: transcripts.source(runId),
					expanded: ctx.ui.getToolsExpanded(),
					send: (text) => messageRunAsUser(runId, text),
					close: () => done(),
				}),
			{ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } },
		);
	};

	return { openTranscript };
}
