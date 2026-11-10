import { type AdmissionContext, formatRunLabel, type ResumeChanges, type RunAdmission } from "./admission.ts";
import type { RunDirectory } from "./directory.ts";
import {
	formatMessageReceipt,
	PARENT_MESSAGE_ADDRESS,
	type SubagentMessageBus,
	type SubagentMessageReceipt,
} from "./messages.ts";
import type { ParentScope } from "./parent-scope.ts";
import { isTerminalSubagentStatus, type SubagentRunRecord } from "./runs.ts";

export interface RunAddressingDeps {
	directory: Pick<RunDirectory, "find">;
	bus: Pick<SubagentMessageBus, "send" | "accept">;
}

/**
 * Takes the orchestrator's message for a run, from lookup to outcome: a final run resumes with it, any other
 * gets it through the bus. A run that ended other than closed is refused by admission.
 */
export function createRunAddressing(deps: RunAddressingDeps) {
	const { bus } = deps;

	/** Admits a final run's next generation with `content` as its prompt; its Reports wake the orchestrator. */
	const resume = async (
		run: Readonly<SubagentRunRecord>,
		content: string,
		scope: ParentScope,
		admission: Pick<RunAdmission, "resume">,
		ctx: AdmissionContext,
	): Promise<SubagentMessageReceipt> => {
		let receipt: SubagentMessageReceipt | undefined;
		const resumed = await admission.resume(
			run,
			() => {
				receipt = bus.accept({ address: PARENT_MESSAGE_ADDRESS, scope }, run.runId, run.name);
				// The run frames it as from its orchestrator.
				return content;
			},
			ctx,
		);
		if (!resumed.ok) {
			return {
				status: resumed.refusal ?? "unavailable",
				seq: 0,
				to: run.runId,
				toName: run.name,
				reason: resumed.error,
			};
		}
		// A resume is admitted only after buildPrompt ran, so the receipt is set.
		return receipt!;
	};

	/**
	 * A message from the orchestrator's `subagent_message`. It looks the run up by name or run ID: among the
	 * scope's open runs (epoch only), the session's finished runs, then disk. A final run resumes; any other goes
	 * through the bus, which refuses a stale epoch.
	 */
	const messageFromParent = async (
		scope: ParentScope,
		to: string,
		content: string,
		admission: Pick<RunAdmission, "resume">,
		ctx: AdmissionContext | undefined,
	) => {
		const run = deps.directory.find(scope, to)?.record;
		// A message to a run on pi's RPC is information only: the bus refuses a final one, which only a Resume continues.
		if (run && isTerminalSubagentStatus(run.status) && run.backend !== "rpc" && ctx) {
			const receipt = await resume(run, content, scope, admission, ctx);
			if (receipt.status !== "accepted") return formatMessageReceipt(receipt);
			return {
				...formatMessageReceipt(receipt),
				content: [
					{
						type: "text" as const,
						text: `Message ${receipt.seq} accepted: resuming ${formatRunLabel(run)} in the background with its earlier context. Its report will be delivered when it finishes.`,
					},
				],
			};
		}
		return formatMessageReceipt(await bus.send({ address: PARENT_MESSAGE_ADDRESS, scope }, to, content));
	};

	/**
	 * The orchestrator's explicit Resume of a final run, by name or run ID, with its next instruction and any change of
	 * model or level; admission decides whether it may continue.
	 */
	const resumeFromParent = async (
		scope: ParentScope,
		to: string,
		instruction: string,
		changes: ResumeChanges,
		admission: Pick<RunAdmission, "resume">,
		ctx: AdmissionContext,
	) => {
		const run = deps.directory.find(scope, to)?.record;
		const refused = (text: string) => ({
			content: [{ type: "text" as const, text }],
			details: undefined,
			isError: true,
		});
		if (!run) return refused(`No subagent "${to}" of this session to resume.`);
		if (!isTerminalSubagentStatus(run.status)) {
			return refused(`${formatRunLabel(run)} is still ${run.status}: message it instead.`);
		}
		const resumed = await admission.resume(run, () => instruction, ctx, changes);
		if (!resumed.ok) return refused(resumed.error);
		const { record } = resumed.handle;
		return {
			content: [
				{
					type: "text" as const,
					text: `Resuming ${formatRunLabel(run)} in the background with its earlier context, as its generation ${record.generation} on ${record.provider}/${record.modelId} at thinking ${record.thinkingLevel}. Its report will be delivered when it finishes.`,
				},
			],
			details: undefined,
		};
	};

	return { messageFromParent, resumeFromParent };
}
