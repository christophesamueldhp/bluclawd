/**
 * What a Generation's host does, whichever way it talks to its pi: it checks the session and model pi started with,
 * gives pi its task and the messages posted to the run, notes which of them pi's conversation took, writes what the
 * run sends out, and, once the work is settled, seals the inbox and stores the Report. Its adapters only talk to pi:
 * over pi's RPC (rpc-host.ts) or from inside pi as an extension (pane-child.ts).
 */

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
import type { RunRuntimeOutcome } from "./runs.ts";
import { storeRunReport } from "./storage.ts";

/** How often the inbox is looked at for messages posted to the run. */
const INBOX_CHECK_MS = 50;

/** What a Generation stores of its work, which its adapter saves in its own state. */
export type GenerationRecord = Pick<RpcHostState, "sessionFile" | "sessionId" | "outcome" | "reportSeq" | "idle">;

/** How the protocol talks to the Generation's pi. */
export interface PiLink {
	/**
	 * Gives pi `text`: it steers pi at its next safe point when it works, and starts it when it is idle. Resolves true
	 * once pi accepted it, or with why it refused, when it says.
	 */
	give(text: string): Promise<true | { refused?: string }>;
	/** Whether pi is idle with nothing queued. */
	quiet(): Promise<boolean>;
	/** The models pi can use: those it knows and has authentication for. */
	availableModels(): Promise<{ provider: string; id: string }[]>;
}

/** What pi started with. */
export interface StartedPi {
	sessionFile?: string;
	sessionId?: string;
	model?: { provider?: string; id?: string };
	thinkingLevel?: string;
}

/** What the protocol is told of pi's work, by its adapter. */
export interface GenerationWork {
	/** pi is up: its session and model are checked, then it gets its task, if any, and the inbox is watched. */
	started(pi: StartedPi): Promise<void>;
	/** The last assistant message is the Report's text; a user message is a given message pi took. */
	messageEnded(message: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string }): void;
	/** What the run sends out is read off its own tool's results, which its pi alone produces. */
	toolEnded(event: { toolName?: unknown; isError?: unknown; result?: unknown }): void;
	/** Writes `entry` to the outbox, numbered after what the run sent. */
	send(entry: Omit<RunOutboxMessage, "seq"> | Omit<RunTypedNote, "seq">): void;
	/** pi's work settled: once nothing is pending and nothing landed before the seal, the Report is stored. */
	settled(): Promise<void>;
	/** The run is stopped: it takes no more messages; those posted from now on are refused, not left untaken. */
	stop(): void;
	/** Its work ends now, as pi exited or the user left: the Report with `outcome`, or, with none, that nothing was done. */
	end(outcome?: RunRuntimeOutcome): void;
}

export function startGeneration(options: {
	runDir: string;
	/** An empty prompt is no task: a Resume the user opened in a pane has none until they type. */
	spec: Pick<RpcHostSpec, "generation" | "prompt" | "model" | "sessionFile">;
	link: PiLink;
	save: (record: GenerationRecord) => void;
	/** Called once, its Report stored and saved: pi may be let go. */
	ended: (outcome: RunRuntimeOutcome | undefined) => void;
}): GenerationWork {
	const { runDir, spec, link, save, ended } = options;
	const { generation } = spec;
	const record: GenerationRecord = {};
	let last: { text: string; stopReason?: string; errorMessage?: string } = { text: "" };
	/** Messages from the inbox given to pi, by id, and those of them its conversation does not hold yet. */
	const given = new Set<string>();
	const taken = new Set<string>();
	let waiting: RunInboxMessage[] = [];
	let sent = 0;
	let done = false;
	let stopped = false;
	let watching: ReturnType<typeof setInterval> | undefined;

	// One at a time, so the last look at the inbox and its seal cannot interleave with a message being given.
	let turn = Promise.resolve();
	const serial = (task: () => Promise<void>): Promise<void> => {
		const next = turn.then(task);
		turn = next.catch(() => {});
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

	const end = (outcome?: RunRuntimeOutcome) => {
		if (done) return;
		done = true;
		clearInterval(watching);
		// Whatever it was sent and never took, stopped or failed first, stays in the sealed inbox, and the Report says so.
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

	const outcome = (): RunRuntimeOutcome => {
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
		if (spec.prompt) {
			const prompted = await link.give(spec.prompt);
			if (prompted !== true) return end({ status: "failed", error: prompted.refused ?? "its task was refused" });
		}
		if (done || stopped) return;
		watching = setInterval(() => {
			void serial(() => give(readRunInbox(runDir, generation))).catch(() => {});
		}, INBOX_CHECK_MS);
	};

	const settle = async () => {
		if (done) return;
		await give(readRunInbox(runDir, generation));
		if (done) return;
		// pi goes on by itself with what was queued meanwhile: the work is done once nothing is.
		const quiet = await link.quiet();
		if (done || !quiet || waiting.length > 0) return;
		// What landed before the seal is the run's to take: it goes on with it.
		const late = sealRunInbox(runDir, generation).filter(({ id }) => !given.has(id));
		if (late.length > 0) {
			if (stopped) return;
			unsealRunInbox(runDir, generation);
			await give(late);
			// pi took one on, which its conversation may hold already: its work settles again once done with it.
			if (done || late.some(({ id }) => given.has(id))) return;
			// pi refused them all, so nothing settles again: they stay untaken, and the work is done.
			sealRunInbox(runDir, generation);
		}
		end(outcome());
	};

	return {
		started: (pi) => serial(() => start(pi)).catch(fail),
		messageEnded(message) {
			if (message.role === "assistant") {
				last = {
					text: textOf(message.content),
					stopReason: message.stopReason,
					errorMessage: message.errorMessage,
				};
			}
			// pi queues a message in memory only: it is the run's once its conversation holds it.
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
		settled: () => serial(settle).catch(fail),
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
