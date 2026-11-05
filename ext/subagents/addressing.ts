import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AdmissionContext, formatRunLabel, type RunAdmission, type RunExecutionContext } from "./admission.ts";
import type { RunDirectory } from "./directory.ts";
import {
	formatMessageReceipt,
	PARENT_MESSAGE_ADDRESS,
	SUBAGENT_MESSAGE_CUSTOM_TYPE,
	type SubagentMessage,
	type SubagentMessageBus,
	type SubagentMessageReceipt,
	subagentMessagePayload,
	USER_MESSAGE_ADDRESS,
} from "./messages.ts";
import { inParentScope, type ParentScope } from "./parent-scope.ts";
import {
	type AdmittedSubagentHandle,
	isTerminalSubagentStatus,
	type SubagentRunRecord,
	type SubagentRunScheduler,
} from "./runs.ts";

export interface RunAddressingDeps {
	scheduler: Pick<
		SubagentRunScheduler<RunExecutionContext>,
		"getRun" | "getContext" | "whenFinal" | "launchResultEmitted"
	>;
	directory: Pick<RunDirectory, "find">;
	bus: Pick<SubagentMessageBus, "send" | "accept">;
	scope: { current(): ParentScope | undefined; context(): ExtensionContext | undefined };
	pi: Pick<ExtensionAPI, "sendMessage">;
	/** Delivers a generation's report once it is final; a resume the user asked for is tagged as theirs. */
	deliver(handle: AdmittedSubagentHandle, resumedByUser: boolean): Promise<unknown>;
}

/** What the user's transcript shows for their message. */
export interface UserMessageOutcome {
	readonly queued: boolean;
	readonly status: string;
}

const EARLIER_SESSION: UserMessageOutcome = {
	queued: false,
	status: "That run belongs to an earlier session and can no longer take messages.",
};

/**
 * Takes a message for a run from the orchestrator or the user, from lookup to outcome: it waits out finishing,
 * reads the run again, and chooses between a Resume and a live message. A run that ended other than completed is
 * refused by admission, with one reason for both senders. The scope checks keep their own meanings: epoch only
 * (`inParentScope`), live context (admission's `inScope`) and active branch (the notice's `runInScope`).
 */
export function createRunAddressing(deps: RunAddressingDeps) {
	const { scheduler, bus } = deps;

	/** Epoch only: whether the orchestrator's current scope is still `scope`. */
	const stillIn = (scope: ParentScope) => {
		const current = deps.scope.current();
		return current !== undefined && inParentScope(scope, current);
	};

	/** Read again once a finishing run is final; finishing ends with the terminal record. */
	const settled = async (run: Readonly<SubagentRunRecord>) => {
		if (run.status !== "finishing") return run;
		await scheduler.whenFinal(run.runId);
		return scheduler.getRun(run.runId) ?? run;
	};

	/**
	 * Admits a final run's next generation with `content` from `from` as its prompt, and delivers its report once
	 * it is final. Admission checks the live context and refuses a run that did not complete.
	 */
	const resume = async (
		run: Readonly<SubagentRunRecord>,
		from: typeof PARENT_MESSAGE_ADDRESS | typeof USER_MESSAGE_ADDRESS,
		toolCallId: string,
		content: string,
		scope: ParentScope,
		admission: Pick<RunAdmission, "resume">,
		ctx: AdmissionContext,
	): Promise<SubagentMessageReceipt> => {
		let receipt: SubagentMessageReceipt | undefined;
		const resumed = await admission.resume(
			run,
			toolCallId,
			() => {
				receipt = bus.accept({ address: from, scope }, run.runId, run.name);
				return subagentMessagePayload({ seq: receipt.seq, from, to: run.runId, toName: run.name, content })
					.content[0].text;
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
		// No tool result carries a user resume to the orchestrator, so its nested usage counts from the start.
		if (from === USER_MESSAGE_ADDRESS) scheduler.launchResultEmitted(run.runId);
		// A run in tmux sends its own Reports; closing it is no news.
		if (scheduler.getContext(run.runId)?.runtime !== "tmux") void deps.deliver(resumed.handle, from === USER_MESSAGE_ADDRESS);
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
		toolCallId: string,
		admission: Pick<RunAdmission, "resume">,
		ctx: AdmissionContext | undefined,
	) => {
		const found = deps.directory.find(scope, to);
		const run = found && (await settled(found.record));
		if (run && isTerminalSubagentStatus(run.status) && ctx) {
			const receipt = await resume(run, PARENT_MESSAGE_ADDRESS, toolCallId, content, scope, admission, ctx);
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
	 * A message the user typed in a run's transcript. It looks the run up by run ID among the runs this instance
	 * knows, in the current scope (epoch only). A running run takes it at its next safe point; a final one resumes,
	 * once a finishing one is final. The orchestrator is then told, but not woken (ADR-0005).
	 */
	const messageFromUser = async (
		runId: string,
		content: string,
		admission: Pick<RunAdmission, "resume">,
	): Promise<UserMessageOutcome> => {
		const scope = deps.scope.current();
		const ctx = deps.scope.context();
		const found = scheduler.getRun(runId);
		if (!found)
			return { queued: false, status: `No run ${runId} is known to this session, so it cannot take messages.` };
		// Epoch only.
		if (!scope || !ctx || !inParentScope(found, scope)) return EARLIER_SESSION;
		const run = await settled(found);
		// Epoch only: the session can change while a finishing run is waited for.
		if (!stillIn(scope)) return EARLIER_SESSION;
		let receipt: SubagentMessageReceipt;
		const resuming = isTerminalSubagentStatus(run.status);
		if (resuming) {
			// No tool call of the orchestrator's carries the user's resume, so the child's tools keep running through
			// the call its earlier generation ran under, whose id still identifies the run for nested-call checks.
			const context = scheduler.getContext(runId);
			const previous = context?.runtime === "tmux" ? undefined : context;
			// Without that context admission refuses the resume, before it reads any tool.
			const toolCtx: AdmissionContext = previous
				? Object.assign(Object.create(ctx) as AdmissionContext, { executeTool: previous.parent.executeTool })
				: ctx;
			const toolCallId = previous?.resume?.toolCallId ?? run.originToolCallId;
			receipt = await resume(run, USER_MESSAGE_ADDRESS, toolCallId, content, scope, admission, toolCtx);
		} else {
			receipt = await bus.send({ address: USER_MESSAGE_ADDRESS, scope }, runId, content);
		}
		if (receipt.status !== "accepted") return { queued: false, status: receipt.reason ?? receipt.status };
		// Epoch only, after the last await: the note belongs to the session the user wrote in.
		if (!stillIn(scope)) return EARLIER_SESSION;
		// The orchestrator still owns the work, so it is told, but not woken: the note is in its next turn's context.
		try {
			deps.pi.sendMessage(
				{
					customType: SUBAGENT_MESSAGE_CUSTOM_TYPE,
					content: [{ type: "text", text: `The user messaged run ${formatRunLabel(run)}: ${content}` }],
					display: true,
					details: {
						seq: receipt.seq,
						from: USER_MESSAGE_ADDRESS,
						to: runId,
						toName: run.name,
						content,
					} satisfies SubagentMessage,
				},
				{ deliverAs: "steer", triggerTurn: false },
			);
		} catch {
			// The session was disposed; nobody is left to tell.
		}
		return {
			queued: true,
			status: resuming
				? `Resuming ${run.name ?? runId} with its earlier context; its report goes to the orchestrator.`
				: `Queued for ${run.name ?? runId}: it reads your message at its next step.`,
		};
	};

	return { messageFromParent, messageFromUser };
}
