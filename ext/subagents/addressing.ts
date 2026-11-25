import type { AdmissionContext, ResumeChanges, RunAdmission } from "./admission.ts";
import type { RunDirectory } from "./directory.ts";
import { formatMessageReceipt, PARENT_MESSAGE_ADDRESS, type SubagentMessageBus } from "./messages.ts";
import type { ParentScope } from "./parent-scope.ts";
import { formatRunLabel, isLegacyRun, isTerminalSubagentStatus } from "./runs.ts";
import { resumedInBackground } from "./settling.ts";
import { legacyRunRefusal } from "./tmux-runs.ts";

export interface RunAddressingDeps {
	directory: Pick<RunDirectory, "find">;
	bus: Pick<SubagentMessageBus, "send">;
}

export function createRunAddressing(deps: RunAddressingDeps) {
	const { bus } = deps;

	const messageFromParent = async (scope: ParentScope, to: string, content: string) => {
		const run = deps.directory.find(scope, to)?.record;
		const finished = run !== undefined && isTerminalSubagentStatus(run.status);
		if (finished && isLegacyRun(run)) {
			return formatMessageReceipt({
				status: "unavailable",
				seq: 0,
				to: run.runId,
				toName: run.name,
				reason: legacyRunRefusal(run),
			});
		}
		const receipt = await bus.send({ address: PARENT_MESSAGE_ADDRESS, scope }, to, content);
		return formatMessageReceipt(
			finished && receipt.status === "unavailable"
				? { ...receipt, reason: `${receipt.reason} Only subagent_resume continues it, with your next instruction.` }
				: receipt,
		);
	};

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
		const resumed = await admission.resume(run, { from: "orchestrator", text: () => instruction }, ctx, changes);
		if (!resumed.ok) return refused(resumed.error);
		const { record } = resumed.handle;
		return {
			content: [
				{
					type: "text" as const,
					text: resumedInBackground(run, record),
				},
			],
			details: undefined,
		};
	};

	return { messageFromParent, resumeFromParent };
}
