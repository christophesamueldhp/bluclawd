import { realpathSync } from "node:fs";
import { SUBAGENT_MESSAGE_TOOL } from "./messages.ts";
import { textOf } from "./results.ts";
import type { RpcHostSpec, RpcHostState } from "./rpc-host.ts";
import {
	markGiven,
	type RunInboxMessage,
	type RunOutboxMessage,
	type RunTypedNote,
	readRunInbox,
	sealRunInbox,
	unsealRunInbox,
	writeRunOutbox,
} from "./run-mailbox.ts";
import type { PiSettlement } from "./runs.ts";
import { storeRunReport } from "./storage.ts";

const INBOX_CHECK_MS = 50;

export const TASK_TYPED_IN_PANE = "";
export const promptsFirst = (spec: Pick<RpcHostSpec, "prompt">): boolean => spec.prompt !== TASK_TYPED_IN_PANE;

export type GenerationRecord = Pick<RpcHostState, "sessionFile" | "sessionId" | "outcome" | "reportSeq" | "idle">;

export interface PiLink {
	give(text: string): Promise<true | { refused?: string }>;
	quiet(): Promise<boolean>;
	availableModels(): Promise<{ provider: string; id: string }[]>;
}

export interface StartedPi {
	sessionFile?: string;
	sessionId?: string;
	model?: { provider?: string; id?: string };
	thinkingLevel?: string;
}

export interface GenerationWork {
	started(pi: StartedPi): Promise<void>;
	messageEnded(message: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string }): void;
	toolEnded(event: { toolName?: unknown; isError?: unknown; result?: unknown }): void;
	send(entry: Omit<RunOutboxMessage, "seq"> | Omit<RunTypedNote, "seq">): void;
	settled(): Promise<void>;
	stop(): void;
	end(outcome?: PiSettlement): void;
}

export function startGeneration(options: {
	runDir: string;
	spec: Pick<RpcHostSpec, "generation" | "prompt" | "model" | "sessionFile">;
	link: PiLink;
	save: (record: GenerationRecord) => void;
	ended: (outcome: PiSettlement | undefined) => void;
}): GenerationWork {
	const { runDir, spec, link, save, ended } = options;
	const { generation } = spec;
	const record: GenerationRecord = {};
	let last: { text: string; stopReason?: string; errorMessage?: string } = { text: "" };
	const given = new Set<string>();
	const taken = new Set<string>();
	let waiting: RunInboxMessage[] = [];
	let sent = 0;
	let done = false;
	let stopped = false;
	let watching: ReturnType<typeof setInterval> | undefined;

	let inboxTurn = Promise.resolve();
	const oneInboxStepAtATime = (task: () => Promise<void>): Promise<void> => {
		const next = inboxTurn.then(task);
		inboxTurn = next.catch(() => {});
		return next;
	};

	const give = async (messages: RunInboxMessage[]) => {
		for (const message of messages) {
			if (done || given.has(message.id)) continue;
			given.add(message.id);
			waiting.push(message);
			if ((await link.give(message.text)) !== true) {
				given.delete(message.id);
				waiting = waiting.filter((held) => held !== message);
			} else markGiven(runDir, generation, message.id);
		}
	};

	const end = (outcome?: PiSettlement) => {
		if (done) return;
		done = true;
		clearInterval(watching);
		const untaken = sealRunInbox(runDir, generation).filter(({ id }) => !taken.has(id)).length;
		if (outcome) {
			record.outcome = outcome;
			record.reportSeq = storeRunReport(runDir, {
				text: last.text,
				outcome,
				sessionId: record.sessionId,
				generation,
				...(untaken ? { untaken } : {}),
			});
		} else record.idle = true;
		save(record);
		ended(outcome);
	};
	const fail = (error: unknown) =>
		end({ status: "failed", error: error instanceof Error ? error.message : String(error) });

	const outcome = (): PiSettlement => {
		if (last.stopReason === "error") return { status: "failed", error: last.errorMessage ?? "its model failed" };
		if (last.stopReason === "aborted") return { status: "stopped", error: "its work was stopped" };
		return { status: "completed" };
	};

	const start = async (pi: StartedPi) => {
		if (done) return;
		record.sessionFile = pi.sessionFile;
		record.sessionId = pi.sessionId;
		save(record);
		// pi starts a new session at a path that holds none, without a word.
		if (spec.sessionFile && !sameFile(pi.sessionFile, spec.sessionFile)) {
			return end({
				status: "failed",
				error: `its pi opened ${pi.sessionFile ?? "no session"}, not the run's session ${spec.sessionFile}`,
			});
		}
		// pi lowers a level its model lacks, and takes an id its provider lacks for a custom one, warning only.
		const { provider, id } = pi.model ?? {};
		const admitted = spec.model;
		if (provider !== admitted.provider || id !== admitted.id || pi.thinkingLevel !== admitted.thinkingLevel) {
			return end({
				status: "failed",
				error: `its pi runs ${provider ?? "no model"}/${id ?? ""} at thinking ${pi.thinkingLevel}, not ${admitted.provider}/${admitted.id} at thinking ${admitted.thinkingLevel}`,
			});
		}
		const models = await link.availableModels();
		if (!models.some((model) => model.provider === admitted.provider && model.id === admitted.id)) {
			return end({
				status: "failed",
				error: `its pi cannot use ${admitted.provider}/${admitted.id}: the model is unknown to it, or it has no authentication for it`,
			});
		}
		if (promptsFirst(spec)) {
			const prompted = await link.give(spec.prompt);
			if (prompted !== true) return end({ status: "failed", error: prompted.refused ?? "its task was refused" });
		}
		if (done || stopped) return;
		watching = setInterval(() => {
			void oneInboxStepAtATime(() => give(readRunInbox(runDir, generation))).catch(() => {});
		}, INBOX_CHECK_MS);
	};

	const settle = async () => {
		if (done) return;
		await give(readRunInbox(runDir, generation));
		if (done) return;
		// pi goes on by itself with what was queued meanwhile, so the work is done once nothing is.
		const quiet = await link.quiet();
		if (done || !quiet || waiting.length > 0) return;
		const late = sealRunInbox(runDir, generation).filter(({ id }) => !given.has(id));
		if (late.length > 0) {
			if (stopped) return;
			if ((await giveLateMessages(late)) === "took") return;
		}
		end(outcome());
	};

	const giveLateMessages = async (late: RunInboxMessage[]): Promise<"took" | "refusedAll"> => {
		unsealRunInbox(runDir, generation);
		await give(late);
		if (done || late.some(({ id }) => given.has(id))) return "took";
		sealRunInbox(runDir, generation);
		return "refusedAll";
	};

	return {
		started: (pi) => oneInboxStepAtATime(() => start(pi)).catch(fail),
		messageEnded(message) {
			if (message.role === "assistant") {
				last = {
					text: textOf(message.content),
					stopReason: message.stopReason,
					errorMessage: message.errorMessage,
				};
			}
			// pi queues a message in memory only, so it is the run's once its conversation holds it.
			const text = message.role === "user" ? textOf(message.content) : undefined;
			const at = waiting.findIndex((held) => held.text === text);
			if (at >= 0) {
				taken.add(waiting[at].id);
				waiting = waiting.filter((_, index) => index !== at);
			}
		},
		toolEnded(event) {
			if (event.toolName !== SUBAGENT_MESSAGE_TOOL || event.isError) return;
			const details = (event.result as { details?: Omit<RunOutboxMessage, "seq"> } | undefined)?.details;
			if (details) writeRunOutbox(runDir, generation, { ...details, seq: ++sent });
		},
		send(entry) {
			writeRunOutbox(runDir, generation, { ...entry, seq: ++sent } as RunOutboxMessage | RunTypedNote);
		},
		settled: () => oneInboxStepAtATime(settle).catch(fail),
		stop() {
			stopped = true;
			clearInterval(watching);
			sealRunInbox(runDir, generation);
		},
		end,
	};
}

function sameFile(path: string | undefined, expected: string): boolean {
	if (!path) return false;
	try {
		return realpathSync(path) === realpathSync(expected);
	} catch {
		return false;
	}
}
